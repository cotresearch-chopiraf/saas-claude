import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { projects, projectTasks, projectTaskDependencies } from "../db/schema.js";
import { requirePermission } from "../lib/permissions.js";
import { recordAuditEvent } from "../lib/audit.js";
import { pgErrorInfo } from "../lib/pgError.js";

// MIDAD Phase C1 — Gantt Scheduling Foundation. The authoritative WBS/task/
// milestone/dependency model, deliberately mounted at
// /api/projects/:projectId/schedule rather than reusing the existing
// /api/projects/:projectId/tasks path — that path already belongs to
// Slice AA's flat to-do-checklist `tasks` table, a structurally different,
// unrelated domain this phase does not touch.
//
// Every mutation stays member-open (create/update), matching the exact
// posture task.delete/dailyLog.delete already established for this class
// of domain (site-level planning entry, not a financial instrument);
// deletion (the one irreversible action, for both a task and a dependency
// edge) requires projectTask.delete (owner-only). Reads are unrestricted
// to any authenticated company member, same split every other domain in
// this codebase already uses.
export const projectScheduleRouter = Router({ mergeParams: true });

type ProjectParams = { projectId: string };
type TaskParams = ProjectParams & { taskId: string };
type DependencyParams = ProjectParams & { dependencyId: string };

// Same tenant/project-ownership pattern as documents.ts/tasks.ts — every
// route below runs only once req.params.projectId is proven to belong to
// req.companyId.
projectScheduleRouter.use(async (req: Request<ProjectParams>, res: Response, next: NextFunction) => {
  const project = await db.query.projects.findFirst({
    where: and(eq(projects.id, req.params.projectId), eq(projects.companyId, req.companyId!)),
  });
  if (!project) return res.status(404).json({ error: "المشروع غير موجود" });
  next();
});

