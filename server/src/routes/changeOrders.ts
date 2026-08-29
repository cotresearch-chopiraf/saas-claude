import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { changeOrders, projects } from "../db/schema.js";
import { requirePermission } from "../lib/permissions.js";
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

changeOrdersRouter.post("/", async (req: Request<ProjectParams>, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const [changeOrder] = await db
    .insert(changeOrders)
    .values({
      projectId: req.params.projectId,
      title: parsed.data.title,
      description: parsed.data.description,
      amountDelta: String(parsed.data.amountDelta),
    })
    .returning();
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

changeOrdersRouter.delete("/:changeOrderId", async (req: Request<ChangeOrderParams>, res: Response) => {
  const existing = await db.query.changeOrders.findFirst({
    where: and(
      eq(changeOrders.id, req.params.changeOrderId),
      eq(changeOrders.projectId, req.params.projectId),
    ),
  });
  if (!existing) return res.status(404).json({ error: "أمر التغيير غير موجود" });
  if (existing.status === "approved") {
    return res.status(409).json({ error: "لا يمكن حذف أمر تغيير مُعتمَد بعد أن أثّر على الميزانية" });
  }

  await db.delete(changeOrders).where(eq(changeOrders.id, req.params.changeOrderId));
  res.status(204).end();
});
