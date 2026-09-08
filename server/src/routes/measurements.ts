import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { boqItems, boqRevisions, contracts, measurementLines, measurements, projects } from "../db/schema.js";
import { requirePermission } from "../lib/permissions.js";
import { recordAuditEvent } from "../lib/audit.js";
import { roundMoney } from "../lib/money.js";
import { CONTRACT_EXECUTION_BLOCKED_STATUSES } from "./contracts.js";

type ProjectParams = { projectId: string };
type MeasurementParams = ProjectParams & { measurementId: string };
type LineParams = MeasurementParams & { lineId: string };

export const measurementsRouter = Router({ mergeParams: true });

// Same tenant/ownership-scoping pattern as every other project sub-resource.
measurementsRouter.use(async (req: Request<ProjectParams>, res: Response, next: NextFunction) => {
  const project = await db.query.projects.findFirst({
    where: and(eq(projects.id, req.params.projectId), eq(projects.companyId, req.companyId!)),
  });
  if (!project) return res.status(404).json({ error: "المشروع غير موجود" });
  next();
});

measurementsRouter.get("/", async (req: Request<ProjectParams>, res: Response) => {
  const rows = await db.query.measurements.findMany({
    where: eq(measurements.projectId, req.params.projectId),
    orderBy: (m, { desc }) => [desc(m.createdAt)],
  });
  res.json(rows);
});

const createSchema = z.object({
  contractId: z.string().uuid(),
  boqRevisionId: z.string().uuid(),
  measurementDate: z.string().min(1, "تاريخ القياس مطلوب"),
  description: z.string().optional(),
});

// Measurement creation is deliberately member-accessible (no
// requirePermission) — see lib/permissions.ts's comment on
// measurement.approve for why this matches tasks.ts/dailyLogs.ts's
// existing site-entry precedent rather than Commitment's owner-only one.
measurementsRouter.post("/", async (req: Request<ProjectParams>, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const contract = await db.query.contracts.findFirst({
    where: and(eq(contracts.id, parsed.data.contractId), eq(contracts.projectId, req.params.projectId)),
  });
  if (!contract) return res.status(404).json({ error: "العقد غير موجود" });
  // Phase 3.2 remediation (CTR-001) — a contract that is completed or
  // terminated must not accept new execution activity.
  if (CONTRACT_EXECUTION_BLOCKED_STATUSES.includes(contract.status)) {
    return res.status(409).json({ error: "لا يمكن إنشاء قياس على عقد منتهٍ أو ملغى" });
  }

  // Must be a PUBLISHED revision of THIS contract — never draft, never
  // superseded, never another contract's revision. Since a contract can
  // have at most one published revision at a time (boq.ts's publish
  // route), this check is exactly "the currently published revision."
  const revision = await db.query.boqRevisions.findFirst({
    where: and(
      eq(boqRevisions.id, parsed.data.boqRevisionId),
      eq(boqRevisions.contractId, parsed.data.contractId),
      eq(boqRevisions.status, "published"),
    ),
  });
  if (!revision) {
    return res.status(400).json({ error: "يجب أن يكون القياس على نسخة منشورة من جدول الكميات" });
  }

  const measurement = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(measurements)
      .values({
        companyId: req.companyId!,
        projectId: req.params.projectId,
        contractId: parsed.data.contractId,
        boqRevisionId: parsed.data.boqRevisionId,
        measurementDate: parsed.data.measurementDate,
        description: parsed.data.description,
        createdBy: req.userId!,
      })
      .returning();

    await recordAuditEvent(tx, {
      companyId: req.companyId!,
      actorUserId: req.userId!,
      action: "measurement.created",
      entityType: "measurement",
      entityId: created.id,
      afterValue: created,
      metadata: { projectId: req.params.projectId, contractId: parsed.data.contractId },
    });

    return created;
  });

  res.status(201).json(measurement);
});

async function findOwnedMeasurement(companyId: string, projectId: string, measurementId: string) {
  return db.query.measurements.findFirst({
    where: and(
      eq(measurements.id, measurementId),
      eq(measurements.projectId, projectId),
      eq(measurements.companyId, companyId),
    ),
  });
}