// --- Shapes ---
// Never includes companyId — an internal implementation detail the
// frontend has no use for, same minimalism every other *Response shaper
// in this codebase (documents.ts's toDocumentResponse, etc.) already
// applies.
function toTaskResponse(row: typeof projectTasks.$inferSelect) {
  return {
    id: row.id,
    projectId: row.projectId,
    parentTaskId: row.parentTaskId,
    name: row.name,
    description: row.description,
    taskType: row.taskType,
    status: row.status,
    startDate: row.startDate,
    endDate: row.endDate,
    progressPercent: row.progressPercent,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toDependencyResponse(row: typeof projectTaskDependencies.$inferSelect) {
  return {
    id: row.id,
    projectId: row.projectId,
    predecessorTaskId: row.predecessorTaskId,
    successorTaskId: row.successorTaskId,
    dependencyType: row.dependencyType,
    createdAt: row.createdAt,
  };
}

// --- Date/progress validation shared by create and update ---
// String comparison on YYYY-MM-DD is exact and timezone-independent — the
// same convention routes/payrollPeriods.ts's own periodStart<=periodEnd
// refine already relies on.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateField = z.string().regex(DATE_RE, "تنسيق التاريخ غير صالح");

function validateTaskDates(taskType: "task" | "milestone", startDate: string, endDate: string): string | null {
  if (startDate > endDate) return "تاريخ البداية يجب أن يسبق تاريخ النهاية أو يساويه";
  if (taskType === "milestone" && startDate !== endDate) return "يجب أن يتطابق تاريخ بداية المعلم مع تاريخ نهايته";
  return null;
}

// --- GET /api/projects/:projectId/schedule — full Gantt data in two flat
// queries (never N+1 per task): the frontend builds hierarchy from
// parentTaskId and reads dependencies from the flat edge list itself. ---
projectScheduleRouter.get("/", async (req: Request<ProjectParams>, res: Response) => {
  const [taskRows, dependencyRows] = await Promise.all([
    db.query.projectTasks.findMany({
      where: eq(projectTasks.projectId, req.params.projectId),
      orderBy: (t, { asc }) => [asc(t.sortOrder), asc(t.createdAt)],
    }),
    db.query.projectTaskDependencies.findMany({
      where: eq(projectTaskDependencies.projectId, req.params.projectId),
    }),
  ]);
  res.json({
    tasks: taskRows.map(toTaskResponse),
    dependencies: dependencyRows.map(toDependencyResponse),
  });
});

// Resolves and validates a client-supplied parentTaskId: it must exist,
// belong to THIS project (never trusted as-is), and — on update — must not
// create a cycle in the WBS hierarchy (the candidate parent cannot be the
// task itself or one of its own descendants).
async function resolveParent(
  projectId: string,
  parentTaskId: string | null | undefined,
  selfTaskId: string | null,
): Promise<{ ok: true; parentTaskId: string | null } | { ok: false; error: string }> {
  if (!parentTaskId) return { ok: true, parentTaskId: null };
  if (parentTaskId === selfTaskId) return { ok: false, error: "لا يمكن أن تكون المهمة أباً لنفسها" };

  const parent = await db.query.projectTasks.findFirst({
    where: and(eq(projectTasks.id, parentTaskId), eq(projectTasks.projectId, projectId)),
  });
  if (!parent) return { ok: false, error: "المهمة الأب غير موجودة أو تنتمي لمشروع آخر" };

  if (selfTaskId) {
    // Bounded walk up the candidate parent's own ancestor chain — if we
    // ever reach selfTaskId, assigning this parent would create a cycle.
    let current: typeof parent | undefined = parent;
    let steps = 0;
    while (current?.parentTaskId && steps < 1000) {
      if (current.parentTaskId === selfTaskId) {
        return { ok: false, error: "هذا التعيين يُنشئ دورة غير صالحة في التسلسل الهرمي" };
      }
      current = await db.query.projectTasks.findFirst({ where: eq(projectTasks.id, current.parentTaskId) });
      steps++;
    }
  }

  return { ok: true, parentTaskId: parent.id };
}

const createTaskSchema = z.object({
  name: z.string().min(2, "اسم المهمة قصير جداً"),
  description: z.string().optional(),
  taskType: z.enum(["task", "milestone"]).default("task"),
  status: z.enum(["not_started", "in_progress", "completed", "on_hold"]).default("not_started"),
  startDate: dateField,
  endDate: dateField,
  progressPercent: z.number().int().min(0, "نسبة الإنجاز لا يمكن أن تقل عن 0").max(100, "نسبة الإنجاز لا يمكن أن تتجاوز 100").default(0),
  parentTaskId: z.string().uuid().nullable().optional(),
  sortOrder: z.number().int().default(0),
});

projectScheduleRouter.post("/tasks", async (req: Request<ProjectParams>, res: Response) => {
  const parsed = createTaskSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const dateError = validateTaskDates(parsed.data.taskType, parsed.data.startDate, parsed.data.endDate);
  if (dateError) return res.status(400).json({ error: dateError });

  const parentResult = await resolveParent(req.params.projectId, parsed.data.parentTaskId, null);
  if (!parentResult.ok) return res.status(400).json({ error: parentResult.error });

  const task = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(projectTasks)
      .values({
        companyId: req.companyId!,
        projectId: req.params.projectId,
        parentTaskId: parentResult.parentTaskId,
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        taskType: parsed.data.taskType,
        status: parsed.data.status,
        startDate: parsed.data.startDate,
        endDate: parsed.data.endDate,
        progressPercent: parsed.data.progressPercent,
        sortOrder: parsed.data.sortOrder,
        createdBy: req.userId!,
      })
      .returning();

    await recordAuditEvent(tx, {
      companyId: req.companyId!,
      actorUserId: req.userId!,
      action: "projectTask.created",
      entityType: "project_task",
      entityId: created.id,
      afterValue: toTaskResponse(created),
      metadata: { projectId: req.params.projectId },
    });

    return created;
  });

  res.status(201).json(toTaskResponse(task));
});

