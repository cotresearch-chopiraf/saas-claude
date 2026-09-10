import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "../db/client.js";
import { expenses, laborAllocations, laborCostPostings, payrollPeriods, payrollRecords } from "../db/schema.js";
import { requirePermission } from "../lib/permissions.js";
import { recordAuditEvent } from "../lib/audit.js";
import { pgErrorInfo } from "../lib/pgError.js";
import { roundMoney, sumMoney } from "../lib/money.js";

// MIDAD Phase A3 — Payroll Periods. Company-wide (not project-scoped —
// project labor allocation is a later slice), reusing the A1
// `payroll_periods` table exactly as designed (no schema change needed).
//
// Status lifecycle reuses A1's real enum verbatim: draft -> submitted ->
// approved -> posted | rejected. Everything through approve()/reject()
// below is pure editorial review — no financial claim happens until
// post() (Phase A5), the one point a payroll period "actually becomes
// financial truth" by creating real `expenses` rows via
// `laborCostPostings` (see that table's own schema comment). Once
// "posted", a period never returns to "approved" and is never re-editable
// through this file's own PATCH — EDITABLE_PERIOD_STATUSES deliberately
// stays ["draft", "rejected"] (it already excluded "approved", so no
// change was needed to also exclude "posted"); corrections happen only
// through the dedicated reversal operation in routes/laborCostPostings.ts.
export const payrollPeriodsRouter = Router();

// Editable only in draft/rejected — same pattern and reasoning as
// ipcs.ts/measurements.ts's own EDITABLE_STATUSES: once a period is
// submitted, its records become immutable through normal editing
// (enforced server-side in payrollRecords.ts, never just a disabled
// button).
export const EDITABLE_PERIOD_STATUSES = ["draft", "rejected"];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateField = z.string().regex(DATE_RE, "تنسيق التاريخ غير صالح");

// Simple inclusive-range overlap check — app-level only. A1's schema
// backstops exact-duplicate (companyId, periodStart, periodEnd) via a DB
// unique index, but does not define a range-exclusion constraint (that
// would need a Postgres EXCLUDE USING gist constraint — a bigger,
// non-additive schema change out of scope for this slice). This check is
// therefore a best-effort validation, not a DB-enforced invariant — see
// this file's own note in the final report about that gap.
function periodsOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

interface RecordSummary {
  employeeCount: number;
  totalGross: number;
  totalDeductions: number;
  totalNet: number;
}

function summarize(rows: Array<{ grossAmount: string; deductionsAmount: string; netAmount: string }>): RecordSummary {
  return {
    employeeCount: rows.length,
    totalGross: sumMoney(rows.map((r) => Number(r.grossAmount))),
    totalDeductions: sumMoney(rows.map((r) => Number(r.deductionsAmount))),
    totalNet: sumMoney(rows.map((r) => Number(r.netAmount))),
  };
}

// List + a per-period summary (employee count, totals) so the periods
// list page can show "34 موظف / SAR 420,000" without a second round trip
// per row. One extra query for all of this company's records, grouped in
// JS — same "fetch rows, sum with sumMoney" style forecast.ts's own
// collectForecastInputs already uses, not a SQL-level aggregate.
payrollPeriodsRouter.get("/", async (req: Request, res: Response) => {
  const periods = await db.query.payrollPeriods.findMany({
    where: eq(payrollPeriods.companyId, req.companyId!),
    orderBy: (p, { desc }) => [desc(p.periodStart)],
  });

  const records = await db
    .select({
      payrollPeriodId: payrollRecords.payrollPeriodId,
      grossAmount: payrollRecords.grossAmount,
      deductionsAmount: payrollRecords.deductionsAmount,
      netAmount: payrollRecords.netAmount,
    })
    .from(payrollRecords)
    .where(eq(payrollRecords.companyId, req.companyId!));

  const byPeriod = new Map<string, typeof records>();
  for (const r of records) {
    const list = byPeriod.get(r.payrollPeriodId) ?? [];
    list.push(r);
    byPeriod.set(r.payrollPeriodId, list);
  }

  res.json(periods.map((p) => ({ ...p, summary: summarize(byPeriod.get(p.id) ?? []) })));
});

