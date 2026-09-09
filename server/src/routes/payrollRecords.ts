import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { payrollRecords, payrollPeriods, employees } from "../db/schema.js";
import { requirePermission } from "../lib/permissions.js";
import { recordAuditEvent } from "../lib/audit.js";
import { pgErrorInfo } from "../lib/pgError.js";
import { roundMoney } from "../lib/money.js";
import { EDITABLE_PERIOD_STATUSES } from "./payrollPeriods.js";

// MIDAD Phase A3 — Payroll Records. Reuses the A1 `payroll_records` table
// exactly as designed — no new "status" column: a record's own
// editability is governed entirely by its PARENT payroll period's status
// (see payrollPeriods.ts's EDITABLE_PERIOD_STATUSES), not a separate
// per-record state machine. This is a deliberate choice, not an
// oversight: A1 never gave payrollRecords a status column, and adding one
// here would be a second, redundant lifecycle for something the parent
// period already fully governs.
//
// Net amount is always server-computed as gross - deductions (the only
// canonical calculation A1's schema actually supports — it has no
// "allowances" column) — never trusted from the client, so a record can
// never disagree with its own arithmetic.
//
// This is INTERNAL payroll data (see A1's own schema comment on
// sourceType/verificationStatus): every record created here defaults to
// sourceType="manual", verificationStatus="unverified". Nothing in A3
// ever sets "verified" or touches provider/externalReference/
// importBatchId — those stay reserved for a real, future Mudad/WPS
// provider integration or CSV/Excel import slice.
export const payrollRecordsRouter = Router();

payrollRecordsRouter.get("/", async (req: Request, res: Response) => {
  const periodId = typeof req.query.payrollPeriodId === "string" ? req.query.payrollPeriodId : undefined;

  if (periodId) {
    const period = await db.query.payrollPeriods.findFirst({
      where: and(eq(payrollPeriods.id, periodId), eq(payrollPeriods.companyId, req.companyId!)),
    });
    if (!period) return res.status(404).json({ error: "فترة الرواتب غير موجودة" });
  }

  const rows = await db.query.payrollRecords.findMany({
    where: and(
      eq(payrollRecords.companyId, req.companyId!),
      periodId ? eq(payrollRecords.payrollPeriodId, periodId) : undefined,
    ),
    with: { employee: { columns: { id: true, name: true, employeeNumber: true, status: true } } },
    orderBy: (r, { asc }) => [asc(r.createdAt)],
  });
  res.json(rows);
});

async function findOwnedRecord(companyId: string, recordId: string) {
  return db.query.payrollRecords.findFirst({
    where: and(eq(payrollRecords.id, recordId), eq(payrollRecords.companyId, companyId)),
    with: { employee: { columns: { id: true, name: true, employeeNumber: true, status: true } } },
  });
}

payrollRecordsRouter.get("/:id", async (req: Request<{ id: string }>, res: Response) => {
  const record = await findOwnedRecord(req.companyId!, req.params.id);
  if (!record) return res.status(404).json({ error: "سجل الراتب غير موجود" });
  res.json(record);
});

const createSchema = z.object({
  payrollPeriodId: z.string().uuid(),
  employeeId: z.string().uuid(),
  grossAmount: z.coerce.number().finite().nonnegative(),
  deductionsAmount: z.coerce.number().finite().nonnegative().default(0),
});