const updateTaskSchema = z.object({
  name: z.string().min(2, "اسم المهمة قصير جداً").optional(),
  description: z.string().nullable().optional(),
  taskType: z.enum(["task", "milestone"]).optional(),
  status: z.enum(["not_started", "in_progress", "completed", "on_hold"]).optional(),
  startDate: dateField.optional(),
  endDate: dateField.optional(),
  progressPercent: z.number().int().min(0, "نسبة الإنجاز لا يمكن أن تقل عن 0").max(100, "نسبة الإنجاز لا يمكن أن تتجاوز 100").optional(),
  parentTaskId: z.string().uuid().nullable().optional(),
  sortOrder: z.number().int().optional(),
});

projectScheduleRouter.patch("/tasks/:taskId", async (req: Request<TaskParams>, res: Response) => {
  const existing = await db.query.projectTasks.findFirst({
    where: and(eq(projectTasks.id, req.params.taskId), eq(projectTasks.projectId, req.params.projectId)),
  });
  if (!existing) return res.status(404).json({ error: "المهمة غير موجودة" });

  const parsed = updateTaskSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const nextTaskType = parsed.data.taskType ?? existing.taskType;
  const nextStartDate = parsed.data.startDate ?? existing.startDate;
  const nextEndDate = parsed.data.endDate ?? existing.endDate;
  const dateError = validateTaskDates(nextTaskType, nextStartDate, nextEndDate);
  if (dateError) return res.status(400).json({ error: dateError });

  let nextParentTaskId = existing.parentTaskId;
  if (parsed.data.parentTaskId !== undefined) {
    const parentResult = await resolveParent(req.params.projectId, parsed.data.parentTaskId, existing.id);
    if (!parentResult.ok) return res.status(400).json({ error: parentResult.error });
    nextParentTaskId = parentResult.parentTaskId;
  }

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(projectTasks)
      .set({
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
        taskType: nextTaskType,
        ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
        startDate: nextStartDate,
        endDate: nextEndDate,
        ...(parsed.data.progressPercent !== undefined ? { progressPercent: parsed.data.progressPercent } : {}),
        parentTaskId: nextParentTaskId,
        ...(parsed.data.sortOrder !== undefined ? { sortOrder: parsed.data.sortOrder } : {}),
        updatedAt: new Date(),
      })
      .where(eq(projectTasks.id, req.params.taskId))
      .returning();

    await recordAuditEvent(tx, {
      companyId: req.companyId!,
      actorUserId: req.userId!,
      action: "projectTask.updated",
      entityType: "project_task",
      entityId: row.id,
      beforeValue: toTaskResponse(existing),
      afterValue: toTaskResponse(row),
      metadata: { projectId: req.params.projectId },
    });

    return row;
  });

  res.json(toTaskResponse(updated));
});

// The one irreversible action in this domain — owner-only, mirroring
// task.delete/dailyLog.delete exactly. project_task_dependencies rows
// referencing this task are removed automatically by the FK's own ON
// DELETE CASCADE (see db/schema.ts) — no explicit cleanup query needed,
// and no orphan dependency row can ever remain.
projectScheduleRouter.delete(
  "/tasks/:taskId",
  requirePermission("projectTask.delete"),
  async (req: Request<TaskParams>, res: Response) => {
    const existing = await db.query.projectTasks.findFirst({
      where: and(eq(projectTasks.id, req.params.taskId), eq(projectTasks.projectId, req.params.projectId)),
    });
    if (!existing) return res.status(404).json({ error: "المهمة غير موجودة" });

    await db.transaction(async (tx) => {
      await tx.delete(projectTasks).where(eq(projectTasks.id, req.params.taskId));
      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "projectTask.deleted",
        entityType: "project_task",
        entityId: existing.id,
        beforeValue: toTaskResponse(existing),
        metadata: { projectId: req.params.projectId },
      });
    });

    res.status(204).end();
  },
);

// --- Dependencies ---

