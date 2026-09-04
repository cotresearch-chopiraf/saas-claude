import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { dailyLogs, projects } from "../db/schema.js";
import { requirePermission } from "../lib/permissions.js";
import { recordAuditEvent } from "../lib/audit.js";

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

// Slice AA — create stays member-open, matching this domain's
// long-established, deliberate posture (see lib/permissions.ts's comment
// above task.delete/dailyLog.delete). What's new is the audit trail.
dailyLogsRouter.post("/", async (req: Request<ProjectParams>, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const log = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(dailyLogs)
      .values({ projectId: req.params.projectId, note: parsed.data.note, logDate: parsed.data.logDate })
      .returning();
    await recordAuditEvent(tx, {
      companyId: req.companyId!,
      actorUserId: req.userId!,
      action: "dailyLog.created",
      entityType: "dailyLog",
      entityId: created.id,
      afterValue: created,
    });
    return created;
  });

  res.status(201).json(log);
});

// Slice AA — the one irreversible action in this domain, gated to owner
// exactly like project.delete / task.delete.
dailyLogsRouter.delete(
  "/:logId",
  requirePermission("dailyLog.delete"),
  async (req: Request<LogParams>, res: Response) => {
    const existing = await db.query.dailyLogs.findFirst({
      where: and(eq(dailyLogs.id, req.params.logId), eq(dailyLogs.projectId, req.params.projectId)),
    });
    if (!existing) return res.status(404).json({ error: "السجل غير موجود" });

    await db.transaction(async (tx) => {
      await tx.delete(dailyLogs).where(eq(dailyLogs.id, req.params.logId));
      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "dailyLog.deleted",
        entityType: "dailyLog",
        entityId: existing.id,
        beforeValue: existing,
      });
    });

    res.status(204).end();
  },
);