const createSchema = z
  .object({
    periodStart: dateField,
    periodEnd: dateField,
    payrollDate: dateField.optional(),
    notes: z.string().optional(),
  })
  .refine((data) => data.periodStart <= data.periodEnd, {
    message: "يجب أن يسبق تاريخ بداية الفترة تاريخ نهايتها أو يساويه",
    path: ["periodEnd"],
  });

payrollPeriodsRouter.post("/", requirePermission("payroll.manage"), async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const others = await db.query.payrollPeriods.findMany({
    where: and(eq(payrollPeriods.companyId, req.companyId!), ne(payrollPeriods.status, "rejected")),
  });
  if (others.some((p) => periodsOverlap(parsed.data.periodStart, parsed.data.periodEnd, p.periodStart, p.periodEnd))) {
    return res.status(409).json({ error: "تتداخل هذه الفترة مع فترة رواتب أخرى موجودة" });
  }

  try {
    const period = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(payrollPeriods)
        .values({
          companyId: req.companyId!,
          periodStart: parsed.data.periodStart,
          periodEnd: parsed.data.periodEnd,
          payrollDate: parsed.data.payrollDate,
          notes: parsed.data.notes,
          createdBy: req.userId!,
        })
        .returning();

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "payrollPeriod.created",
        entityType: "payroll_period",
        entityId: created.id,
        afterValue: created,
      });

      return created;
    });

    res.status(201).json(period);
  } catch (err) {
    if (pgErrorInfo(err).code === "23505") {
      return res.status(409).json({ error: "توجد فترة رواتب بنفس التواريخ بالفعل" });
    }
    throw err;
  }
});

async function findOwnedPeriod(companyId: string, periodId: string) {
  return db.query.payrollPeriods.findFirst({
    where: and(eq(payrollPeriods.id, periodId), eq(payrollPeriods.companyId, companyId)),
  });
}

payrollPeriodsRouter.get("/:id", async (req: Request<{ id: string }>, res: Response) => {
  const period = await findOwnedPeriod(req.companyId!, req.params.id);
  if (!period) return res.status(404).json({ error: "فترة الرواتب غير موجودة" });

  const records = await db.query.payrollRecords.findMany({
    where: eq(payrollRecords.payrollPeriodId, period.id),
    with: { employee: { columns: { id: true, name: true, employeeNumber: true, status: true } } },
    orderBy: (r, { asc }) => [asc(r.createdAt)],
  });

  res.json({ ...period, records, summary: summarize(records) });
});

const updateSchema = z.object({
  periodStart: dateField.optional(),
  periodEnd: dateField.optional(),
  payrollDate: dateField.optional(),
  notes: z.string().optional(),
});

