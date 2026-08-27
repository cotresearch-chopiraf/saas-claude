import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { changeOrders, projects } from "../db/schema.js";

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

// Approving shifts the project's budget by amountDelta exactly once — a
// change order can only move out of "pending", so double-approval can't
// double-apply the delta.
changeOrdersRouter.patch("/:changeOrderId", async (req: Request<ChangeOrderParams>, res: Response) => {
  const parsed = decisionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const existing = await db.query.changeOrders.findFirst({
    where: and(
      eq(changeOrders.id, req.params.changeOrderId),
      eq(changeOrders.projectId, req.params.projectId),
    ),
  });
  if (!existing) return res.status(404).json({ error: "أمر التغيير غير موجود" });
  if (existing.status !== "pending") {
    return res.status(409).json({ error: "تم البتّ في أمر التغيير هذا مسبقاً" });
  }

  const [updated] = await db
    .update(changeOrders)
    .set({ status: parsed.data.status })
    .where(eq(changeOrders.id, req.params.changeOrderId))
    .returning();

  if (parsed.data.status === "approved") {
    const project = await db.query.projects.findFirst({
      where: eq(projects.id, req.params.projectId),
    });
    const newTotal = Number(project!.budgetTotal) + Number(existing.amountDelta);
    await db.update(projects).set({ budgetTotal: String(newTotal) }).where(eq(projects.id, req.params.projectId));
  }

  res.json(updated);
});

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