measurementsRouter.get("/:measurementId", async (req: Request<MeasurementParams>, res: Response) => {
  const measurement = await findOwnedMeasurement(req.companyId!, req.params.projectId, req.params.measurementId);
  if (!measurement) return res.status(404).json({ error: "القياس غير موجود" });

  const lines = await db.query.measurementLines.findMany({
    where: eq(measurementLines.measurementId, measurement.id),
    orderBy: (l, { asc }) => [asc(l.createdAt)],
  });
  res.json({ ...measurement, lines });
});

const lineSchema = z.object({
  boqItemId: z.string().uuid(),
  measuredQuantity: z.coerce.number().nonnegative(),
  notes: z.string().optional(),
});

// A line's boqItem must belong to THIS measurement's own boqRevisionId —
// stricter than Commitment lines (which only require "same project"),
// because quantities are only meaningful within their own revision.
async function validateBoqItemForMeasurement(boqRevisionId: string, boqItemId: string) {
  const item = await db.query.boqItems.findFirst({
    where: and(eq(boqItems.id, boqItemId), eq(boqItems.boqRevisionId, boqRevisionId)),
  });
  if (!item) return { error: "بند جدول الكميات غير موجود" };
  if (item.itemType !== "item" || item.quantity === null) {
    return { error: "لا يمكن القياس على بند تجميعي (قسم) بلا كمية" };
  }
  return { item };
}

// EDITABLE_STATUSES: a measurement's lines can only be mutated while it is
// "draft" or "rejected" — both are pre-submission-equivalent editable
// states (see the schema.ts section comment on the measurement_status
// enum / the reject route below for why "rejected" rejoins the draft flow
// rather than needing its own separate 4th endpoint).
const EDITABLE_STATUSES = ["draft", "rejected"];

// Hardening-1 discipline: the early status check is a fast-path only —
// the actual guarantee against racing a concurrent submit/approve is the
// `SELECT ... FOR UPDATE` lock inside the transaction just before the
// insert.
measurementsRouter.post(
  "/:measurementId/items",
  async (req: Request<MeasurementParams>, res: Response) => {
    const measurement = await findOwnedMeasurement(req.companyId!, req.params.projectId, req.params.measurementId);
    if (!measurement) return res.status(404).json({ error: "القياس غير موجود" });
    if (!EDITABLE_STATUSES.includes(measurement.status)) {
      return res.status(409).json({ error: "لا يمكن إضافة بنود إلى قياس تم إرساله أو اعتماده" });
    }

    const parsed = lineSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

    const { error: refError, item: boqItem } = await validateBoqItemForMeasurement(
      measurement.boqRevisionId,
      parsed.data.boqItemId,
    );
    if (refError) return res.status(404).json({ error: refError });

    const value = boqItem!.rate !== null ? roundMoney(parsed.data.measuredQuantity * Number(boqItem!.rate)) : null;

    const line = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(measurements).where(eq(measurements.id, measurement.id)).for("update");
      if (!locked || !EDITABLE_STATUSES.includes(locked.status)) return null;

      const [inserted] = await tx
        .insert(measurementLines)
        .values({
          companyId: req.companyId!,
          measurementId: measurement.id,
          boqItemId: parsed.data.boqItemId,
          measuredQuantity: String(parsed.data.measuredQuantity),
          value: value !== null ? String(value) : undefined,
          notes: parsed.data.notes,
        })
        .returning();

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "measurement.lineAdded",
        entityType: "measurement_line",
        entityId: inserted.id,
        afterValue: inserted,
        metadata: { measurementId: measurement.id },
      });

      return inserted;
    });

    if (!line) {
      return res.status(409).json({ error: "لا يمكن إضافة بنود إلى قياس تم إرساله أو اعتماده" });
    }
    res.status(201).json(line);
  },
);

