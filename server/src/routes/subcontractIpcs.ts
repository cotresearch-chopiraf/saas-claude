import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { commitments, commitmentLines, subcontractIpcLines, subcontractIpcs, projects } from "../db/schema.js";
import { requirePermission } from "../lib/permissions.js";
import { recordAuditEvent } from "../lib/audit.js";
import { roundMoney, sumMoney } from "../lib/money.js";

// MIDAD Phase 2 — Subcontractor IPC. See the schema.ts section comment
// above subcontractIpcs for the full architectural rationale: this is a
// completely independent certification ledger from Owner IPC
// (server/src/routes/ipcs.ts) — nothing here ever reads ipcs/ipcLines or
// measurements, and ipcs.ts is never modified by this file. The
// commitment (type="subcontract") remains the single contractual
// ceiling; there is no parallel "subcontracts" table.

type ProjectParams = { projectId: string };
type SubcontractIpcParams = ProjectParams & { id: string };
type LineParams = SubcontractIpcParams & { lineId: string };

export const subcontractIpcsRouter = Router({ mergeParams: true });

// Same tenant/ownership-scoping pattern as every other project sub-resource.
subcontractIpcsRouter.use(async (req: Request<ProjectParams>, res: Response, next: NextFunction) => {
  const project = await db.query.projects.findFirst({
    where: and(eq(projects.id, req.params.projectId), eq(projects.companyId, req.companyId!)),
  });
  if (!project) return res.status(404).json({ error: "المشروع غير موجود" });
  next();
});

subcontractIpcsRouter.get("/", async (req: Request<ProjectParams>, res: Response) => {
  const rows = await db.query.subcontractIpcs.findMany({
    where: eq(subcontractIpcs.projectId, req.params.projectId),
    orderBy: (i, { desc }) => [desc(i.createdAt)],
  });
  res.json(rows);
});

// Eligible commitment states for creating a Subcontractor IPC against —
// matches the existing Commitment lifecycle exactly (draft/pending_approval/
// closed/cancelled are all excluded; certification against an obligation
// that was never actually placed, or is already fully closed out, is not
// a state this domain invents new semantics for). This route never
// mutates commitment.status — only reads it.
const ELIGIBLE_COMMITMENT_STATUSES = ["active", "partially_fulfilled"];

async function findEligibleSubcontractCommitment(
  companyId: string,
  projectId: string,
  commitmentId: string,
): Promise<{ error: string; status: 404 | 409 } | { commitment: typeof commitments.$inferSelect }> {
  const commitment = await db.query.commitments.findFirst({
    where: and(eq(commitments.id, commitmentId), eq(commitments.projectId, projectId), eq(commitments.companyId, companyId)),
  });
  if (!commitment) return { error: "الالتزام غير موجود", status: 404 };
  if (commitment.type !== "subcontract") {
    return { error: "شهادات الدفع للمقاول الباطن تتطلب التزاماً من نوع عقد باطن", status: 409 };
  }
  if (!ELIGIBLE_COMMITMENT_STATUSES.includes(commitment.status)) {
    return { error: "لا يمكن إنشاء شهادة على التزام غير نشط", status: 409 };
  }
  return { commitment };
}

const createSchema = z.object({
  commitmentId: z.string().uuid(),
  periodStart: z.string().min(1, "بداية الفترة مطلوبة"),
  periodEnd: z.string().min(1, "نهاية الفترة مطلوبة"),
  notes: z.string().optional(),
});