// Adding predecessorTaskId -> successorTaskId would create a cycle iff
// predecessorTaskId is already reachable FROM successorTaskId through the
// project's existing edges (a simple, deterministic DFS — no scheduling
// engine, per the master prompt's own explicit boundary).
async function wouldCreateCycle(projectId: string, predecessorTaskId: string, successorTaskId: string): Promise<boolean> {
  const edges = await db.query.projectTaskDependencies.findMany({
    where: eq(projectTaskDependencies.projectId, projectId),
  });
  const successorsOf = new Map<string, string[]>();
  for (const edge of edges) {
    const list = successorsOf.get(edge.predecessorTaskId) ?? [];
    list.push(edge.successorTaskId);
    successorsOf.set(edge.predecessorTaskId, list);
  }

  const stack = [successorTaskId];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === predecessorTaskId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of successorsOf.get(current) ?? []) stack.push(next);
  }
  return false;
}

const createDependencySchema = z.object({
  predecessorTaskId: z.string().uuid(),
  successorTaskId: z.string().uuid(),
});

projectScheduleRouter.post("/dependencies", async (req: Request<ProjectParams>, res: Response) => {
  const parsed = createDependencySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { predecessorTaskId, successorTaskId } = parsed.data;

  if (predecessorTaskId === successorTaskId) {
    return res.status(400).json({ error: "لا يمكن ربط المهمة بنفسها" });
  }

  // Both tasks must exist, belong to THIS project, AND this company —
  // scoping by req.params.projectId (already tenant-verified by this
  // router's own project-ownership middleware) blocks cross-project and
  // cross-tenant task ids identically (a foreign task id simply never
  // matches), and the explicit companyId check below is defense-in-depth
  // on top of that.
  const [predecessor, successor] = await Promise.all([
    db.query.projectTasks.findFirst({
      where: and(eq(projectTasks.id, predecessorTaskId), eq(projectTasks.projectId, req.params.projectId), eq(projectTasks.companyId, req.companyId!)),
    }),
    db.query.projectTasks.findFirst({
      where: and(eq(projectTasks.id, successorTaskId), eq(projectTasks.projectId, req.params.projectId), eq(projectTasks.companyId, req.companyId!)),
    }),
  ]);
  if (!predecessor || !successor) {
    return res.status(400).json({ error: "إحدى المهمتين غير موجودة أو لا تنتمي لهذا المشروع" });
  }

  if (await wouldCreateCycle(req.params.projectId, predecessorTaskId, successorTaskId)) {
    return res.status(400).json({ error: "هذا الربط يُنشئ دورة غير صالحة في تسلسل المهام" });
  }

  try {
    const dependency = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(projectTaskDependencies)
        .values({
          companyId: req.companyId!,
          projectId: req.params.projectId,
          predecessorTaskId,
          successorTaskId,
          createdBy: req.userId!,
        })
        .returning();

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "projectTaskDependency.created",
        entityType: "project_task_dependency",
        entityId: created.id,
        afterValue: toDependencyResponse(created),
        metadata: { projectId: req.params.projectId },
      });

      return created;
    });

    res.status(201).json(toDependencyResponse(dependency));
  } catch (err) {
    if (pgErrorInfo(err).code === "23505") {
      return res.status(409).json({ error: "هذا الربط موجود مسبقاً" });
    }
    throw err;
  }
});

projectScheduleRouter.delete(
  "/dependencies/:dependencyId",
  requirePermission("projectTask.delete"),
  async (req: Request<DependencyParams>, res: Response) => {
    const existing = await db.query.projectTaskDependencies.findFirst({
      where: and(eq(projectTaskDependencies.id, req.params.dependencyId), eq(projectTaskDependencies.projectId, req.params.projectId)),
    });
    if (!existing) return res.status(404).json({ error: "الربط غير موجود" });

    await db.transaction(async (tx) => {
      await tx.delete(projectTaskDependencies).where(eq(projectTaskDependencies.id, req.params.dependencyId));
      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "projectTaskDependency.deleted",
        entityType: "project_task_dependency",
        entityId: existing.id,
        beforeValue: toDependencyResponse(existing),
        metadata: { projectId: req.params.projectId },
      });
    });

    res.status(204).end();
  },
);
