import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  boqItems,
  boqRevisions,
  commitmentLines,
  commitments,
  contracts,
  costCodes,
  projects,
  suppliers,
} from "../db/schema.js";
import { requirePermission } from "../lib/permissions.js";
import { recordAuditEvent } from "../lib/audit.js";
import { roundMoney, sumMoney } from "../lib/money.js";
import { CONTRACT_EXECUTION_BLOCKED_STATUSES } from "./contracts.js";

type ProjectParams = { projectId: string };
type CommitmentParams = ProjectParams & { commitmentId: string };
type LineParams = CommitmentParams & { lineId: string };

export const commitmentsRouter = Router({ mergeParams: true });

// Same tenant/ownership-scoping pattern as every other project sub-resource
// (contracts.ts, boq.ts, budgetRevisions.ts): verify the project belongs
// to the caller's company before any route below runs.
commitmentsRouter.use(async (req: Request<ProjectParams>, res: Response, next: NextFunction) => {
  const project = await db.query.projects.findFirst({
    where: and(eq(projects.id, req.params.projectId), eq(projects.companyId, req.companyId!)),
  });
  if (!project) return res.status(404).json({ error: "المشروع غير موجود" });
  next();
});

commitmentsRouter.get("/", async (req: Request<ProjectParams>, res: Response) => {
  const rows = await db.query.commitments.findMany({
    where: eq(commitments.projectId, req.params.projectId),
    orderBy: (c, { desc }) => [desc(c.createdAt)],
  });
  res.json(rows);
});

const createSchema = z.object({
  supplierId: z.string().uuid(),
  type: z.enum(["purchase_order", "subcontract"]),
  contractId: z.string().uuid().optional(),
  description: z.string().optional(),
  currency: z.string().min(1).optional(),
});

