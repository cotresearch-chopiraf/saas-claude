import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { boqItems, boqRevisions, contracts, ipcLines, ipcs, measurementLines, projects } from "../db/schema.js";
import { requirePermission } from "../lib/permissions.js";
import { recordAuditEvent } from "../lib/audit.js";
import { roundMoney, sumMoney } from "../lib/money.js";
import { sumApprovedQuantity } from "./measurements.js";
import { CONTRACT_EXECUTION_BLOCKED_STATUSES } from "./contracts.js";

type ProjectParams = { projectId: string };
type IpcParams = ProjectParams & { ipcId: string };
type LineParams = IpcParams & { lineId: string };

export const ipcsRouter = Router({ mergeParams: true });

// Same tenant/ownership-scoping pattern as every other project sub-resource.
ipcsRouter.use(async (req: Request<ProjectParams>, res: Response, next: NextFunction) => {
  const project = await db.query.projects.findFirst({
    where: and(eq(projects.id, req.params.projectId), eq(projects.companyId, req.companyId!)),
  });
  if (!project) return res.status(404).json({ error: "المشروع غير موجود" });
  next();
});

ipcsRouter.get("/", async (req: Request<ProjectParams>, res: Response) => {
  const rows = await db.query.ipcs.findMany({
    where: eq(ipcs.projectId, req.params.projectId),
    orderBy: (i, { desc }) => [desc(i.createdAt)],
  });
  res.json(rows);
});

const createSchema = z.object({
  contractId: z.string().uuid(),
  boqRevisionId: z.string().uuid(),
  periodStart: z.string().min(1, "بداية الفترة مطلوبة"),
  periodEnd: z.string().min(1, "نهاية الفترة مطلوبة"),
  notes: z.string().optional(),
});

