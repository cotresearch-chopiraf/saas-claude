import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { projects, tasks } from "../db/schema.js";
import { requirePermission } from "../lib/permissions.js";
import { recordAuditEvent } from "../lib/audit.js";

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

// Slice AA — create/update stay member-open (requireAuth only, no
// requirePermission gate), matching this domain's long-established,
// deliberate posture (see lib/permissions.ts's own comment above
// task.delete/dailyLog.delete): site-level operational entry, not a
// financial instrument. What's new is the audit trail, matching the same
// recordAuditEvent-inside-a-transaction discipline every other domain in
// this codebase already uses (see routes/contracts.ts).
tasksRouter.post("/", async (req: Request<ProjectParams>, res: Response) => {
  const parsed = taskSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const task = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(tasks)
      .values({ projectId: req.params.projectId, ...parsed.data })
      .returning();
    await recordAuditEvent(tx, {
      companyId: req.companyId!,
      actorUserId: req.userId!,
      action: "task.created",
      entityType: "task",
      entityId: created.id,
      afterValue: created,
    });
    return created;
  });

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

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx.update(tasks).set(parsed.data).where(eq(tasks.id, req.params.taskId)).returning();
    await recordAuditEvent(tx, {
      companyId: req.companyId!,
      actorUserId: req.userId!,
      action: "task.updated",
      entityType: "task",
      entityId: row.id,
      beforeValue: existing,
      afterValue: row,
    });
    return row;
  });

  res.json(updated);
});

// Slice AA — the one irreversible action in this domain, gated to owner
// exactly like project.delete (see lib/permissions.ts). Create/update
// above remain deliberately member-open.
tasksRouter.delete("/:taskId", requirePermission("task.delete"), async (req: Request<TaskParams>, res: Response) => {
  const existing = await db.query.tasks.findFirst({
    where: and(eq(tasks.id, req.params.taskId), eq(tasks.projectId, req.params.projectId)),
  });
  if (!existing) return res.status(404).json({ error: "المهمة غير موجودة" });

  await db.transaction(async (tx) => {
    await tx.delete(tasks).where(eq(tasks.id, req.params.taskId));
    await recordAuditEvent(tx, {
      companyId: req.companyId!,
      actorUserId: req.userId!,
      action: "task.deleted",
      entityType: "task",
      entityId: existing.id,
      beforeValue: existing,
    });
  });

  res.status(204).end();
});