payrollPeriodsRouter.patch(
  "/:id",
  requirePermission("payroll.manage"),
  async (req: Request<{ id: string }>, res: Response) => {
    const existing = await findOwnedPeriod(req.companyId!, req.params.id);
    if (!existing) return res.status(404).json({ error: "فترة الرواتب غير موجودة" });

    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

    const newStart = parsed.data.periodStart ?? existing.periodStart;
    const newEnd = parsed.data.periodEnd ?? existing.periodEnd;
    if (newStart > newEnd) {
      return res.status(400).json({ error: "يجب أن يسبق تاريخ بداية الفترة تاريخ نهايتها أو يساويه" });
    }

    if (parsed.data.periodStart !== undefined || parsed.data.periodEnd !== undefined) {
      const others = await db.query.payrollPeriods.findMany({
        where: and(
          eq(payrollPeriods.companyId, req.companyId!),
          ne(payrollPeriods.id, existing.id),
          ne(payrollPeriods.status, "rejected"),
        ),
      });
      if (others.some((p) => periodsOverlap(newStart, newEnd, p.periodStart, p.periodEnd))) {
        return res.status(409).json({ error: "تتداخل هذه الفترة مع فترة رواتب أخرى موجودة" });
      }
    }

    try {
      const result = await db.transaction(async (tx) => {
        const [locked] = await tx.select().from(payrollPeriods).where(eq(payrollPeriods.id, existing.id)).for("update");
        if (!locked || !EDITABLE_PERIOD_STATUSES.includes(locked.status)) return { outcome: "locked" as const };

        const [updated] = await tx
          .update(payrollPeriods)
          .set({
            ...(parsed.data.periodStart !== undefined ? { periodStart: parsed.data.periodStart } : {}),
            ...(parsed.data.periodEnd !== undefined ? { periodEnd: parsed.data.periodEnd } : {}),
            ...(parsed.data.payrollDate !== undefined ? { payrollDate: parsed.data.payrollDate } : {}),
            ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
            updatedAt: new Date(),
          })
          .where(eq(payrollPeriods.id, existing.id))
          .returning();

        await recordAuditEvent(tx, {
          companyId: req.companyId!,
          actorUserId: req.userId!,
          action: "payrollPeriod.updated",
          entityType: "payroll_period",
          entityId: existing.id,
          beforeValue: existing,
          afterValue: updated,
        });

        return { outcome: "ok" as const, period: updated };
      });

      if (result.outcome === "locked") {
        return res.status(409).json({ error: "لا يمكن تعديل فترة تم إرسالها أو اعتمادها" });
      }
      res.json(result.period);
    } catch (err) {
      if (pgErrorInfo(err).code === "23505") {
        return res.status(409).json({ error: "توجد فترة رواتب بنفس التواريخ بالفعل" });
      }
      throw err;
    }
  },
);

// draft/rejected -> submitted, requires at least one payroll record —
// same shape as ipcs.ts's submit() ("noLines" -> "noRecords" here).
payrollPeriodsRouter.post(
  "/:id/submit",
  requirePermission("payroll.manage"),
  async (req: Request<{ id: string }>, res: Response) => {
    const existing = await findOwnedPeriod(req.companyId!, req.params.id);
    if (!existing) return res.status(404).json({ error: "فترة الرواتب غير موجودة" });

    const result = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(payrollPeriods).where(eq(payrollPeriods.id, existing.id)).for("update");
      if (!locked || !EDITABLE_PERIOD_STATUSES.includes(locked.status)) return { outcome: "conflict" as const };

      const records = await tx
        .select({ id: payrollRecords.id })
        .from(payrollRecords)
        .where(eq(payrollRecords.payrollPeriodId, existing.id));
      if (records.length === 0) return { outcome: "noRecords" as const };

      const [updated] = await tx
        .update(payrollPeriods)
        .set({
          status: "submitted",
          submittedBy: req.userId!,
          submittedAt: new Date(),
          rejectedBy: null,
          rejectedAt: null,
          rejectionReason: null,
          updatedAt: new Date(),
        })
        .where(eq(payrollPeriods.id, existing.id))
        .returning();

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "payrollPeriod.submitted",
        entityType: "payroll_period",
        entityId: existing.id,
        beforeValue: { status: locked.status },
        afterValue: { status: "submitted" },
      });

      return { outcome: "ok" as const, period: updated };
    });

    if (result.outcome === "conflict") {
      return res.status(409).json({ error: "لا يمكن إرسال فترة ليست مسودة أو مرفوضة" });
    }
    if (result.outcome === "noRecords") {
      return res.status(400).json({ error: "لا يمكن إرسال فترة رواتب بدون سجلات" });
    }
    res.json(result.period);
  },
);

// submitted -> approved. Pure editorial review gate, same posture as
// ipcs.ts's approve() (no financial claim happens here — that is the
// future "posted" transition, explicitly out of scope for A3).
payrollPeriodsRouter.post(
  "/:id/approve",
  requirePermission("payroll.manage"),
  async (req: Request<{ id: string }>, res: Response) => {
    const existing = await findOwnedPeriod(req.companyId!, req.params.id);
    if (!existing) return res.status(404).json({ error: "فترة الرواتب غير موجودة" });

    const approved = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(payrollPeriods)
        .set({ status: "approved", approvedBy: req.userId!, approvedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(payrollPeriods.id, existing.id), eq(payrollPeriods.status, "submitted")))
        .returning();
      if (!updated) return null;

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "payrollPeriod.approved",
        entityType: "payroll_period",
        entityId: existing.id,
        beforeValue: { status: "submitted" },
        afterValue: { status: "approved" },
      });

      return updated;
    });

    if (!approved) return res.status(409).json({ error: "لا يمكن اعتماد فترة ليست بانتظار الاعتماد" });
    res.json(approved);
  },
);

