import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { dailyLogs, projects } from "../db/schema.js";

type ProjectParams = { projectId: string };
type LogParams = ProjectParams & { logId: string };

export const dailyLogsRouter = Router({ mergeParams: true });

dailyLogsRouter.use(async (req: Request<ProjectParams>, res: Response, next: NextFunction) => {
  const project = await db.query.projects.findFirst({
    where: and(eq(projects.id, req.params.projectId), eq(projects.companyId, req.companyId!)),
  });
  if (!project) return res.status(404).json({ error: "المشروع غير موجود" });
  next();
});

dailyLogsRouter.get("/", async (req: Request<ProjectParams>, res: Response) => {
  const rows = await db.query.dailyLogs.findMany({
    where: eq(dailyLogs.projectId, req.params.projectId),
    orderBy: (l, { desc }) => [desc(l.logDate), desc(l.createdAt)],
  });
  res.json(rows);
});

const createSchema = z.object({
  note: z.string().min(2, "الملاحظة قصيرة جداً"),
  logDate: z.string().min(1, "التاريخ مطلوب"),
});

dailyLogsRouter.post("/", async (req: Request<ProjectParams>, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const [log] = await db
    .insert(dailyLogs)
    .values({ projectId: req.params.projectId, note: parsed.data.note, logDate: parsed.data.logDate })
    .returning();
  res.status(201).json(log);
});

dailyLogsRouter.delete("/:logId", async (req: Request<LogParams>, res: Response) => {
  const existing = await db.query.dailyLogs.findFirst({
    where: and(eq(dailyLogs.id, req.params.logId), eq(dailyLogs.projectId, req.params.projectId)),
  });
  if (!existing) return res.status(404).json({ error: "السجل غير موجود" });

  await db.delete(dailyLogs).where(eq(dailyLogs.id, req.params.logId));
  res.status(204).end();
});
