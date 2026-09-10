import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { laborAllocations, payrollRecords, payrollPeriods, projects, costCodes } from "../db/schema.js";
import { requirePermission } from "../lib/permissions.js";
import { recordAuditEvent } from "../lib/audit.js";
import { roundMoney } from "../lib/money.js";
import { EDITABLE_PERIOD_STATUSES } from "./payrollPeriods.js";

// MIDAD Phase A4 — Labor Allocation: Payroll Record -> Project [-> Cost
// Code], per A1's own architecture (see db/schema.ts's comment above the
// `laborAllocations` table). Percentage is the authoring input; `amount`
// is the frozen, resolved SAR figure computed here and never recomputed
// from percentage at read time. The "never exceed 100%" invariant is
// enforced with the exact lock-then-re-SELECT-then-recompute discipline
// A1 names explicitly: "lock the parent payrollRecords row FOR UPDATE,
// recompute the full set from inside that transaction, exactly like
// commitments.ts's amend() already does" — see commitments.ts's amend()
// for the precedent this mirrors.
//
// ABSOLUTE BOUNDARY: this file NEVER writes to `expenses` or
// `labor_cost_postings`. A1's own comment on laborCostPostings says
// plainly: "No route in this slice writes here yet (A5)" — financial
// posting (the point payroll becomes Actual Cost) is explicitly reserved
// for a future, separately authorized slice. Every allocation created
// here is pre-posting, internal data — see routes/laborCost.ts for the
// read-only, clearly-labeled "not yet posted" visibility this enables.
//
// Locking: an allocation determines WHICH project/cost-code bears a
// payroll cost — reassigning that after a period is submitted/approved
// would change the financial meaning of an already-reviewed payroll, so
// allocation create/update/delete all respect the exact same
// EDITABLE_PERIOD_STATUSES A3 established for payroll records themselves.
//
// No status column exists on laborAllocations in A1 (like payrollRecords,
// its own editability is governed entirely by the parent period) — not
// adding one here, deliberately, for the same reason A3 didn't invent one
// for payrollRecords.
export const laborAllocationsRouter = Router();

// Percentage points need the same "round via integer arithmetic, never
// raw float addition" discipline lib/money.ts already applies to SAR
// amounts — kept local rather than added to money.ts since it is not a
// currency concept.
function sumPercent(values: number[]): number {
  return values.reduce((total, v) => total + Math.round(v * 100), 0) / 100;
}

laborAllocationsRouter.get("/", async (req: Request, res: Response) => {
  const payrollRecordId = typeof req.query.payrollRecordId === "string" ? req.query.payrollRecordId : undefined;
  const payrollPeriodId = typeof req.query.payrollPeriodId === "string" ? req.query.payrollPeriodId : undefined;
  const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;

  const conditions = [eq(laborAllocations.companyId, req.companyId!)];
  if (payrollRecordId) conditions.push(eq(laborAllocations.payrollRecordId, payrollRecordId));
  if (projectId) conditions.push(eq(laborAllocations.projectId, projectId));

  if (payrollPeriodId) {
    const period = await db.query.payrollPeriods.findFirst({
      where: and(eq(payrollPeriods.id, payrollPeriodId), eq(payrollPeriods.companyId, req.companyId!)),
    });
    if (!period) return res.status(404).json({ error: "فترة الرواتب غير موجودة" });

    const records = await db
      .select({ id: payrollRecords.id })
      .from(payrollRecords)
      .where(eq(payrollRecords.payrollPeriodId, payrollPeriodId));
    if (records.length === 0) return res.json([]);
    conditions.push(inArray(laborAllocations.payrollRecordId, records.map((r) => r.id)));
  }

  const rows = await db.query.laborAllocations.findMany({
    where: and(...conditions),
    with: {
      project: { columns: { id: true, name: true } },
      costCode: { columns: { id: true, code: true, name: true } },
    },
    orderBy: (a, { asc }) => [asc(a.createdAt)],
  });
  res.json(rows);
});

async function findOwnedAllocation(companyId: string, id: string) {
  return db.query.laborAllocations.findFirst({
    where: and(eq(laborAllocations.id, id), eq(laborAllocations.companyId, companyId)),
    with: {
      project: { columns: { id: true, name: true } },
      costCode: { columns: { id: true, code: true, name: true } },
    },
  });
}

laborAllocationsRouter.get("/:id", async (req: Request<{ id: string }>, res: Response) => {
  const allocation = await findOwnedAllocation(req.companyId!, req.params.id);
  if (!allocation) return res.status(404).json({ error: "توزيع التكلفة غير موجود" });
  res.json(allocation);
});

const createSchema = z.object({
  payrollRecordId: z.string().uuid(),
  projectId: z.string().uuid(),
  costCodeId: z.string().uuid().optional(),
  percentage: z.coerce.number().finite().positive().max(100),
  notes: z.string().optional(),
});

