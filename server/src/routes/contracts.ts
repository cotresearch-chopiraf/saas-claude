import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { contracts, projects } from "../db/schema.js";
import { requirePermission } from "../lib/permissions.js";
import { recordAuditEvent } from "../lib/audit.js";
import { logger } from "../lib/logger.js";

type ProjectParams = { projectId: string };
type ContractParams = ProjectParams & { contractId: string };

export const contractsRouter = Router({ mergeParams: true });

// Same tenant/ownership-scoping pattern as every other project sub-resource
// (budget.ts, tasks.ts, changeOrders.ts, dailyLogs.ts): verify the project
// belongs to the caller's company before any route below runs.
contractsRouter.use(async (req: Request<ProjectParams>, res: Response, next: NextFunction) => {
  const project = await db.query.projects.findFirst({
    where: and(eq(projects.id, req.params.projectId), eq(projects.companyId, req.companyId!)),
  });
  if (!project) return res.status(404).json({ error: "المشروع غير موجود" });
  next();
});

contractsRouter.get("/", async (req: Request<ProjectParams>, res: Response) => {
  const rows = await db.query.contracts.findMany({
    where: eq(contracts.projectId, req.params.projectId),
    orderBy: (c, { desc }) => [desc(c.createdAt)],
  });
  res.json(rows);
});

const createSchema = z.object({
  contractType: z.enum(["main", "amendment"]).default("main"),
  // Required for an amendment, validated against this same project below.
  // Phase 1 scope: an amendment is a recorded revision event with its own
  // original/revised value pair — it does NOT automatically roll up into
  // the main contract's own revisedValue (that reconciliation is
  // deliberately deferred, not silently assumed).
  parentContractId: z.string().uuid().optional(),
  contractNumber: z.string().optional(),
  clientName: z.string().optional(),
  originalValue: z.coerce.number().nonnegative(),
  revisedValue: z.coerce.number().nonnegative().optional(),
  currency: z.string().min(1).default("SAR"),
  advancePercent: z.coerce.number().min(0).max(100).optional(),
  retentionPercent: z.coerce.number().min(0).max(100).optional(),
  paymentTerms: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

contractsRouter.post(
  "/",
  requirePermission("contract.manage"),
  async (req: Request<ProjectParams>, res: Response) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

    if (parsed.data.contractType === "amendment") {
      if (!parsed.data.parentContractId) {
        return res.status(400).json({ error: "تعديل العقد يتطلب تحديد العقد الرئيسي" });
      }
      const parent = await db.query.contracts.findFirst({
        where: and(
          eq(contracts.id, parsed.data.parentContractId),
          eq(contracts.projectId, req.params.projectId),
        ),
      });
      if (!parent) return res.status(404).json({ error: "العقد الرئيسي غير موجود" });
    }

    const contract = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(contracts)
        .values({
          companyId: req.companyId!,
          projectId: req.params.projectId,
          contractType: parsed.data.contractType,
          parentContractId: parsed.data.parentContractId,
          contractNumber: parsed.data.contractNumber,
          clientName: parsed.data.clientName,
          originalValue: String(parsed.data.originalValue),
          revisedValue: String(parsed.data.revisedValue ?? parsed.data.originalValue),
          currency: parsed.data.currency,
          advancePercent:
            parsed.data.advancePercent !== undefined ? String(parsed.data.advancePercent) : undefined,
          retentionPercent:
            parsed.data.retentionPercent !== undefined ? String(parsed.data.retentionPercent) : undefined,
          paymentTerms: parsed.data.paymentTerms,
          startDate: parsed.data.startDate,
          endDate: parsed.data.endDate,
          createdBy: req.userId!,
        })
        .returning();

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "contract.created",
        entityType: "contract",
        entityId: created.id,
        afterValue: created,
      });

      return created;
    });

    logger.info("financial_mutation", {
      action: "contract.created",
      userId: req.userId,
      companyId: req.companyId,
      contractId: contract.id,
      contractType: contract.contractType,
    });
    res.status(201).json(contract);
  },
);

async function findOwnedContract(companyId: string, projectId: string, contractId: string) {
  return db.query.contracts.findFirst({
    where: and(
      eq(contracts.id, contractId),
      eq(contracts.projectId, projectId),
      eq(contracts.companyId, companyId),
    ),
  });
}

contractsRouter.get("/:contractId", async (req: Request<ContractParams>, res: Response) => {
  const contract = await findOwnedContract(req.companyId!, req.params.projectId, req.params.contractId);
  if (!contract) return res.status(404).json({ error: "العقد غير موجود" });
  res.json(contract);
});

const updateSchema = z.object({
  contractNumber: z.string().optional(),
  clientName: z.string().optional(),
  revisedValue: z.coerce.number().nonnegative().optional(),
  advancePercent: z.coerce.number().min(0).max(100).optional(),
  retentionPercent: z.coerce.number().min(0).max(100).optional(),
  paymentTerms: z.string().optional(),
  status: z.enum(["draft", "active", "completed", "terminated"]).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

// Every change is audited — this is a financial-instrument record, not a
// free-form note; the before/after snapshot is what makes a later "why did
// the contract value change" question answerable.
contractsRouter.patch(
  "/:contractId",
  requirePermission("contract.manage"),
  async (req: Request<ContractParams>, res: Response) => {
    const existing = await findOwnedContract(req.companyId!, req.params.projectId, req.params.contractId);
    if (!existing) return res.status(404).json({ error: "العقد غير موجود" });

    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

    const { revisedValue, advancePercent, retentionPercent, ...rest } = parsed.data;

    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(contracts)
        .set({
          ...rest,
          ...(revisedValue !== undefined ? { revisedValue: String(revisedValue) } : {}),
          ...(advancePercent !== undefined ? { advancePercent: String(advancePercent) } : {}),
          ...(retentionPercent !== undefined ? { retentionPercent: String(retentionPercent) } : {}),
          updatedAt: new Date(),
        })
        .where(eq(contracts.id, existing.id))
        .returning();

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "contract.updated",
        entityType: "contract",
        entityId: existing.id,
        beforeValue: existing,
        afterValue: row,
      });

      return row;
    });

    logger.info("financial_mutation", {
      action: "contract.updated",
      userId: req.userId,
      companyId: req.companyId,
      contractId: existing.id,
    });
    res.json(updated);
  },
);