measurementsRouter.delete(
  "/:measurementId/items/:lineId",
  async (req: Request<LineParams>, res: Response) => {
    const measurement = await findOwnedMeasurement(req.companyId!, req.params.projectId, req.params.measurementId);
    if (!measurement) return res.status(404).json({ error: "القياس غير موجود" });
    if (!EDITABLE_STATUSES.includes(measurement.status)) {
      return res.status(409).json({ error: "لا يمكن حذف بنود من قياس تم إرساله أو اعتماده" });
    }

    const existing = await db.query.measurementLines.findFirst({
      where: and(eq(measurementLines.id, req.params.lineId), eq(measurementLines.measurementId, measurement.id)),
    });
    if (!existing) return res.status(404).json({ error: "البند غير موجود" });

    const deleted = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(measurements).where(eq(measurements.id, measurement.id)).for("update");
      if (!locked || !EDITABLE_STATUSES.includes(locked.status)) return null;

      const [row] = await tx.delete(measurementLines).where(eq(measurementLines.id, existing.id)).returning();

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "measurement.lineRemoved",
        entityType: "measurement_line",
        entityId: existing.id,
        beforeValue: existing,
        metadata: { measurementId: measurement.id },
      });

      return row;
    });

    if (!deleted) {
      return res.status(409).json({ error: "لا يمكن حذف بنود من قياس تم إرساله أو اعتماده" });
    }
    res.status(204).end();
  },
);

// draft/rejected -> submitted, requires at least one line. Same
// FOR-UPDATE-lock discipline as the item routes above.
measurementsRouter.post(
  "/:measurementId/submit",
  async (req: Request<MeasurementParams>, res: Response) => {
    const measurement = await findOwnedMeasurement(req.companyId!, req.params.projectId, req.params.measurementId);
    if (!measurement) return res.status(404).json({ error: "القياس غير موجود" });

    const result = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(measurements).where(eq(measurements.id, measurement.id)).for("update");
      if (!locked || !EDITABLE_STATUSES.includes(locked.status)) return { outcome: "conflict" as const };

      const lines = await tx.select().from(measurementLines).where(eq(measurementLines.measurementId, measurement.id));
      if (lines.length === 0) return { outcome: "noLines" as const };

      const [updated] = await tx
        .update(measurements)
        .set({
          status: "submitted",
          submittedBy: req.userId!,
          submittedAt: new Date(),
          rejectedBy: null,
          rejectedAt: null,
          rejectionReason: null,
          updatedAt: new Date(),
        })
        .where(eq(measurements.id, measurement.id))
        .returning();

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "measurement.submitted",
        entityType: "measurement",
        entityId: measurement.id,
        beforeValue: { status: locked.status },
        afterValue: { status: "submitted" },
      });

      return { outcome: "ok" as const, measurement: updated };
    });

    if (result.outcome === "conflict") {
      return res.status(409).json({ error: "لا يمكن إرسال هذا القياس في حالته الحالية" });
    }
    if (result.outcome === "noLines") {
      return res.status(400).json({ error: "لا يمكن إرسال قياس بدون بنود" });
    }
    res.json(result.measurement);
  },
);

// The sum of APPROVED measurement lines for a BOQ item, across every
// approved measurement (not just this one) — this IS the canonical
// "cumulative approved quantity," always derived, never stored.
// Exported for routes/ipcs.ts: IPC's certifiable-quantity check needs the
// exact same "how much approved physical progress exists for this BOQ
// item" figure — reusing this rather than re-deriving the same query a
// second time.
export async function sumApprovedQuantity(
  tx: { select: typeof db.select },
  boqItemId: string,
): Promise<number> {
  const rows = await (tx as typeof db)
    .select({ qty: measurementLines.measuredQuantity })
    .from(measurementLines)
    .innerJoin(measurements, eq(measurementLines.measurementId, measurements.id))
    .where(and(eq(measurementLines.boqItemId, boqItemId), eq(measurements.status, "approved")));
  return rows.reduce((sum, r) => sum + Number(r.qty), 0);
}