laborAllocationsRouter.post("/", requirePermission("payroll.manage"), async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  // Scoping payrollRecords by companyId transitively proves its
  // payrollPeriodId/employeeId also belong to this company — A3's own
  // creation route never allows a record to exist with a cross-company
  // period or employee, so a second, separate lookup would be redundant,
  // not an additional guarantee.
  const record = await db.query.payrollRecords.findFirst({
    where: and(eq(payrollRecords.id, parsed.data.payrollRecordId), eq(payrollRecords.companyId, req.companyId!)),
  });
  if (!record) return res.status(404).json({ error: "سجل الراتب غير موجود" });

  const project = await db.query.projects.findFirst({
    where: and(eq(projects.id, parsed.data.projectId), eq(projects.companyId, req.companyId!)),
  });
  if (!project) return res.status(404).json({ error: "المشروع غير موجود" });

  if (parsed.data.costCodeId) {
    const costCode = await db.query.costCodes.findFirst({
      where: and(eq(costCodes.id, parsed.data.costCodeId), eq(costCodes.companyId, req.companyId!)),
    });
    if (!costCode) return res.status(404).json({ error: "بند التكلفة غير موجود" });
    if (costCode.projectId && costCode.projectId !== project.id) {
      return res.status(400).json({ error: "بند التكلفة خاص بمشروع آخر ولا يمكن استخدامه هنا" });
    }
  }

  const result = await db.transaction(async (tx) => {
    // Parent-before-child lock order (period, then record) — same
    // deadlock-safe discipline as commitments.ts's amend()/ipcs.ts's
    // certify(): every route touching both always locks in this order.
    const [lockedPeriod] = await tx
      .select()
      .from(payrollPeriods)
      .where(eq(payrollPeriods.id, record.payrollPeriodId))
      .for("update");
    if (!lockedPeriod || !EDITABLE_PERIOD_STATUSES.includes(lockedPeriod.status)) {
      return { outcome: "locked" as const };
    }
    const [lockedRecord] = await tx.select().from(payrollRecords).where(eq(payrollRecords.id, record.id)).for("update");
    if (!lockedRecord) return { outcome: "locked" as const };

    // Recomputed from the database inside this transaction, not from a
    // stale pre-transaction read — the same discipline commitments.ts's
    // amend() uses, so two concurrent allocation attempts against the
    // same payroll record can never both read the same prior total and
    // together exceed 100%.
    const existingRows = await tx
      .select({ percentage: laborAllocations.percentage })
      .from(laborAllocations)
      .where(eq(laborAllocations.payrollRecordId, record.id));
    const existingTotal = sumPercent(existingRows.map((r) => Number(r.percentage ?? 0)));
    const newTotal = existingTotal + parsed.data.percentage;
    if (newTotal > 100.0001) {
      return { outcome: "exceeds100" as const, remainingPercent: roundMoney(100 - existingTotal) };
    }

    const amount = roundMoney(Number(lockedRecord.netAmount) * (parsed.data.percentage / 100));

    const [created] = await tx
      .insert(laborAllocations)
      .values({
        companyId: req.companyId!,
        payrollRecordId: record.id,
        projectId: project.id,
        costCodeId: parsed.data.costCodeId,
        percentage: String(parsed.data.percentage),
        amount: String(amount),
        notes: parsed.data.notes,
        createdBy: req.userId!,
      })
      .returning();

    await recordAuditEvent(tx, {
      companyId: req.companyId!,
      actorUserId: req.userId!,
      action: "laborAllocation.created",
      entityType: "labor_allocation",
      entityId: created.id,
      afterValue: created,
      metadata: { payrollRecordId: record.id, projectId: project.id },
    });

    return { outcome: "ok" as const, allocation: created };
  });

  if (result.outcome === "locked") {
    return res.status(409).json({ error: "لا يمكن توزيع تكلفة سجل في فترة تم إرسالها أو اعتمادها" });
  }
  if (result.outcome === "exceeds100") {
    return res.status(400).json({
      error: `النسبة تتجاوز المتاح — النسبة غير الموزعة المتبقية ${result.remainingPercent}%`,
      remainingPercent: result.remainingPercent,
    });
  }
  res.status(201).json(result.allocation);
});

const updateSchema = z.object({
  costCodeId: z.string().uuid().nullable().optional(),
  percentage: z.coerce.number().finite().positive().max(100).optional(),
  notes: z.string().optional(),
});

