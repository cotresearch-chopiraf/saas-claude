import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { and, eq, isNull, or } from "drizzle-orm";
import { db } from "../db/client.js";
import { costCodes, projects } from "../db/schema.js";
import { requirePermission } from "../lib/permissions.js";
import { recordAuditEvent } from "../lib/audit.js";

export const costCodesRouter = Router();

// GET /cost-codes — company-wide canonical codes; pass ?projectId=<id> to
// also include that project's own extensions in the same list (what a
// budget item or BOQ item in that project can actually be tagged with).
// projectId is never trusted blindly — it's validated to belong to this
// company before being used to filter.
costCodesRouter.get("/", async (req: Request, res: Response) => {
  const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;

  if (projectId) {
    const project = await db.query.projects.findFirst({
      where: and(eq(projects.id, projectId), eq(projects.companyId, req.companyId!)),
    });
    if (!project) return res.status(404).json({ error: "المشروع غير موجود" });
  }

  const rows = await db.query.costCodes.findMany({
    where: and(
      eq(costCodes.companyId, req.companyId!),
      projectId ? or(isNull(costCodes.projectId), eq(costCodes.projectId, projectId)) : isNull(costCodes.projectId),
    ),
    orderBy: (c, { asc }) => [asc(c.code)],
  });
  res.json(rows);
});

const createSchema = z.object({
  code: z.string().min(1, "الرمز مطلوب"),
  name: z.string().min(2, "الاسم قصير جداً"),
  category: z
    .enum(["labor", "materials", "equipment", "subcontract", "site_overhead", "general_overhead", "other"])
    .optional(),
  parentCostCodeId: z.string().uuid().optional(),
  // Omitted -> a company-wide canonical code. Provided -> a project-specific
  // extension, validated to belong to this company (never trusted as-is).
  projectId: z.string().uuid().optional(),
});

costCodesRouter.post(
  "/",
  requirePermission("costCode.manage"),
  async (req: Request, res: Response) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

    if (parsed.data.projectId) {
      const project = await db.query.projects.findFirst({
        where: and(eq(projects.id, parsed.data.projectId), eq(projects.companyId, req.companyId!)),
      });
      if (!project) return res.status(404).json({ error: "المشروع غير موجود" });
    }

    if (parsed.data.parentCostCodeId) {
      const parent = await db.query.costCodes.findFirst({
        where: and(eq(costCodes.id, parsed.data.parentCostCodeId), eq(costCodes.companyId, req.companyId!)),
      });
      if (!parent) return res.status(404).json({ error: "بند التكلفة الأصل غير موجود" });
    }

    const costCode = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(costCodes)
        .values({
          companyId: req.companyId!,
          projectId: parsed.data.projectId,
          code: parsed.data.code,
          name: parsed.data.name,
          category: parsed.data.category,
          parentCostCodeId: parsed.data.parentCostCodeId,
        })
        .returning();

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "costCode.created",
        entityType: "cost_code",
        entityId: created.id,
        afterValue: created,
      });

      return created;
    });

    res.status(201).json(costCode);
  },
);

const updateSchema = z.object({
  code: z.string().min(1).optional(),
  name: z.string().min(2).optional(),
  category: z
    .enum(["labor", "materials", "equipment", "subcontract", "site_overhead", "general_overhead", "other"])
    .optional(),
});

costCodesRouter.patch(
  "/:id",
  requirePermission("costCode.manage"),
  async (req: Request<{ id: string }>, res: Response) => {
    const existing = await db.query.costCodes.findFirst({
      where: and(eq(costCodes.id, req.params.id), eq(costCodes.companyId, req.companyId!)),
    });
    if (!existing) return res.status(404).json({ error: "بند التكلفة غير موجود" });

    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(costCodes)
        .set(parsed.data)
        .where(eq(costCodes.id, existing.id))
        .returning();

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "costCode.updated",
        entityType: "cost_code",
        entityId: existing.id,
        beforeValue: existing,
        afterValue: row,
      });

      return row;
    });

    res.json(updated);
  },
);