// ipcNumber is claimed with the same atomic INSERT...SELECT subquery
// discipline as boqRevisions.revisionNumber — scoped per CONTRACT (an
// IPC's number is "the Nth certificate for THIS contract", the standard
// construction-industry convention), not company-wide like
// commitments.commitmentNumber.
ipcsRouter.post("/", requirePermission("ipc.manage"), async (req: Request<ProjectParams>, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const contract = await db.query.contracts.findFirst({
    where: and(eq(contracts.id, parsed.data.contractId), eq(contracts.projectId, req.params.projectId)),
  });
  if (!contract) return res.status(404).json({ error: "العقد غير موجود" });
  // Phase 3.2 remediation (CTR-001) — a contract that is completed or
  // terminated must not accept new execution activity.
  if (CONTRACT_EXECUTION_BLOCKED_STATUSES.includes(contract.status)) {
    return res.status(409).json({ error: "لا يمكن إنشاء شهادة على عقد منتهٍ أو ملغى" });
  }

  // Must be a PUBLISHED revision of THIS contract — same discipline as
  // Measurement creation.
  const revision = await db.query.boqRevisions.findFirst({
    where: and(
      eq(boqRevisions.id, parsed.data.boqRevisionId),
      eq(boqRevisions.contractId, parsed.data.contractId),
      eq(boqRevisions.status, "published"),
    ),
  });
  if (!revision) {
    return res.status(400).json({ error: "يجب أن تكون الشهادة على نسخة منشورة من جدول الكميات" });
  }

  // The MAX+1 subquery alone is not race-safe: two concurrent INSERTs can
  // each read the same prior MAX before either commits. Locking the parent
  // contract row for the duration of the transaction serializes concurrent
  // IPC creation on the same contract — same discipline as the contract-row
  // lock added in Phase 1.1 to prevent concurrent boq-revision-publish races.
  const ipc = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM contracts WHERE id = ${parsed.data.contractId} FOR UPDATE`);
    const result = await tx.execute<{
      id: string;
      ipc_number: number;
      status: string;
      created_at: string;
    }>(sql`
      INSERT INTO ipcs (company_id, project_id, contract_id, boq_revision_id, ipc_number, status, period_start, period_end, notes, created_by)
      VALUES (
        ${req.companyId},
        ${req.params.projectId},
        ${parsed.data.contractId},
        ${parsed.data.boqRevisionId},
        (SELECT COALESCE(MAX(ipc_number), 0) + 1 FROM ipcs WHERE contract_id = ${parsed.data.contractId}),
        'draft',
        ${parsed.data.periodStart},
        ${parsed.data.periodEnd},
        ${parsed.data.notes ?? null},
        ${req.userId}
      )
      RETURNING id, ipc_number, status, created_at
    `);
    return result.rows[0];
  });

  await recordAuditEvent(db, {
    companyId: req.companyId!,
    actorUserId: req.userId!,
    action: "ipc.created",
    entityType: "ipc",
    entityId: ipc.id,
    afterValue: ipc,
    metadata: { projectId: req.params.projectId, contractId: parsed.data.contractId },
  });

  res.status(201).json(ipc);
});

async function findOwnedIpc(companyId: string, projectId: string, ipcId: string) {
  return db.query.ipcs.findFirst({
    where: and(eq(ipcs.id, ipcId), eq(ipcs.projectId, projectId), eq(ipcs.companyId, companyId)),
  });
}

ipcsRouter.get("/:ipcId", async (req: Request<IpcParams>, res: Response) => {
  const ipc = await findOwnedIpc(req.companyId!, req.params.projectId, req.params.ipcId);
  if (!ipc) return res.status(404).json({ error: "الشهادة غير موجودة" });

  const lines = await db.query.ipcLines.findMany({
    where: eq(ipcLines.ipcId, ipc.id),
    orderBy: (l, { asc }) => [asc(l.sortOrder)],
  });
  res.json({ ...ipc, lines });
});

const lineSchema = z.object({
  boqItemId: z.string().uuid(),
  currentQuantity: z.coerce.number().nonnegative(),
  description: z.string().optional(),
  sortOrder: z.coerce.number().int().optional(),
});

// Editable only in draft/rejected — same pattern and reasoning as
// Measurement's EDITABLE_STATUSES.
const EDITABLE_STATUSES = ["draft", "rejected"];

// How much of this BOQ item's approved measured quantity has NOT yet been
// claimed by any CERTIFIED ipc line — the certifiable remainder every
// line-add checks against (fast-path) and every certify() re-checks,
// authoritatively, under lock.
async function certifiableRemaining(
  tx: { select: typeof db.select },
  boqItemId: string,
): Promise<number> {
  const approved = await sumApprovedQuantity(tx, boqItemId);
  const certifiedRows = await (tx as typeof db)
    .select({ qty: ipcLines.currentQuantity })
    .from(ipcLines)
    .innerJoin(ipcs, eq(ipcLines.ipcId, ipcs.id))
    .where(and(eq(ipcLines.boqItemId, boqItemId), eq(ipcs.status, "certified")));
  const alreadyCertified = certifiedRows.reduce((sum, r) => sum + Number(r.qty), 0);
  return approved - alreadyCertified;
}

// A line's boqItem must belong to THIS ipc's own boqRevisionId, must be a
// real billable item (not a section) with a rate — IPC cannot value an
// item with no price — and there must be some approved-but-not-yet-
// certified measured quantity for it (never certifiable purely on BOQ
// existence; there must be real approved Measurement evidence backing it).
async function validateBoqItemForIpc(boqRevisionId: string, boqItemId: string) {
  const item = await db.query.boqItems.findFirst({
    where: and(eq(boqItems.id, boqItemId), eq(boqItems.boqRevisionId, boqRevisionId)),
  });
  if (!item) return { error: "بند جدول الكميات غير موجود" };
  if (item.itemType !== "item" || item.rate === null) {
    return { error: "لا يمكن تسعير بند تجميعي (قسم) أو بند بلا سعر" };
  }
  return { item };
}

// Hardening-1 discipline: the early status check is a fast-path only —
// the actual guarantee against racing a concurrent submit/approve is the
// `SELECT ... FOR UPDATE` lock inside the transaction just before the
// insert.
ipcsRouter.post(
  "/:ipcId/items",
  requirePermission("ipc.manage"),
  async (req: Request<IpcParams>, res: Response) => {
    const ipc = await findOwnedIpc(req.companyId!, req.params.projectId, req.params.ipcId);
    if (!ipc) return res.status(404).json({ error: "الشهادة غير موجودة" });
    if (!EDITABLE_STATUSES.includes(ipc.status)) {
      return res.status(409).json({ error: "لا يمكن إضافة بنود إلى شهادة تم إرسالها أو اعتمادها" });
    }

    const parsed = lineSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

    const { error: refError, item: boqItem } = await validateBoqItemForIpc(ipc.boqRevisionId, parsed.data.boqItemId);
    if (refError) return res.status(404).json({ error: refError });

    // Fast-path check (not the authoritative one — certify() re-checks
    // this under lock): reject up front if there's no approved measured
    // quantity at all, or not enough of it, to back this line.
    const remaining = await certifiableRemaining(db, parsed.data.boqItemId);
    if (parsed.data.currentQuantity > remaining + 1e-9) {
      return res.status(400).json({
        error: "الكمية المطلوبة تتجاوز الكمية المعتمدة القابلة للتصديق لهذا البند",
        boqItemId: parsed.data.boqItemId,
        remaining,
      });
    }

    const currentValue = roundMoney(parsed.data.currentQuantity * Number(boqItem!.rate));

    const line = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(ipcs).where(eq(ipcs.id, ipc.id)).for("update");
      if (!locked || !EDITABLE_STATUSES.includes(locked.status)) return null;

      const [inserted] = await tx
        .insert(ipcLines)
        .values({
          companyId: req.companyId!,
          ipcId: ipc.id,
          boqItemId: parsed.data.boqItemId,
          description: parsed.data.description,
          currentQuantity: String(parsed.data.currentQuantity),
          rate: boqItem!.rate!,
          currentValue: String(currentValue),
          sortOrder: parsed.data.sortOrder ?? 0,
        })
        .returning();

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "ipc.lineAdded",
        entityType: "ipc_line",
        entityId: inserted.id,
        afterValue: inserted,
        metadata: { ipcId: ipc.id },
      });

      return inserted;
    });

    if (!line) {
      return res.status(409).json({ error: "لا يمكن إضافة بنود إلى شهادة تم إرسالها أو اعتمادها" });
    }
    res.status(201).json(line);
  },
);

ipcsRouter.delete(
  "/:ipcId/items/:lineId",
  requirePermission("ipc.manage"),
  async (req: Request<LineParams>, res: Response) => {
    const ipc = await findOwnedIpc(req.companyId!, req.params.projectId, req.params.ipcId);
    if (!ipc) return res.status(404).json({ error: "الشهادة غير موجودة" });
    if (!EDITABLE_STATUSES.includes(ipc.status)) {
      return res.status(409).json({ error: "لا يمكن حذف بنود من شهادة تم إرسالها أو اعتمادها" });
    }

    const existing = await db.query.ipcLines.findFirst({
      where: and(eq(ipcLines.id, req.params.lineId), eq(ipcLines.ipcId, ipc.id)),
    });
    if (!existing) return res.status(404).json({ error: "البند غير موجود" });

    const deleted = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(ipcs).where(eq(ipcs.id, ipc.id)).for("update");
      if (!locked || !EDITABLE_STATUSES.includes(locked.status)) return null;

      const [row] = await tx.delete(ipcLines).where(eq(ipcLines.id, existing.id)).returning();

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "ipc.lineRemoved",
        entityType: "ipc_line",
        entityId: existing.id,
        beforeValue: existing,
        metadata: { ipcId: ipc.id },
      });

      return row;
    });

    if (!deleted) {
      return res.status(409).json({ error: "لا يمكن حذف بنود من شهادة تم إرسالها أو اعتمادها" });
    }
    res.status(204).end();
  },
);

// draft/rejected -> submitted, requires at least one line.
ipcsRouter.post(
  "/:ipcId/submit",
  requirePermission("ipc.manage"),
  async (req: Request<IpcParams>, res: Response) => {
    const ipc = await findOwnedIpc(req.companyId!, req.params.projectId, req.params.ipcId);
    if (!ipc) return res.status(404).json({ error: "الشهادة غير موجودة" });

    const result = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(ipcs).where(eq(ipcs.id, ipc.id)).for("update");
      if (!locked || !EDITABLE_STATUSES.includes(locked.status)) return { outcome: "conflict" as const };

      const lines = await tx.select().from(ipcLines).where(eq(ipcLines.ipcId, ipc.id));
      if (lines.length === 0) return { outcome: "noLines" as const };

      const [updated] = await tx
        .update(ipcs)
        .set({
          status: "submitted",
          submittedBy: req.userId!,
          submittedAt: new Date(),
          rejectedBy: null,
          rejectedAt: null,
          rejectionReason: null,
          updatedAt: new Date(),
        })
        .where(eq(ipcs.id, ipc.id))
        .returning();

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "ipc.submitted",
        entityType: "ipc",
        entityId: ipc.id,
        beforeValue: { status: locked.status },
        afterValue: { status: "submitted" },
      });

      return { outcome: "ok" as const, ipc: updated };
    });

    if (result.outcome === "conflict") return res.status(409).json({ error: "لا يمكن إرسال هذه الشهادة في حالتها الحالية" });
    if (result.outcome === "noLines") return res.status(400).json({ error: "لا يمكن إرسال شهادة بدون بنود" });
    res.json(result.ipc);
  },
);

// submitted -> approved. A pure editorial review gate — no shared-budget
// quantity check happens here (that belongs to certify(), the moment
// this IPC actually claims part of the certified-quantity ledger).
ipcsRouter.post(
  "/:ipcId/approve",
  requirePermission("ipc.manage"),
  async (req: Request<IpcParams>, res: Response) => {
    const existing = await findOwnedIpc(req.companyId!, req.params.projectId, req.params.ipcId);
    if (!existing) return res.status(404).json({ error: "الشهادة غير موجودة" });

    const approved = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(ipcs)
        .set({ status: "approved", approvedBy: req.userId!, approvedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(ipcs.id, existing.id), eq(ipcs.status, "submitted")))
        .returning();
      if (!updated) return null;

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "ipc.approved",
        entityType: "ipc",
        entityId: existing.id,
        beforeValue: { status: "submitted" },
        afterValue: { status: "approved" },
      });

      return updated;
    });

    if (!approved) return res.status(409).json({ error: "لا يمكن اعتماد شهادة ليست بانتظار الاعتماد" });
    res.json(approved);
  },
);

const rejectSchema = z.object({
  reason: z.string().min(1, "سبب الرفض مطلوب"),
});

// submitted -> rejected. Functionally rejoins the draft flow exactly like
// Measurement's reject() — no separate "return to draft" endpoint.
ipcsRouter.post(
  "/:ipcId/reject",
  requirePermission("ipc.manage"),
  async (req: Request<IpcParams>, res: Response) => {
    const existing = await findOwnedIpc(req.companyId!, req.params.projectId, req.params.ipcId);
    if (!existing) return res.status(404).json({ error: "الشهادة غير موجودة" });

    const parsed = rejectSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

    const rejected = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(ipcs)
        .set({
          status: "rejected",
          rejectedBy: req.userId!,
          rejectedAt: new Date(),
          rejectionReason: parsed.data.reason,
          updatedAt: new Date(),
        })
        .where(and(eq(ipcs.id, existing.id), eq(ipcs.status, "submitted")))
        .returning();
      if (!updated) return null;

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "ipc.rejected",
        entityType: "ipc",
        entityId: existing.id,
        beforeValue: { status: "submitted" },
        afterValue: { status: "rejected" },
        reason: parsed.data.reason,
      });

      return updated;
    });

    if (!rejected) return res.status(409).json({ error: "لا يمكن رفض شهادة ليست بانتظار الاعتماد" });
    res.json(rejected);
  },
);

// approved -> certified. The one transition that actually claims part of
// the shared certified-quantity ledger, so it is the one that must be
// race-safe against every other concurrent certify() touching an
// overlapping BOQ item — see docs/MIDAD_IPC_MODEL.md for the full
// argument. Lock strategy: lock the IPC row first, then lock every
// DISTINCT boqItem referenced by its lines in a fixed sorted order
// (deadlock-safe, identical to Measurement's approve()), holding those
// locks for the whole transaction so a concurrent certify() on an
// overlapping item blocks and re-reads the true post-commit state rather
// than a stale one.
ipcsRouter.post(
  "/:ipcId/certify",
  requirePermission("ipc.manage"),
  async (req: Request<IpcParams>, res: Response) => {
    const ipc = await findOwnedIpc(req.companyId!, req.params.projectId, req.params.ipcId);
    if (!ipc) return res.status(404).json({ error: "الشهادة غير موجودة" });

    const contract = await db.query.contracts.findFirst({ where: eq(contracts.id, ipc.contractId) });

    const result = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(ipcs).where(eq(ipcs.id, ipc.id)).for("update");
      if (!locked || locked.status !== "approved") return { outcome: "conflict" as const };

      const lines = await tx.select().from(ipcLines).where(eq(ipcLines.ipcId, ipc.id));
      const boqItemIds = [...new Set(lines.map((l) => l.boqItemId))].sort();

      const frozenLines: Array<{
        id: string;
        previousCertifiedQuantity: number;
        previousCertifiedValue: number;
        cumulativeQuantity: number;
      }> = [];

      for (const boqItemId of boqItemIds) {
        // Locks this BOQ item for the rest of the transaction — the
        // actual guarantee, not the fast-path check already done at
        // line-add time.
        await tx.select().from(boqItems).where(eq(boqItems.id, boqItemId)).for("update");

        const approved = await sumApprovedQuantity(tx, boqItemId);
        const certifiedRows = await tx
          .select({ qty: ipcLines.currentQuantity, rate: ipcLines.rate })
          .from(ipcLines)
          .innerJoin(ipcs, eq(ipcLines.ipcId, ipcs.id))
          .where(and(eq(ipcLines.boqItemId, boqItemId), eq(ipcs.status, "certified")));
        const alreadyCertifiedQty = certifiedRows.reduce((sum, r) => sum + Number(r.qty), 0);
        const alreadyCertifiedValue = sumMoney(certifiedRows.map((r) => Number(r.qty) * Number(r.rate)));

        const linesForThisItem = lines.filter((l) => l.boqItemId === boqItemId);
        const thisIpcQty = linesForThisItem.reduce((sum, l) => sum + Number(l.currentQuantity), 0);

        if (alreadyCertifiedQty + thisIpcQty > approved + 1e-9) {
          return { outcome: "overrun" as const, boqItemId, approved, alreadyCertifiedQty, thisIpcQty };
        }

        // Freeze each line's certification-time snapshot. If this IPC has
        // more than one line for the same BOQ item, they share the same
        // "previous" baseline (neither has been certified yet) and each
        // contributes its own quantity to the running cumulative total.
        let runningQty = alreadyCertifiedQty;
        for (const line of linesForThisItem) {
          frozenLines.push({
            id: line.id,
            previousCertifiedQuantity: runningQty,
            previousCertifiedValue: roundMoney(runningQty * Number(line.rate)),
            cumulativeQuantity: runningQty + Number(line.currentQuantity),
          });
          runningQty += Number(line.currentQuantity);
        }
      }

      for (const frozen of frozenLines) {
        await tx
          .update(ipcLines)
          .set({
            previousCertifiedQuantity: String(frozen.previousCertifiedQuantity),
            previousCertifiedValue: String(frozen.previousCertifiedValue),
            cumulativeQuantity: String(frozen.cumulativeQuantity),
          })
          .where(eq(ipcLines.id, frozen.id));
      }

      const grossValue = sumMoney(lines.map((l) => Number(l.currentValue)));
      const retentionPercent = contract?.retentionPercent !== null && contract?.retentionPercent !== undefined
        ? Number(contract.retentionPercent)
        : 0;
      const retentionAmount = roundMoney(grossValue * (retentionPercent / 100));
      // Phase 2C deliberately does not compute these from anything —
      // see the schema.ts comment on ipcs.advanceRecoveryAmount /
      // otherDeductions and docs/MIDAD_IPC_MODEL.md.
      const advanceRecoveryAmount = 0;
      const otherDeductions = 0;
      const netCertified = roundMoney(grossValue - retentionAmount - advanceRecoveryAmount - otherDeductions);

      if (netCertified < 0) {
        return { outcome: "negativeNet" as const };
      }

      const [updated] = await tx
        .update(ipcs)
        .set({
          status: "certified",
          certifiedBy: req.userId!,
          certifiedAt: new Date(),
          grossValue: String(grossValue),
          retentionAmount: String(retentionAmount),
          advanceRecoveryAmount: String(advanceRecoveryAmount),
          otherDeductions: String(otherDeductions),
          netCertified: String(netCertified),
          updatedAt: new Date(),
        })
        .where(and(eq(ipcs.id, ipc.id), eq(ipcs.status, "approved")))
        .returning();
      if (!updated) return { outcome: "conflict" as const };

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "ipc.certified",
        entityType: "ipc",
        entityId: ipc.id,
        beforeValue: { status: "approved" },
        afterValue: {
          status: "certified",
          grossValue: updated.grossValue,
          retentionAmount: updated.retentionAmount,
          advanceRecoveryAmount: updated.advanceRecoveryAmount,
          otherDeductions: updated.otherDeductions,
          netCertified: updated.netCertified,
        },
        metadata: {
          contractId: ipc.contractId,
          boqRevisionId: ipc.boqRevisionId,
          lineCount: lines.length,
          boqItemIds,
        },
      });

      return { outcome: "ok" as const, ipc: updated };
    });

    if (result.outcome === "conflict") {
      return res.status(409).json({ error: "لا يمكن تصديق شهادة ليست بانتظار التصديق" });
    }
    if (result.outcome === "overrun") {
      return res.status(409).json({
        error: "التصديق سيتجاوز الكمية المعتمدة لهذا البند",
        boqItemId: result.boqItemId,
        approved: result.approved,
        alreadyCertified: result.alreadyCertifiedQty,
        requested: result.thisIpcQty,
      });
    }
    if (result.outcome === "negativeNet") {
      return res.status(409).json({ error: "صافي الشهادة المصدَّقة لا يمكن أن يكون سالباً" });
    }
    res.json(result.ipc);
  },
);