laborAllocationsRouter.patch(
  "/:id",
  requirePermission("payroll.manage"),
  async (req: Request<{ id: string }>, res: Response) => {
    const existing = await db.query.laborAllocations.findFirst({
      where: and(eq(laborAllocations.id, req.params.id), eq(laborAllocations.companyId, req.companyId!)),
    });
    if (!existing) return res.status(404).json({ error: "توزيع التكلفة غير موجود" });

    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

    if (parsed.data.costCodeId) {
      const costCode = await db.query.costCodes.findFirst({
        where: and(eq(costCodes.id, parsed.data.costCodeId), eq(costCodes.companyId, req.companyId!)),
      });
      if (!costCode) return res.status(404).json({ error: "بند التكلفة غير موجود" });
      if (costCode.projectId && costCode.projectId !== existing.projectId) {
        return res.status(400).json({ error: "بند التكلفة خاص بمشروع آخر ولا يمكن استخدامه هنا" });
      }
    }

    // payrollRecordId on an existing allocation always belongs to this
    // company by construction (create() above only ever stores one that
    // was already validated), so a plain lookup by id is sufficient here.
    const record = await db.query.payrollRecords.findFirst({
      where: eq(payrollRecords.id, existing.payrollRecordId),
    });
    if (!record) return res.status(404).json({ error: "سجل الراتب غير موجود" });

    const result = await db.transaction(async (tx) => {
      const [lockedPeriod] = await tx
        .select()
        .from(payrollPeriods)
        .where(eq(payrollPeriods.id, record.payrollPeriodId))
        .for("update");
      if (!lockedPeriod || !EDITABLE_PERIOD_STATUSES.includes(lockedPeriod.status)) {
        return { outcome: "locked" as const };
      }
      const [lockedRecord] = await tx.select().from(payrollRecords).where(eq(payrollRecords.id, record.id)).for("update");
      if (!lockedRecord) return { outcome: "locked" as const };

      let newPercentage = existing.percentage;
      let newAmount = existing.amount;
      if (parsed.data.percentage !== undefined) {
        const others = await tx
          .select({ id: laborAllocations.id, percentage: laborAllocations.percentage })
          .from(laborAllocations)
          .where(eq(laborAllocations.payrollRecordId, existing.payrollRecordId));
        const othersTotal = sumPercent(
          others.filter((o) => o.id !== existing.id).map((o) => Number(o.percentage ?? 0)),
        );
        const newTotal = othersTotal + parsed.data.percentage;
        if (newTotal > 100.0001) {
          return { outcome: "exceeds100" as const, remainingPercent: roundMoney(100 - othersTotal) };
        }
        newPercentage = String(parsed.data.percentage);
        newAmount = String(roundMoney(Number(lockedRecord.netAmount) * (parsed.data.percentage / 100)));
      }

      const [updated] = await tx
        .update(laborAllocations)
        .set({
          ...(parsed.data.costCodeId !== undefined ? { costCodeId: parsed.data.costCodeId } : {}),
          percentage: newPercentage,
          amount: newAmount,
          ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
        })
        .where(eq(laborAllocations.id, existing.id))
        .returning();

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "laborAllocation.updated",
        entityType: "labor_allocation",
        entityId: existing.id,
        beforeValue: existing,
        afterValue: updated,
        metadata: { payrollRecordId: existing.payrollRecordId },
      });

      return { outcome: "ok" as const, allocation: updated };
    });

    if (result.outcome === "locked") {
      return res.status(409).json({ error: "لا يمكن تعديل توزيع تكلفة في فترة تم إرسالها أو اعتمادها" });
    }
    if (result.outcome === "exceeds100") {
      return res.status(400).json({
        error: `النسبة تتجاوز المتاح — النسبة غير الموزعة المتبقية ${result.remainingPercent}%`,
        remainingPercent: result.remainingPercent,
      });
    }
    res.json(result.allocation);
  },
);

// Hard delete is safe here specifically because A4 never posts to
// `expenses` — an allocation carries no financial consequence yet (see
// this file's own header comment). Still locked-period-protected: a
// correction on an already-reviewed payroll must go through reject/
// resubmit, not a silent deletion.
laborAllocationsRouter.delete(
  "/:id",
  requirePermission("payroll.manage"),
  async (req: Request<{ id: string }>, res: Response) => {
    const existing = await db.query.laborAllocations.findFirst({
      where: and(eq(laborAllocations.id, req.params.id), eq(laborAllocations.companyId, req.companyId!)),
    });
    if (!existing) return res.status(404).json({ error: "توزيع التكلفة غير موجود" });

    const record = await db.query.payrollRecords.findFirst({
      where: eq(payrollRecords.id, existing.payrollRecordId),
    });
    if (!record) return res.status(404).json({ error: "سجل الراتب غير موجود" });

    const result = await db.transaction(async (tx) => {
      const [lockedPeriod] = await tx
        .select()
        .from(payrollPeriods)
        .where(eq(payrollPeriods.id, record.payrollPeriodId))
        .for("update");
      if (!lockedPeriod || !EDITABLE_PERIOD_STATUSES.includes(lockedPeriod.status)) {
        return { outcome: "locked" as const };
      }

      await tx.delete(laborAllocations).where(eq(laborAllocations.id, existing.id));

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "laborAllocation.deleted",
        entityType: "labor_allocation",
        entityId: existing.id,
        beforeValue: existing,
        metadata: { payrollRecordId: existing.payrollRecordId },
      });

      return { outcome: "ok" as const };
    });

    if (result.outcome === "locked") {
      return res.status(409).json({ error: "لا يمكن حذف توزيع تكلفة في فترة تم إرسالها أو اعتمادها" });
    }
    res.status(204).send();
  },
);