// ipcNumber is claimed with the same atomic INSERT...SELECT subquery
// discipline as ipcs.ts's own ipcNumber — scoped per COMMITMENT (this
// certificate is "the Nth for THIS subcontract"), not per project.
subcontractIpcsRouter.post(
  "/",
  requirePermission("subcontractIpc.manage"),
  async (req: Request<ProjectParams>, res: Response) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

    const eligibility = await findEligibleSubcontractCommitment(req.companyId!, req.params.projectId, parsed.data.commitmentId);
    if ("error" in eligibility) return res.status(eligibility.status).json({ error: eligibility.error });

    // Lock the parent commitment row for the duration of the transaction —
    // serializes concurrent Subcontractor IPC creation on the same
    // commitment, same discipline as ipcs.ts locking the parent contract.
    const ipc = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM commitments WHERE id = ${parsed.data.commitmentId} FOR UPDATE`);
      const result = await tx.execute<{ id: string; ipc_number: number; status: string; created_at: string }>(sql`
        INSERT INTO subcontract_ipcs (company_id, project_id, commitment_id, ipc_number, status, period_start, period_end, notes, created_by)
        VALUES (
          ${req.companyId},
          ${req.params.projectId},
          ${parsed.data.commitmentId},
          (SELECT COALESCE(MAX(ipc_number), 0) + 1 FROM subcontract_ipcs WHERE commitment_id = ${parsed.data.commitmentId}),
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
      action: "subcontractIpc.created",
      entityType: "subcontract_ipc",
      entityId: ipc.id,
      afterValue: ipc,
      metadata: { projectId: req.params.projectId, commitmentId: parsed.data.commitmentId },
    });

    res.status(201).json(ipc);
  },
);

async function findOwnedSubcontractIpc(companyId: string, projectId: string, id: string) {
  return db.query.subcontractIpcs.findFirst({
    where: and(eq(subcontractIpcs.id, id), eq(subcontractIpcs.projectId, projectId), eq(subcontractIpcs.companyId, companyId)),
  });
}

subcontractIpcsRouter.get("/:id", async (req: Request<SubcontractIpcParams>, res: Response) => {
  const ipc = await findOwnedSubcontractIpc(req.companyId!, req.params.projectId, req.params.id);
  if (!ipc) return res.status(404).json({ error: "الشهادة غير موجودة" });

  const lines = await db.query.subcontractIpcLines.findMany({
    where: eq(subcontractIpcLines.subcontractIpcId, ipc.id),
    orderBy: (l, { asc }) => [asc(l.sortOrder)],
  });
  res.json({ ...ipc, lines });
});

const lineSchema = z.object({
  commitmentLineId: z.string().uuid(),
  // Exactly one of these is used, depending on whether the referenced
  // commitment line carries quantity+rate or is amount-only — never both,
  // never inferred; see resolveLineValue below.
  currentQuantity: z.coerce.number().nonnegative().optional(),
  currentValue: z.coerce.number().nonnegative().optional(),
  description: z.string().optional(),
  sortOrder: z.coerce.number().int().optional(),
});

const EDITABLE_STATUSES = ["draft", "rejected"];

// Scoped strictly to THIS commitment line, THIS domain's own tables —
// never Owner IPC's ipcLines, never measurements. This is the whole point
// of the separate ledger: Owner IPC certifying against a BOQ item that
// this same commitment line happens to reference must never affect this
// number, and vice versa.
async function certifiedSoFarForCommitmentLine(
  tx: { select: typeof db.select },
  commitmentLineId: string,
): Promise<{ qty: number; value: number }> {
  const rows = await (tx as typeof db)
    .select({ qty: subcontractIpcLines.currentQuantity, value: subcontractIpcLines.currentValue })
    .from(subcontractIpcLines)
    .innerJoin(subcontractIpcs, eq(subcontractIpcLines.subcontractIpcId, subcontractIpcs.id))
    .where(and(eq(subcontractIpcLines.commitmentLineId, commitmentLineId), eq(subcontractIpcs.status, "certified")));
  return {
    qty: rows.reduce((sum, r) => sum + (r.qty !== null ? Number(r.qty) : 0), 0),
    value: sumMoney(rows.map((r) => Number(r.value))),
  };
}

async function validateCommitmentLineForIpc(commitmentId: string, commitmentLineId: string) {
  const line = await db.query.commitmentLines.findFirst({
    where: and(eq(commitmentLines.id, commitmentLineId), eq(commitmentLines.commitmentId, commitmentId)),
  });
  if (!line) return { error: "بند الالتزام غير موجود" };
  return { line };
}