const rejectSchema = z.object({ reason: z.string().min(1, "سبب الرفض مطلوب") });

// submitted -> rejected. Rejoins the draft/edit flow exactly like ipcs.ts's
// reject() — no separate "return to draft" endpoint.
payrollPeriodsRouter.post(
  "/:id/reject",
  requirePermission("payroll.manage"),
  async (req: Request<{ id: string }>, res: Response) => {
    const existing = await findOwnedPeriod(req.companyId!, req.params.id);
    if (!existing) return res.status(404).json({ error: "فترة الرواتب غير موجودة" });

    const parsed = rejectSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

    const rejected = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(payrollPeriods)
        .set({
          status: "rejected",
          rejectedBy: req.userId!,
          rejectedAt: new Date(),
          rejectionReason: parsed.data.reason,
          updatedAt: new Date(),
        })
        .where(and(eq(payrollPeriods.id, existing.id), eq(payrollPeriods.status, "submitted")))
        .returning();
      if (!updated) return null;

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "payrollPeriod.rejected",
        entityType: "payroll_period",
        entityId: existing.id,
        beforeValue: { status: "submitted" },
        afterValue: { status: "rejected" },
        reason: parsed.data.reason,
      });

      return updated;
    });

    if (!rejected) return res.status(409).json({ error: "لا يمكن رفض فترة ليست بانتظار الاعتماد" });
    res.json(rejected);
  },
);

