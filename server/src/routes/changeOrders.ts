import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { changeOrders, projects } from "../db/schema.js";
import { requirePermission } from "../lib/permissions.js";
import { recordAuditEvent } from "../lib/audit.js";
import { logger } from "../lib/logger.js";

type ProjectParams = { projectId: string };
type ChangeOrderParams = ProjectParams & { changeOrderId: string };

export const changeOrdersRouter = Router({ mergeParams: true });

changeOrdersRouter.use(async (req: Request<ProjectParams>, res: Response, next: NextFunction) => {
  const project = await db.query.projects.findFirst({
    where: and(eq(projects.id, req.params.projectId), eq(projects.companyId, req.companyId!)),
  });
  if (!project) return res.status(404).json({ error: "المشروع غير موجود" });
  next();
});

changeOrdersRouter.get("/", async (req: Request<ProjectParams>, res: Response) => {
  const rows = await db.query.changeOrders.findMany({
    where: eq(changeOrders.projectId, req.params.projectId),
    orderBy: (c, { desc }) => [desc(c.createdAt)],
  });
  res.json(rows);
});

const createSchema = z.object({
  title: z.string().min(2, "عنوان أمر التغيير قصير جداً"),
  description: z.string().optional(),
  amountDelta: z.coerce.number(),
});

// Deliberately member-open, same posture as Measurement/Task/DailyLog
// creation elsewhere in this codebase: a change order in "pending" status
// has no financial effect on its own (see the owner-gated PATCH decision
// route below, which is the actual money-moving trust boundary) — it is a
// proposal for an owner to review, not a mutation that itself needs
// protecting. Now audited (previously wasn't), matching every other
// mutation in this file.
changeOrdersRouter.post("/", async (req: Request<ProjectParams>, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const changeOrder = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(changeOrders)
      .values({
        projectId: req.params.projectId,
        title: parsed.data.title,
        description: parsed.data.description,
        amountDelta: String(parsed.data.amountDelta),
      })
      .returning();

    await recordAuditEvent(tx, {
      companyId: req.companyId!,
      actorUserId: req.userId!,
      action: "changeOrder.created",
      entityType: "change_order",
      entityId: created.id,
      afterValue: created,
      metadata: { projectId: req.params.projectId },
    });

    return created;
  });

  res.status(201).json(changeOrder);
});

const decisionSchema = z.object({
  status: z.enum(["approved", "rejected"]),
});

// Approving/rejecting a change order is an owner-only action: it moves real
// budget money and must not be reachable by every company member.
//
// The decision + budget update run inside one transaction, and the decision
// UPDATE itself is conditioned on `status = 'pending'` (not just checked by
// an earlier SELECT) — so two concurrent decisions on the same change order
// can never both succeed, and an approved change order's delta is applied
// via a single atomic SQL increment (`budget_total = budget_total + delta`,
// no read-modify-write in JS) — so two different change orders on the same
// project, approved concurrently, can never lose one delta to the other's
// overwrite.
changeOrdersRouter.patch(
  "/:changeOrderId",
  requirePermission("changeOrder.approve"),
  async (req: Request<ChangeOrderParams>, res: Response) => {
    const parsed = decisionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

    const existing = await db.query.changeOrders.findFirst({
      where: and(
        eq(changeOrders.id, req.params.changeOrderId),
        eq(changeOrders.projectId, req.params.projectId),
      ),
    });
    if (!existing) return res.status(404).json({ error: "أمر التغيير غير موجود" });

    const updated = await db.transaction(async (tx) => {
      const [decided] = await tx
        .update(changeOrders)
        .set({ status: parsed.data.status })
        .where(and(eq(changeOrders.id, req.params.changeOrderId), eq(changeOrders.status, "pending")))
        .returning();
      if (!decided) return null; // another request already decided this one

      if (parsed.data.status === "approved") {
        await tx
          .update(projects)
          .set({ budgetTotal: sql`${projects.budgetTotal} + ${existing.amountDelta}` })
          .where(eq(projects.id, req.params.projectId));
      }

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "changeOrder.decided",
        entityType: "change_order",
        entityId: decided.id,
        beforeValue: { status: existing.status },
        afterValue: { status: decided.status },
        metadata: { projectId: req.params.projectId, amountDelta: decided.amountDelta },
      });

      return decided;
    });

    if (!updated) return res.status(409).json({ error: "تم البتّ في أمر التغيير هذا مسبقاً" });

    logger.info("financial_mutation", {
      action: "changeOrder.decide",
      userId: req.userId,
      companyId: req.companyId,
      changeOrderId: req.params.changeOrderId,
      status: parsed.data.status,
    });
    res.json(updated);
  },
);

// P1 remediation (Final Pre-Launch Audit) — deleting a change order is the
// irreversible action in this domain (same posture as task.delete/
// dailyLog.delete: create/update stay member-open, delete is owner-gated).
// It also used to read `status` via a plain, unlocked SELECT and then
// delete unconditionally: a delete request that read status="pending" could
// still run its DELETE after a concurrent PATCH decision had already
// approved the row and incremented projects.budgetTotal from it, leaving
// that increment permanently orphaned with no record of what justified it.
// Now locked and re-checked exactly like the PATCH decision route above —
// the DELETE itself is conditioned on `status != 'approved'` inside the
// transaction, not just an earlier check.
changeOrdersRouter.delete(
  "/:changeOrderId",
  requirePermission("changeOrder.approve"),
  async (req: Request<ChangeOrderParams>, res: Response) => {
    const existing = await db.query.changeOrders.findFirst({
      where: and(
        eq(changeOrders.id, req.params.changeOrderId),
        eq(changeOrders.projectId, req.params.projectId),
      ),
    });
    if (!existing) return res.status(404).json({ error: "أمر التغيير غير موجود" });

    const deleted = await db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(changeOrders)
        .where(eq(changeOrders.id, req.params.changeOrderId))
        .for("update");
      if (!locked || locked.status === "approved") return null;

      await tx
        .delete(changeOrders)
        .where(and(eq(changeOrders.id, req.params.changeOrderId), sql`${changeOrders.status} != 'approved'`));

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "changeOrder.deleted",
        entityType: "change_order",
        entityId: locked.id,
        beforeValue: locked,
        metadata: { projectId: req.params.projectId },
      });

      return locked;
    });

    if (!deleted) return res.status(409).json({ error: "لا يمكن حذف أمر تغيير مُعتمَد بعد أن أثّر على الميزانية" });
    res.status(204).end();
  },
);