// Quantity/rate path: server computes currentValue = quantity * rate — the
// client-supplied currentValue (if any) is never read for this path.
// Amount-only path: the client-supplied currentValue IS the input, not a
// derived calculation — never a fake quantity/rate is invented for it.
function resolveLineValue(
  commitmentLine: { quantity: string | null; rate: string | null; amount: string },
  data: z.infer<typeof lineSchema>,
): { error: string } | { currentQuantity: number | null; rate: number | null; currentValue: number } {
  const isQuantityRateLine = commitmentLine.quantity !== null && commitmentLine.rate !== null;
  if (isQuantityRateLine) {
    if (data.currentQuantity === undefined) {
      return { error: "الكمية الحالية مطلوبة لهذا البند" };
    }
    const rate = Number(commitmentLine.rate);
    return { currentQuantity: data.currentQuantity, rate, currentValue: roundMoney(data.currentQuantity * rate) };
  }
  if (data.currentValue === undefined) {
    return { error: "قيمة التصديق مطلوبة لهذا البند (بند بمبلغ إجمالي بلا كمية/سعر)" };
  }
  return { currentQuantity: null, rate: null, currentValue: roundMoney(data.currentValue) };
}

// Fast-path only (same discipline as ipcs.ts): the authoritative guarantee
// against overrun and against racing a concurrent submit/certify is the
// re-check inside certify()'s locked transaction.
subcontractIpcsRouter.post(
  "/:id/items",
  requirePermission("subcontractIpc.manage"),
  async (req: Request<SubcontractIpcParams>, res: Response) => {
    const ipc = await findOwnedSubcontractIpc(req.companyId!, req.params.projectId, req.params.id);
    if (!ipc) return res.status(404).json({ error: "الشهادة غير موجودة" });
    if (!EDITABLE_STATUSES.includes(ipc.status)) {
      return res.status(409).json({ error: "لا يمكن إضافة بنود إلى شهادة تم إرسالها أو اعتمادها" });
    }

    const parsed = lineSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

    const { error: refError, line: commitmentLine } = await validateCommitmentLineForIpc(ipc.commitmentId, parsed.data.commitmentLineId);
    if (refError) return res.status(404).json({ error: refError });

    const resolved = resolveLineValue(commitmentLine!, parsed.data);
    if ("error" in resolved) return res.status(400).json({ error: resolved.error });

    const soFar = await certifiedSoFarForCommitmentLine(db, parsed.data.commitmentLineId);
    if (resolved.currentQuantity !== null) {
      const ceiling = commitmentLine!.quantity !== null ? Number(commitmentLine!.quantity) : Infinity;
      if (soFar.qty + resolved.currentQuantity > ceiling + 1e-9) {
        return res.status(400).json({
          error: "الكمية المطلوبة تتجاوز الكمية المتعاقد عليها لهذا البند",
          commitmentLineId: parsed.data.commitmentLineId,
          ceiling,
          alreadyCertified: soFar.qty,
        });
      }
    } else {
      const ceiling = Number(commitmentLine!.amount);
      if (soFar.value + resolved.currentValue > ceiling + 1e-9) {
        return res.status(400).json({
          error: "القيمة المطلوبة تتجاوز المبلغ المتعاقد عليه لهذا البند",
          commitmentLineId: parsed.data.commitmentLineId,
          ceiling,
          alreadyCertified: soFar.value,
        });
      }
    }

    const line = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(subcontractIpcs).where(eq(subcontractIpcs.id, ipc.id)).for("update");
      if (!locked || !EDITABLE_STATUSES.includes(locked.status)) return null;

      const [inserted] = await tx
        .insert(subcontractIpcLines)
        .values({
          companyId: req.companyId!,
          subcontractIpcId: ipc.id,
          commitmentLineId: parsed.data.commitmentLineId,
          description: parsed.data.description ?? commitmentLine!.description,
          currentQuantity: resolved.currentQuantity !== null ? String(resolved.currentQuantity) : null,
          rate: resolved.rate !== null ? String(resolved.rate) : null,
          currentValue: String(resolved.currentValue),
          sortOrder: parsed.data.sortOrder ?? 0,
        })
        .returning();

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "subcontractIpc.lineAdded",
        entityType: "subcontract_ipc_line",
        entityId: inserted.id,
        afterValue: inserted,
        metadata: { subcontractIpcId: ipc.id },
      });

      return inserted;
    });

    if (!line) {
      return res.status(409).json({ error: "لا يمكن إضافة بنود إلى شهادة تم إرسالها أو اعتمادها" });
    }
    res.status(201).json(line);
  },
);