// commitmentNumber is claimed via an INSERT ... SELECT MAX+1 subquery,
// inside a transaction that locks the parent company row FOR UPDATE first
// (see docs/MIDAD_CONCURRENCY_HARDENING.md) — scoped per company (not per
// project), matching how invoice/quote numbers are company-wide
// sequences. Two concurrent "create a commitment" requests for this
// company can never be handed the same number.
commitmentsRouter.post(
  "/",
  requirePermission("commitment.manage"),
  async (req: Request<ProjectParams>, res: Response) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

    // Neither reference is trusted as-is: a supplier must belong to this
    // company, and a contract (if given) must belong to this project —
    // never assumed safe merely because the ID exists.
    const supplier = await db.query.suppliers.findFirst({
      where: and(eq(suppliers.id, parsed.data.supplierId), eq(suppliers.companyId, req.companyId!)),
    });
    if (!supplier) return res.status(404).json({ error: "المورد غير موجود" });

    if (parsed.data.contractId) {
      const contract = await db.query.contracts.findFirst({
        where: and(eq(contracts.id, parsed.data.contractId), eq(contracts.projectId, req.params.projectId)),
      });
      if (!contract) return res.status(404).json({ error: "العقد غير موجود" });
      // Phase 3.2 remediation (CTR-001) — a contract that is completed or
      // terminated must not accept new execution activity.
      if (CONTRACT_EXECUTION_BLOCKED_STATUSES.includes(contract.status)) {
        return res.status(409).json({ error: "لا يمكن إنشاء التزام مرتبط بعقد منتهٍ أو ملغى" });
      }
    }

    // The MAX+1 subquery alone is not race-safe: two concurrent INSERTs can
    // each read the same prior MAX before either commits. Locking the
    // parent company row (req.companyId is always the caller's own
    // authenticated company, never an untrusted input) for the duration of
    // the transaction serializes concurrent commitment creation for this
    // company — same fix already proven for IPC numbering (routes/ipcs.ts).
    const commitment = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM companies WHERE id = ${req.companyId} FOR UPDATE`);
      const result = await tx.execute<{
        id: string;
        commitment_number: number;
        status: string;
        created_at: string;
      }>(sql`
        INSERT INTO commitments (company_id, project_id, contract_id, supplier_id, type, status, commitment_number, description, currency, created_by)
        VALUES (
          ${req.companyId},
          ${req.params.projectId},
          ${parsed.data.contractId ?? null},
          ${parsed.data.supplierId},
          ${parsed.data.type},
          'draft',
          (SELECT COALESCE(MAX(commitment_number), 0) + 1 FROM commitments WHERE company_id = ${req.companyId}),
          ${parsed.data.description ?? null},
          ${parsed.data.currency ?? "SAR"},
          ${req.userId}
        )
        RETURNING id, commitment_number, status, created_at
      `);
      return result.rows[0];
    });

    await recordAuditEvent(db, {
      companyId: req.companyId!,
      actorUserId: req.userId!,
      action: "commitment.created",
      entityType: "commitment",
      entityId: commitment.id,
      afterValue: commitment,
      metadata: { supplierId: parsed.data.supplierId, type: parsed.data.type },
    });

    res.status(201).json(commitment);
  },
);

async function findOwnedCommitment(companyId: string, projectId: string, commitmentId: string) {
  return db.query.commitments.findFirst({
    where: and(
      eq(commitments.id, commitmentId),
      eq(commitments.projectId, projectId),
      eq(commitments.companyId, companyId),
    ),
  });
}

commitmentsRouter.get("/:commitmentId", async (req: Request<CommitmentParams>, res: Response) => {
  const commitment = await findOwnedCommitment(req.companyId!, req.params.projectId, req.params.commitmentId);
  if (!commitment) return res.status(404).json({ error: "الالتزام غير موجود" });

  const lines = await db.query.commitmentLines.findMany({
    where: eq(commitmentLines.commitmentId, commitment.id),
    orderBy: (l, { asc }) => [asc(l.sortOrder)],
  });
  res.json({ ...commitment, lines });
});

const lineSchema = z.object({
  costCodeId: z.string().uuid().optional(),
  boqItemId: z.string().uuid().optional(),
  description: z.string().min(1, "الوصف مطلوب"),
  quantity: z.coerce.number().nonnegative().optional(),
  rate: z.coerce.number().nonnegative().optional(),
  amount: z.coerce.number().nonnegative().optional(),
  sortOrder: z.coerce.number().int().optional(),
});

// A line's amount is either supplied directly or computed from
// quantity*rate (same discipline as boqItems.amount, lib/money.ts) — one
// of the two must be resolvable, never left ambiguous or NaN.
function resolveLineAmount(data: z.infer<typeof lineSchema>): number | null {
  if (data.quantity !== undefined && data.rate !== undefined) {
    return roundMoney(data.quantity * data.rate);
  }
  if (data.amount !== undefined) return roundMoney(data.amount);
  return null;
}

async function validateLineReferences(
  companyId: string,
  projectId: string,
  data: z.infer<typeof lineSchema>,
): Promise<string | null> {
  if (data.costCodeId) {
    const costCode = await db.query.costCodes.findFirst({
      where: and(eq(costCodes.id, data.costCodeId), eq(costCodes.companyId, companyId)),
    });
    if (!costCode) return "بند التكلفة غير موجود";
  }
  if (data.boqItemId) {
    // A commitment line's boqItemId must belong to a BOQ revision under
    // THIS project — never trusted merely because the item id exists
    // somewhere in the database (it could belong to another project or
    // another company's contract).
    const boqItem = await db.query.boqItems.findFirst({
      where: eq(boqItems.id, data.boqItemId),
    });
    if (!boqItem) return "بند جدول الكميات غير موجود";
    const revision = await db.query.boqRevisions.findFirst({
      where: and(eq(boqRevisions.id, boqItem.boqRevisionId), eq(boqRevisions.projectId, projectId)),
    });
    if (!revision) return "بند جدول الكميات غير موجود";
  }
  return null;
}

// Lines can only be added to a commitment that is still "draft" —
// mirrors boq.ts's add-item discipline exactly, including WHY: the early
// status check below is only a fast-path, the actual guarantee is the
// `SELECT ... FOR UPDATE` lock inside the transaction just before the
// insert, which takes the same row lock submit()/approve() take, so a
// line can never be silently added to a commitment that has just moved
// past draft.
commitmentsRouter.post(
  "/:commitmentId/items",
  requirePermission("commitment.manage"),
  async (req: Request<CommitmentParams>, res: Response) => {
    const commitment = await findOwnedCommitment(req.companyId!, req.params.projectId, req.params.commitmentId);
    if (!commitment) return res.status(404).json({ error: "الالتزام غير موجود" });
    if (commitment.status !== "draft") {
      return res.status(409).json({ error: "لا يمكن إضافة بنود إلى التزام ليس في حالة مسودة" });
    }

    const parsed = lineSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

    const amount = resolveLineAmount(parsed.data);
    if (amount === null) {
      return res.status(400).json({ error: "يجب تحديد المبلغ أو الكمية والسعر معاً" });
    }

    const refError = await validateLineReferences(req.companyId!, req.params.projectId, parsed.data);
    if (refError) return res.status(404).json({ error: refError });

    const line = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(commitments).where(eq(commitments.id, commitment.id)).for("update");
      if (!locked || locked.status !== "draft") return null;

      const [inserted] = await tx
        .insert(commitmentLines)
        .values({
          companyId: req.companyId!,
          commitmentId: commitment.id,
          costCodeId: parsed.data.costCodeId,
          boqItemId: parsed.data.boqItemId,
          description: parsed.data.description,
          quantity: parsed.data.quantity !== undefined ? String(parsed.data.quantity) : undefined,
          rate: parsed.data.rate !== undefined ? String(parsed.data.rate) : undefined,
          amount: String(amount),
          sortOrder: parsed.data.sortOrder ?? 0,
        })
        .returning();

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "commitment.lineAdded",
        entityType: "commitment_line",
        entityId: inserted.id,
        afterValue: inserted,
        metadata: { commitmentId: commitment.id },
      });

      return inserted;
    });

    if (!line) {
      return res.status(409).json({ error: "لا يمكن إضافة بنود إلى التزام ليس في حالة مسودة" });
    }
    res.status(201).json(line);
  },
);

commitmentsRouter.delete(
  "/:commitmentId/items/:lineId",
  requirePermission("commitment.manage"),
  async (req: Request<LineParams>, res: Response) => {
    const commitment = await findOwnedCommitment(req.companyId!, req.params.projectId, req.params.commitmentId);
    if (!commitment) return res.status(404).json({ error: "الالتزام غير موجود" });
    if (commitment.status !== "draft") {
      return res.status(409).json({ error: "لا يمكن حذف بنود من التزام ليس في حالة مسودة" });
    }

    const existing = await db.query.commitmentLines.findFirst({
      where: and(eq(commitmentLines.id, req.params.lineId), eq(commitmentLines.commitmentId, commitment.id)),
    });
    if (!existing) return res.status(404).json({ error: "البند غير موجود" });

    const deleted = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(commitments).where(eq(commitments.id, commitment.id)).for("update");
      if (!locked || locked.status !== "draft") return null;

      const [row] = await tx.delete(commitmentLines).where(eq(commitmentLines.id, existing.id)).returning();

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "commitment.lineRemoved",
        entityType: "commitment_line",
        entityId: existing.id,
        beforeValue: existing,
        metadata: { commitmentId: commitment.id },
      });

      return row;
    });

    if (!deleted) {
      return res.status(409).json({ error: "لا يمكن حذف بنود من التزام ليس في حالة مسودة" });
    }
    res.status(204).end();
  },
);

// Freezes originalAmount = revisedAmount = SUM(lines) at this exact
// moment, atomically: the FOR UPDATE lock plus re-reading lines from
// inside the same transaction is what guarantees the frozen total is
// exactly the line set that existed when this succeeded — not a value
// read before the lock was acquired.
commitmentsRouter.post(
  "/:commitmentId/submit",
  requirePermission("commitment.manage"),
  async (req: Request<CommitmentParams>, res: Response) => {
    const commitment = await findOwnedCommitment(req.companyId!, req.params.projectId, req.params.commitmentId);
    if (!commitment) return res.status(404).json({ error: "الالتزام غير موجود" });

    const result = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(commitments).where(eq(commitments.id, commitment.id)).for("update");
      if (!locked || locked.status !== "draft") return { outcome: "conflict" as const };

      const lines = await tx.select().from(commitmentLines).where(eq(commitmentLines.commitmentId, commitment.id));
      if (lines.length === 0) return { outcome: "noLines" as const };

      const total = sumMoney(lines.map((l) => Number(l.amount)));
      const [updated] = await tx
        .update(commitments)
        .set({
          status: "pending_approval",
          submittedAt: new Date(),
          originalAmount: String(total),
          revisedAmount: String(total),
          updatedAt: new Date(),
        })
        .where(eq(commitments.id, commitment.id))
        .returning();

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "commitment.submitted",
        entityType: "commitment",
        entityId: commitment.id,
        beforeValue: { status: "draft" },
        afterValue: {
          status: "pending_approval",
          originalAmount: updated.originalAmount,
          revisedAmount: updated.revisedAmount,
        },
      });

      return { outcome: "ok" as const, commitment: updated };
    });

    if (result.outcome === "conflict") {
      return res.status(409).json({ error: "لا يمكن إرسال التزام ليس في حالة مسودة" });
    }
    if (result.outcome === "noLines") {
      return res.status(400).json({ error: "لا يمكن إرسال التزام بدون بنود" });
    }
    res.json(result.commitment);
  },
);

// Atomic: only succeeds if the commitment is still "pending_approval" at
// the moment this exact statement runs (WHERE status = 'pending_approval'
// on the UPDATE itself) — same conditional-UPDATE discipline as
// changeOrders.ts / boq.ts's publish route. Exactly one of N concurrent
// approvals can ever succeed.
commitmentsRouter.post(
  "/:commitmentId/approve",
  requirePermission("commitment.manage"),
  async (req: Request<CommitmentParams>, res: Response) => {
    const existing = await findOwnedCommitment(req.companyId!, req.params.projectId, req.params.commitmentId);
    if (!existing) return res.status(404).json({ error: "الالتزام غير موجود" });

    const approved = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(commitments)
        .set({ status: "active", approvedBy: req.userId!, approvedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(commitments.id, existing.id), eq(commitments.status, "pending_approval")))
        .returning();
      if (!updated) return null;

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "commitment.approved",
        entityType: "commitment",
        entityId: existing.id,
        beforeValue: { status: "pending_approval" },
        afterValue: { status: "active" },
      });

      return updated;
    });

    if (!approved) {
      return res.status(409).json({ error: "لا يمكن اعتماد التزام ليس بانتظار الموافقة" });
    }
    res.json(approved);
  },
);

// Cancellation is only valid before a commitment is placed (draft or
// pending_approval) — matching the requested lifecycle exactly; an
// active commitment is a real placed order and is not cancellable
// through this action.
commitmentsRouter.post(
  "/:commitmentId/cancel",
  requirePermission("commitment.manage"),
  async (req: Request<CommitmentParams>, res: Response) => {
    const existing = await findOwnedCommitment(req.companyId!, req.params.projectId, req.params.commitmentId);
    if (!existing) return res.status(404).json({ error: "الالتزام غير موجود" });

    const cancelled = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(commitments)
        .set({ status: "cancelled", cancelledAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(commitments.id, existing.id),
            sql`${commitments.status} IN ('draft', 'pending_approval')`,
          ),
        )
        .returning();
      if (!updated) return null;

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "commitment.cancelled",
        entityType: "commitment",
        entityId: existing.id,
        beforeValue: { status: existing.status },
        afterValue: { status: "cancelled" },
      });

      return updated;
    });

    if (!cancelled) {
      return res.status(409).json({ error: "لا يمكن إلغاء التزام في هذه الحالة" });
    }
    res.json(cancelled);
  },
);

const amendSchema = z.object({
  reason: z.string().optional(),
  lines: z.array(lineSchema).min(1, "أضف بنداً واحداً على الأقل للتعديل"),
});

// Amendment = adding new lines to an already-placed commitment (active or
// partially_fulfilled) and atomically recomputing revisedAmount from the
// FULL current line set (existing + new) — never a freely-typed new
// number. The FOR UPDATE lock on the commitment row is the guarantee two
// concurrent amendments can never both compute a total from a stale line
// set and overwrite each other's contribution (the same class of bug the
// very first audit found in change-order approval, and TC-03/04 found
// again in the tax engine — closed here from the start rather than
// retrofitted later).
commitmentsRouter.post(
  "/:commitmentId/amend",
  requirePermission("commitment.manage"),
  async (req: Request<CommitmentParams>, res: Response) => {
    const commitment = await findOwnedCommitment(req.companyId!, req.params.projectId, req.params.commitmentId);
    if (!commitment) return res.status(404).json({ error: "الالتزام غير موجود" });

    const parsed = amendSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

    const resolvedLines: Array<{ data: z.infer<typeof lineSchema>; amount: number }> = [];
    for (const lineData of parsed.data.lines) {
      const amount = resolveLineAmount(lineData);
      if (amount === null) {
        return res.status(400).json({ error: "يجب تحديد المبلغ أو الكمية والسعر معاً لكل بند" });
      }
      const refError = await validateLineReferences(req.companyId!, req.params.projectId, lineData);
      if (refError) return res.status(404).json({ error: refError });
      resolvedLines.push({ data: lineData, amount });
    }

    const result = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(commitments).where(eq(commitments.id, commitment.id)).for("update");
      if (!locked || !["active", "partially_fulfilled"].includes(locked.status)) {
        return { outcome: "conflict" as const };
      }

      const insertedLines = await tx
        .insert(commitmentLines)
        .values(
          resolvedLines.map(({ data, amount }) => ({
            companyId: req.companyId!,
            commitmentId: commitment.id,
            costCodeId: data.costCodeId,
            boqItemId: data.boqItemId,
            description: data.description,
            quantity: data.quantity !== undefined ? String(data.quantity) : undefined,
            rate: data.rate !== undefined ? String(data.rate) : undefined,
            amount: String(amount),
            sortOrder: data.sortOrder ?? 0,
          })),
        )
        .returning();

      // Recomputed from the database, not from beforeValue + resolvedLines
      // in JS — this is what makes the total correct even if this amend
      // raced (and lost, then won the lock after) another one.
      const allLines = await tx.select().from(commitmentLines).where(eq(commitmentLines.commitmentId, commitment.id));
      const newTotal = sumMoney(allLines.map((l) => Number(l.amount)));

      const [updated] = await tx
        .update(commitments)
        .set({ revisedAmount: String(newTotal), updatedAt: new Date() })
        .where(eq(commitments.id, commitment.id))
        .returning();

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "commitment.amended",
        entityType: "commitment",
        entityId: commitment.id,
        beforeValue: { revisedAmount: locked.revisedAmount },
        afterValue: { revisedAmount: updated.revisedAmount },
        reason: parsed.data.reason,
        metadata: { addedLineIds: insertedLines.map((l) => l.id) },
      });

      return { outcome: "ok" as const, commitment: updated };
    });

    if (result.outcome === "conflict") {
      return res.status(409).json({ error: "لا يمكن تعديل التزام في هذه الحالة" });
    }
    res.json(result.commitment);
  },
);