// approved -> posted. The one irreversible, money-moving action in this
// domain — gated by "payroll.post", not "payroll.manage" (see
// lib/permissions.ts's Phase A comment). Creates one real `expenses` row
// per not-yet-posted labor allocation under this period and links each
// through a `labor_cost_postings` row with kind="posting" — this is the
// ENTIRE financial mutation; Actual Cost/Forecast/Cash Flow pick it up
// automatically through their existing SUM(expenses.amount) pipeline,
// unchanged.
//
// Posting amount is `laborAllocations.amount` taken verbatim — the frozen
// value A4 computed once at allocation-time — never recomputed from
// percentage here.
//
// Partial allocation is valid and expected: only allocated percentage
// becomes an Expense; whatever percentage of a payroll record was never
// allocated to a project simply stays unposted (never auto-allocated,
// never silently dropped — the API response's `totalPosted` vs. the
// period's own totalNet lets the UI show the gap honestly).
//
// Expense date: uses the period's own `payrollDate` when the company set
// one (the authoritative pay-date), falling back to `periodEnd` — both
// already-existing fields, never today's browser/server date, which would
// be an arbitrary and non-reproducible choice for a financial record.
//
// Concurrency/double-posting: the SELECT ... FOR UPDATE below on the
// period row serializes concurrent POSTs of the same period exactly like
// submit()/approve() above; the atomic `status = 'approved'` WHERE guard
// on the final UPDATE is the same belt-and-suspenders pattern approve()
// itself uses. The two partial unique indexes on labor_cost_postings
// (schema.ts) are the DB-level backstop under that lock, not a substitute
// for it.
payrollPeriodsRouter.post(
  "/:id/post",
  requirePermission("payroll.post"),
  async (req: Request<{ id: string }>, res: Response) => {
    const existing = await findOwnedPeriod(req.companyId!, req.params.id);
    if (!existing) return res.status(404).json({ error: "فترة الرواتب غير موجودة" });

    const result = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(payrollPeriods).where(eq(payrollPeriods.id, existing.id)).for("update");
      if (!locked || locked.status !== "approved") return { outcome: "conflict" as const };

      const records = await tx
        .select({ id: payrollRecords.id })
        .from(payrollRecords)
        .where(eq(payrollRecords.payrollPeriodId, locked.id));
      const recordIds = records.map((r) => r.id);

      const allocations = recordIds.length
        ? await tx.select().from(laborAllocations).where(inArray(laborAllocations.payrollRecordId, recordIds))
        : [];
      if (allocations.length === 0) return { outcome: "noAllocations" as const };

      // Defensive dedup against anything already carrying a posting-kind
      // row for this allocation. In today's lifecycle this set is always
      // empty (a period is locked to further allocation edits the moment
      // it is approved, and post() only ever runs once per period since
      // status immediately leaves "approved"), but this is the explicit
      // "identify allocations not already posted" step the posting
      // algorithm calls for, kept as real defense-in-depth alongside the
      // DB-level partial unique index rather than relying on the period
      // lock alone.
      const already = await tx
        .select({ laborAllocationId: laborCostPostings.laborAllocationId })
        .from(laborCostPostings)
        .where(
          and(
            inArray(
              laborCostPostings.laborAllocationId,
              allocations.map((a) => a.id),
            ),
            eq(laborCostPostings.kind, "posting"),
          ),
        );
      const alreadyPostedIds = new Set(already.map((p) => p.laborAllocationId));
      const toPost = allocations.filter((a) => !alreadyPostedIds.has(a.id));
      if (toPost.length === 0) return { outcome: "noAllocations" as const };

      const expenseDate = locked.payrollDate ?? locked.periodEnd;
      const description = `ترحيل تكلفة عمالة — فترة رواتب ${locked.periodStart} إلى ${locked.periodEnd}`;

      const createdPostings: (typeof laborCostPostings.$inferSelect)[] = [];
      const postedAmounts: number[] = [];

      for (const allocation of toPost) {
        const [expense] = await tx
          .insert(expenses)
          .values({
            projectId: allocation.projectId,
            costCodeId: allocation.costCodeId,
            description,
            amount: allocation.amount,
            expenseDate,
          })
          .returning();

        const [posting] = await tx
          .insert(laborCostPostings)
          .values({
            companyId: req.companyId!,
            payrollPeriodId: locked.id,
            laborAllocationId: allocation.id,
            expenseId: expense.id,
            kind: "posting",
            postedBy: req.userId!,
          })
          .returning();

        createdPostings.push(posting);
        postedAmounts.push(Number(allocation.amount));

        await recordAuditEvent(tx, {
          companyId: req.companyId!,
          actorUserId: req.userId!,
          action: "laborCostPosting.created",
          entityType: "labor_cost_posting",
          entityId: posting.id,
          afterValue: posting,
          metadata: {
            payrollPeriodId: locked.id,
            laborAllocationId: allocation.id,
            projectId: allocation.projectId,
            costCodeId: allocation.costCodeId,
            expenseId: expense.id,
            amount: allocation.amount,
          },
        });
      }

      const totalPosted = sumMoney(postedAmounts);

      const [updatedPeriod] = await tx
        .update(payrollPeriods)
        .set({ status: "posted", postedBy: req.userId!, postedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(payrollPeriods.id, locked.id), eq(payrollPeriods.status, "approved")))
        .returning();
      if (!updatedPeriod) return { outcome: "conflict" as const };

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "payrollPeriod.posted",
        entityType: "payroll_period",
        entityId: locked.id,
        beforeValue: { status: "approved" },
        afterValue: { status: "posted" },
        metadata: { allocationsPosted: toPost.length, totalAmountPosted: totalPosted },
      });

      return { outcome: "ok" as const, period: updatedPeriod, postings: createdPostings, totalPosted };
    });

    if (result.outcome === "conflict") {
      return res.status(409).json({ error: "لا يمكن ترحيل فترة ليست معتمدة، أو تم ترحيلها بالفعل" });
    }
    if (result.outcome === "noAllocations") {
      return res.status(400).json({ error: "لا يوجد توزيع تكلفة عمالة غير مرحّل لترحيله في هذه الفترة" });
    }
    res.json({ period: result.period, postings: result.postings, totalPosted: result.totalPosted });
  },
);