payrollRecordsRouter.post("/", requirePermission("payroll.manage"), async (req: Request, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  // Every reference resolved and re-validated against THIS company —
  // payrollPeriodId/employeeId are never trusted as belonging to the
  // caller's tenant just because they parsed as UUIDs.
  const period = await db.query.payrollPeriods.findFirst({
    where: and(eq(payrollPeriods.id, parsed.data.payrollPeriodId), eq(payrollPeriods.companyId, req.companyId!)),
  });
  if (!period) return res.status(404).json({ error: "فترة الرواتب غير موجودة" });

  // Any employee status is accepted (active or inactive) — a payroll
  // record for a worker who left mid-period is still valid historical
  // data, per A2's own "inactive is not deletion" lifecycle.
  const employee = await db.query.employees.findFirst({
    where: and(eq(employees.id, parsed.data.employeeId), eq(employees.companyId, req.companyId!)),
  });
  if (!employee) return res.status(404).json({ error: "الموظف غير موجود" });

  const gross = roundMoney(parsed.data.grossAmount);
  const deductions = roundMoney(parsed.data.deductionsAmount);
  const netAmount = roundMoney(gross - deductions);
  if (netAmount < 0) return res.status(400).json({ error: "لا يمكن أن تتجاوز الخصومات الأساسي" });

  try {
    const result = await db.transaction(async (tx) => {
      // Lock the parent period for the duration of this insert — a
      // concurrent submit()/approve() on the same period cannot race past
      // this record's creation into a false "immutable" state, same
      // discipline as ipcs.ts's item-add-under-lock.
      const [lockedPeriod] = await tx.select().from(payrollPeriods).where(eq(payrollPeriods.id, period.id)).for("update");
      if (!lockedPeriod || !EDITABLE_PERIOD_STATUSES.includes(lockedPeriod.status)) {
        return { outcome: "locked" as const };
      }

      const [created] = await tx
        .insert(payrollRecords)
        .values({
          companyId: req.companyId!,
          payrollPeriodId: period.id,
          employeeId: employee.id,
          grossAmount: String(gross),
          deductionsAmount: String(deductions),
          netAmount: String(netAmount),
          createdBy: req.userId!,
        })
        .returning();

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "payrollRecord.created",
        entityType: "payroll_record",
        entityId: created.id,
        afterValue: created,
        metadata: { payrollPeriodId: period.id },
      });

      return { outcome: "ok" as const, record: created };
    });

    if (result.outcome === "locked") {
      return res.status(409).json({ error: "لا يمكن إضافة سجل رواتب إلى فترة تم إرسالها أو اعتمادها" });
    }
    res.status(201).json(result.record);
  } catch (err) {
    if (pgErrorInfo(err).code === "23505") {
      return res.status(409).json({ error: "يوجد سجل راتب لهذا الموظف في هذه الفترة بالفعل" });
    }
    throw err;
  }
});

const updateSchema = z.object({
  grossAmount: z.coerce.number().finite().nonnegative().optional(),
  deductionsAmount: z.coerce.number().finite().nonnegative().optional(),
});

payrollRecordsRouter.patch(
  "/:id",
  requirePermission("payroll.manage"),
  async (req: Request<{ id: string }>, res: Response) => {
    const existing = await db.query.payrollRecords.findFirst({
      where: and(eq(payrollRecords.id, req.params.id), eq(payrollRecords.companyId, req.companyId!)),
    });
    if (!existing) return res.status(404).json({ error: "سجل الراتب غير موجود" });

    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

    const gross = roundMoney(parsed.data.grossAmount ?? Number(existing.grossAmount));
    const deductions = roundMoney(parsed.data.deductionsAmount ?? Number(existing.deductionsAmount));
    const netAmount = roundMoney(gross - deductions);
    if (netAmount < 0) return res.status(400).json({ error: "لا يمكن أن تتجاوز الخصومات الأساسي" });

    const result = await db.transaction(async (tx) => {
      const [lockedPeriod] = await tx
        .select()
        .from(payrollPeriods)
        .where(eq(payrollPeriods.id, existing.payrollPeriodId))
        .for("update");
      if (!lockedPeriod || !EDITABLE_PERIOD_STATUSES.includes(lockedPeriod.status)) {
        return { outcome: "locked" as const };
      }

      const [updated] = await tx
        .update(payrollRecords)
        .set({
          grossAmount: String(gross),
          deductionsAmount: String(deductions),
          netAmount: String(netAmount),
          updatedAt: new Date(),
        })
        .where(eq(payrollRecords.id, existing.id))
        .returning();

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "payrollRecord.updated",
        entityType: "payroll_record",
        entityId: existing.id,
        beforeValue: existing,
        afterValue: updated,
        metadata: { payrollPeriodId: existing.payrollPeriodId },
      });

      return { outcome: "ok" as const, record: updated };
    });

    if (result.outcome === "locked") {
      return res.status(409).json({ error: "لا يمكن تعديل سجل في فترة تم إرسالها أو اعتمادها" });
    }
    res.json(result.record);
  },
);
