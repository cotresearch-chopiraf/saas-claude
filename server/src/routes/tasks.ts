import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { projects, tasks } from "../db/schema.js";

type ProjectParams = { projectId: string };
type TaskParams = ProjectParams & { taskId: string };

export const tasksRouter = Router({ mergeParams: true });

tasksRouter.use(async (req: Request<ProjectParams>, res: Response, next: NextFunction) => {
  const project = await db.query.projects.findFirst({
    where: and(eq(projects.id, req.params.projectId), eq(projects.companyId, req.companyId!)),
  });
  if (!project) return res.status(404).json({ error: "المشروع غير موجود" });
  next();
});

tasksRouter.get("/", async (req: Request<ProjectParams>, res: Response) => {
  const rows = await db.query.tasks.findMany({
    where: eq(tasks.projectId, req.params.projectId),
    orderBy: (t, { asc }) => [asc(t.createdAt)],
  });
  res.json(rows);
});

const taskSchema = z.object({
  title: z.string().min(2, "عنوان المهمة قصير جداً"),
  assigneeName: z.string().optional(),
  dueDate: z.string().optional(),
});

tasksRouter.post("/", async (req: Request<ProjectParams>, res: Response) => {
  const parsed = taskSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const [task] = await db
    .insert(tasks)
    .values({ projectId: req.params.projectId, ...parsed.data })
    .returning();
  res.status(201).json(task);
});

const updateSchema = taskSchema.partial().extend({
  status: z.enum(["todo", "in_progress", "done"]).optional(),
});

tasksRouter.patch("/:taskId", async (req: Request<TaskParams>, res: Response) => {
  const existing = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, req.params.taskId), eq(tasks.projectId, req.params.projectId)),
  });
  if (!existing) return res.status(404).json({ error: "المهمة غير موجودة" });

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const [updated] = await db
    .update(tasks)
    .set(parsed.data)
    .where(eq(tasks.id, req.params.taskId))
    .returning();
  res.json(updated);
});

tasksRouter.delete("/:taskId", async (req: Request<TaskParams>, res: Response) => {
  const existing = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, req.params.taskId), eq(tasks.projectId, req.params.projectId)),
  });
  if (!existing) return res.status(404).json({ error: "المهمة غير موجودة" });

  await db.delete(tasks).where(eq(tasks.id, req.params.taskId));
  res.status(204).end();
});