subcontractIpcsRouter.delete(
  "/:id/items/:lineId",
  requirePermission("subcontractIpc.manage"),
  async (req: Request<LineParams>, res: Response) => {
    const ipc = await findOwnedSubcontractIpc(req.companyId!, req.params.projectId, req.params.id);
    if (!ipc) return res.status(404).json({ error: "الشهادة غير موجودة" });
    if (!EDITABLE_STATUSES.includes(ipc.status)) {
      return res.status(409).json({ error: "لا يمكن حذف بنود من شهادة تم إرسالها أو اعتمادها" });
    }

    const existing = await db.query.subcontractIpcLines.findFirst({
      where: and(eq(subcontractIpcLines.id, req.params.lineId), eq(subcontractIpcLines.subcontractIpcId, ipc.id)),
    });
    if (!existing) return res.status(404).json({ error: "البند غير موجود" });

    const deleted = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(subcontractIpcs).where(eq(subcontractIpcs.id, ipc.id)).for("update");
      if (!locked || !EDITABLE_STATUSES.includes(locked.status)) return null;

      const [row] = await tx.delete(subcontractIpcLines).where(eq(subcontractIpcLines.id, existing.id)).returning();

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "subcontractIpc.lineRemoved",
        entityType: "subcontract_ipc_line",
        entityId: existing.id,
        beforeValue: existing,
        metadata: { subcontractIpcId: ipc.id },
      });

      return row;
    });

    if (!deleted) {
      return res.status(409).json({ error: "لا يمكن حذف بنود من شهادة تم إرسالها أو اعتمادها" });
    }
    res.status(204).end();
  },
);