// Atomic and overrun-safe. The lock strategy: lock the measurement row
// first (guards against a concurrent reject/second-approve of THIS
// measurement), then lock every DISTINCT boqItem referenced by its lines,
// always in a fixed sorted order (by id) — this is what prevents a
// deadlock between two concurrent approvals that reference overlapping
// BOQ items in different orders. Holding those boqItem locks for the rest
// of this transaction is what makes the overrun check race-free: a second
// concurrent approval touching the same boqItem blocks until this one
// commits or rolls back, then re-reads the now-current approved sum —
// never a stale read.
measurementsRouter.post(
  "/:measurementId/approve",
  requirePermission("measurement.approve"),
  async (req: Request<MeasurementParams>, res: Response) => {
    const measurement = await findOwnedMeasurement(req.companyId!, req.params.projectId, req.params.measurementId);
    if (!measurement) return res.status(404).json({ error: "القياس غير موجود" });

    const result = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(measurements).where(eq(measurements.id, measurement.id)).for("update");
      if (!locked || locked.status !== "submitted") return { outcome: "conflict" as const };

      const lines = await tx.select().from(measurementLines).where(eq(measurementLines.measurementId, measurement.id));
      const boqItemIds = [...new Set(lines.map((l) => l.boqItemId))].sort();

      for (const boqItemId of boqItemIds) {
        const [boqItem] = await tx.select().from(boqItems).where(eq(boqItems.id, boqItemId)).for("update");
        if (!boqItem || boqItem.quantity === null) continue; // defensive; validated at line-add time

        const thisMeasurementQty = lines
          .filter((l) => l.boqItemId === boqItemId)
          .reduce((sum, l) => sum + Number(l.measuredQuantity), 0);
        const alreadyApproved = await sumApprovedQuantity(tx, boqItemId);

        if (alreadyApproved + thisMeasurementQty > Number(boqItem.quantity) + 1e-9) {
          return {
            outcome: "overrun" as const,
            boqItemId,
            limit: Number(boqItem.quantity),
            wouldBe: alreadyApproved + thisMeasurementQty,
          };
        }
      }

      const [updated] = await tx
        .update(measurements)
        .set({ status: "approved", approvedBy: req.userId!, approvedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(measurements.id, measurement.id), eq(measurements.status, "submitted")))
        .returning();
      if (!updated) return { outcome: "conflict" as const };

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "measurement.approved",
        entityType: "measurement",
        entityId: measurement.id,
        beforeValue: { status: "submitted" },
        afterValue: { status: "approved" },
      });

      return { outcome: "ok" as const, measurement: updated };
    });

    if (result.outcome === "conflict") {
      return res.status(409).json({ error: "لا يمكن اعتماد قياس ليس بانتظار الاعتماد" });
    }
    if (result.outcome === "overrun") {
      return res.status(409).json({
        error: "الكمية المعتمدة التراكمية ستتجاوز كمية بند جدول الكميات",
        boqItemId: result.boqItemId,
        limit: result.limit,
        wouldBe: result.wouldBe,
      });
    }
    res.json(result.measurement);
  },
);

const rejectSchema = z.object({
  reason: z.string().min(1, "سبب الرفض مطلوب"),
});

// submitted -> rejected. A rejected measurement is functionally
// re-editable exactly like draft (EDITABLE_STATUSES above includes it) —
// deliberately not a distinct "return to draft" 4th endpoint: the same
// submit() route re-submits it once corrected, keeping the rejection
// reason visible on the record until that happens (cleared on the next
// successful submit).
measurementsRouter.post(
  "/:measurementId/reject",
  requirePermission("measurement.approve"),
  async (req: Request<MeasurementParams>, res: Response) => {
    const measurement = await findOwnedMeasurement(req.companyId!, req.params.projectId, req.params.measurementId);
    if (!measurement) return res.status(404).json({ error: "القياس غير موجود" });

    const parsed = rejectSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

    const rejected = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(measurements)
        .set({
          status: "rejected",
          rejectedBy: req.userId!,
          rejectedAt: new Date(),
          rejectionReason: parsed.data.reason,
          updatedAt: new Date(),
        })
        .where(and(eq(measurements.id, measurement.id), eq(measurements.status, "submitted")))
        .returning();
      if (!updated) return null;

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "measurement.rejected",
        entityType: "measurement",
        entityId: measurement.id,
        beforeValue: { status: "submitted" },
        afterValue: { status: "rejected" },
        reason: parsed.data.reason,
      });

      return updated;
    });

    if (!rejected) {
      return res.status(409).json({ error: "لا يمكن رفض قياس ليس بانتظار الاعتماد" });
    }
    res.json(rejected);
  },
);