subcontractIpcsRouter.post(
  "/:id/submit",
  requirePermission("subcontractIpc.manage"),
  async (req: Request<SubcontractIpcParams>, res: Response) => {
    const ipc = await findOwnedSubcontractIpc(req.companyId!, req.params.projectId, req.params.id);
    if (!ipc) return res.status(404).json({ error: "الشهادة غير موجودة" });

    const result = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(subcontractIpcs).where(eq(subcontractIpcs.id, ipc.id)).for("update");
      if (!locked || !EDITABLE_STATUSES.includes(locked.status)) return { outcome: "conflict" as const };

      const lines = await tx.select().from(subcontractIpcLines).where(eq(subcontractIpcLines.subcontractIpcId, ipc.id));
      if (lines.length === 0) return { outcome: "noLines" as const };

      const [updated] = await tx
        .update(subcontractIpcs)
        .set({
          status: "submitted",
          submittedBy: req.userId!,
          submittedAt: new Date(),
          rejectedBy: null,
          rejectedAt: null,
          rejectionReason: null,
          updatedAt: new Date(),
        })
        .where(eq(subcontractIpcs.id, ipc.id))
        .returning();

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "subcontractIpc.submitted",
        entityType: "subcontract_ipc",
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

subcontractIpcsRouter.post(
  "/:id/approve",
  requirePermission("subcontractIpc.manage"),
  async (req: Request<SubcontractIpcParams>, res: Response) => {
    const existing = await findOwnedSubcontractIpc(req.companyId!, req.params.projectId, req.params.id);
    if (!existing) return res.status(404).json({ error: "الشهادة غير موجودة" });

    const approved = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(subcontractIpcs)
        .set({ status: "approved", approvedBy: req.userId!, approvedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(subcontractIpcs.id, existing.id), eq(subcontractIpcs.status, "submitted")))
        .returning();
      if (!updated) return null;

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "subcontractIpc.approved",
        entityType: "subcontract_ipc",
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

subcontractIpcsRouter.post(
  "/:id/reject",
  requirePermission("subcontractIpc.manage"),
  async (req: Request<SubcontractIpcParams>, res: Response) => {
    const existing = await findOwnedSubcontractIpc(req.companyId!, req.params.projectId, req.params.id);
    if (!existing) return res.status(404).json({ error: "الشهادة غير موجودة" });

    const parsed = rejectSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

    const rejected = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(subcontractIpcs)
        .set({
          status: "rejected",
          rejectedBy: req.userId!,
          rejectedAt: new Date(),
          rejectionReason: parsed.data.reason,
          updatedAt: new Date(),
        })
        .where(and(eq(subcontractIpcs.id, existing.id), eq(subcontractIpcs.status, "submitted")))
        .returning();
      if (!updated) return null;

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "subcontractIpc.rejected",
        entityType: "subcontract_ipc",
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

// approved -> certified. Lock strategy: lock the subcontract IPC row
// first, then lock every DISTINCT commitmentLine referenced by its lines
// in a fixed sorted order (deadlock-safe, identical in shape to
// ipcs.ts's own certify() — but locking commitment_lines here, NEVER
// boq_items, and reading only this domain's own ledger).
subcontractIpcsRouter.post(
  "/:id/certify",
  requirePermission("subcontractIpc.manage"),
  async (req: Request<SubcontractIpcParams>, res: Response) => {
    const ipc = await findOwnedSubcontractIpc(req.companyId!, req.params.projectId, req.params.id);
    if (!ipc) return res.status(404).json({ error: "الشهادة غير موجودة" });

    const commitment = await db.query.commitments.findFirst({ where: eq(commitments.id, ipc.commitmentId) });

    const result = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(subcontractIpcs).where(eq(subcontractIpcs.id, ipc.id)).for("update");
      if (!locked || locked.status !== "approved") return { outcome: "conflict" as const };

      const lines = await tx.select().from(subcontractIpcLines).where(eq(subcontractIpcLines.subcontractIpcId, ipc.id));
      const commitmentLineIds = [...new Set(lines.map((l) => l.commitmentLineId))].sort();

      const frozenLines: Array<{
        id: string;
        previousCertifiedQuantity: number | null;
        cumulativeQuantity: number | null;
        previousCertifiedValue: number;
        cumulativeValue: number;
      }> = [];

      for (const commitmentLineId of commitmentLineIds) {
        // Locks this commitment line for the rest of the transaction — the
        // actual guarantee, not the fast-path check at line-add time.
        const [commitmentLine] = await tx.select().from(commitmentLines).where(eq(commitmentLines.id, commitmentLineId)).for("update");

        const soFarRows = await tx
          .select({ qty: subcontractIpcLines.currentQuantity, value: subcontractIpcLines.currentValue })
          .from(subcontractIpcLines)
          .innerJoin(subcontractIpcs, eq(subcontractIpcLines.subcontractIpcId, subcontractIpcs.id))
          .where(and(eq(subcontractIpcLines.commitmentLineId, commitmentLineId), eq(subcontractIpcs.status, "certified")));
        const alreadyQty = soFarRows.reduce((sum, r) => sum + (r.qty !== null ? Number(r.qty) : 0), 0);
        const alreadyValue = sumMoney(soFarRows.map((r) => Number(r.value)));

        const linesForThisCommitmentLine = lines.filter((l) => l.commitmentLineId === commitmentLineId);
        const isQuantityRateLine = commitmentLine.quantity !== null && commitmentLine.rate !== null;
        const thisIpcQty = linesForThisCommitmentLine.reduce((sum, l) => sum + (l.currentQuantity !== null ? Number(l.currentQuantity) : 0), 0);
        const thisIpcValue = sumMoney(linesForThisCommitmentLine.map((l) => Number(l.currentValue)));

        if (isQuantityRateLine) {
          const ceiling = Number(commitmentLine.quantity);
          if (alreadyQty + thisIpcQty > ceiling + 1e-9) {
            return { outcome: "overrun" as const, commitmentLineId, ceiling, alreadyCertified: alreadyQty, requested: thisIpcQty };
          }
        } else {
          const ceiling = Number(commitmentLine.amount);
          if (alreadyValue + thisIpcValue > ceiling + 1e-9) {
            return { outcome: "overrun" as const, commitmentLineId, ceiling, alreadyCertified: alreadyValue, requested: thisIpcValue };
          }
        }

        let runningQty = alreadyQty;
        let runningValue = alreadyValue;
        for (const line of linesForThisCommitmentLine) {
          const lineQty = line.currentQuantity !== null ? Number(line.currentQuantity) : null;
          frozenLines.push({
            id: line.id,
            previousCertifiedQuantity: isQuantityRateLine ? runningQty : null,
            cumulativeQuantity: isQuantityRateLine ? runningQty + (lineQty ?? 0) : null,
            previousCertifiedValue: runningValue,
            cumulativeValue: roundMoney(runningValue + Number(line.currentValue)),
          });
          runningQty += lineQty ?? 0;
          runningValue = roundMoney(runningValue + Number(line.currentValue));
        }
      }

      for (const frozen of frozenLines) {
        await tx
          .update(subcontractIpcLines)
          .set({
            previousCertifiedQuantity: frozen.previousCertifiedQuantity !== null ? String(frozen.previousCertifiedQuantity) : null,
            cumulativeQuantity: frozen.cumulativeQuantity !== null ? String(frozen.cumulativeQuantity) : null,
            previousCertifiedValue: String(frozen.previousCertifiedValue),
            cumulativeValue: String(frozen.cumulativeValue),
          })
          .where(eq(subcontractIpcLines.id, frozen.id));
      }

      const grossValue = sumMoney(lines.map((l) => Number(l.currentValue)));
      const retentionPercent = commitment?.retentionPercent !== null && commitment?.retentionPercent !== undefined
        ? Number(commitment.retentionPercent)
        : 0;
      const retentionAmount = roundMoney(grossValue * (retentionPercent / 100));
      // Deliberately not computed from anything — see the schema.ts
      // comment on subcontractIpcs.advanceRecoveryAmount/otherDeductions.
      const advanceRecoveryAmount = 0;
      const otherDeductions = 0;
      const netCertified = roundMoney(grossValue - retentionAmount - advanceRecoveryAmount - otherDeductions);

      if (netCertified < 0) {
        return { outcome: "negativeNet" as const };
      }

      const [updated] = await tx
        .update(subcontractIpcs)
        .set({
          status: "certified",
          certifiedBy: req.userId!,
          certifiedAt: new Date(),
          grossValue: String(grossValue),
          retentionPercent: String(retentionPercent),
          retentionAmount: String(retentionAmount),
          advanceRecoveryAmount: String(advanceRecoveryAmount),
          otherDeductions: String(otherDeductions),
          netCertified: String(netCertified),
          updatedAt: new Date(),
        })
        .where(and(eq(subcontractIpcs.id, ipc.id), eq(subcontractIpcs.status, "approved")))
        .returning();
      if (!updated) return { outcome: "conflict" as const };

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "subcontractIpc.certified",
        entityType: "subcontract_ipc",
        entityId: ipc.id,
        beforeValue: { status: "approved" },
        afterValue: {
          status: "certified",
          grossValue: updated.grossValue,
          retentionPercent: updated.retentionPercent,
          retentionAmount: updated.retentionAmount,
          advanceRecoveryAmount: updated.advanceRecoveryAmount,
          otherDeductions: updated.otherDeductions,
          netCertified: updated.netCertified,
        },
        metadata: { commitmentId: ipc.commitmentId, lineCount: lines.length, commitmentLineIds },
      });

      return { outcome: "ok" as const, ipc: updated };
    });

    if (result.outcome === "conflict") {
      return res.status(409).json({ error: "لا يمكن تصديق شهادة ليست بانتظار التصديق" });
    }
    if (result.outcome === "overrun") {
      return res.status(409).json({
        error: "التصديق سيتجاوز القيمة المتعاقد عليها لهذا البند",
        commitmentLineId: result.commitmentLineId,
        ceiling: result.ceiling,
        alreadyCertified: result.alreadyCertified,
        requested: result.requested,
      });
    }
    if (result.outcome === "negativeNet") {
      return res.status(409).json({ error: "صافي الشهادة المصدَّقة لا يمكن أن يكون سالباً" });
    }
    res.json(result.ipc);
  },
);
