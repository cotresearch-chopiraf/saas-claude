import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { and, eq, lt, ne } from "drizzle-orm";
import { db } from "../db/client.js";
import { projects, projectPunchItems, users } from "../db/schema.js";
import { requirePermission } from "../lib/permissions.js";
import { recordAuditEvent } from "../lib/audit.js";

// MIDAD Phase C2 — Punch Lists / Site Deficiencies. A dedicated domain,
// deliberately NOT merged into the flat Slice AA `tasks` checklist (no
// companyId column, a free-text assignee, no resolution/verification/
// closure concept) or C1's `project_tasks` (schedule data toward a plan —
// a structurally different concept from a site deficiency). See
// db/schema.ts's own file-level comment on projectPunchItems for the full
// discovery rationale.
//
// Create/update/status-transition stay member-open (site-level field
// entry, not a financial instrument — the same posture task.delete/
// dailyLog.delete/projectTask.delete already document); deletion requires
// punchItem.delete (owner-only). INTERNAL ONLY — nothing here is ever
// reachable from /api/portal/*, and the response shape below has no
// clientVisible-style field of any kind.
export const punchItemsRouter = Router({ mergeParams: true });

type ProjectParams = { projectId: string };
type ItemParams = ProjectParams & { id: string };

// Same tenant/project-ownership pattern as documents.ts/tasks.ts/
// projectSchedule.ts.
punchItemsRouter.use(async (req: Request<ProjectParams>, res: Response, next: NextFunction) => {
  const project = await db.query.projects.findFirst({
    where: and(eq(projects.id, req.params.projectId), eq(projects.companyId, req.companyId!)),
  });
  if (!project) return res.status(404).json({ error: "المشروع غير موجود" });
  next();
});

// --- Response shape ---
// No companyId (internal detail), and deliberately no joined user objects
// — only bare ids. The client resolves names via the already-existing,
// already-safe GET /api/company/members (Team.tsx's own data source),
// so this route never has to touch a users row at all, and can never leak
// passwordHash or any other sensitive user column by construction.
function toPunchItemResponse(row: typeof projectPunchItems.$inferSelect) {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    description: row.description,
    location: row.location,
    priority: row.priority,
    status: row.status,
    assignedToUserId: row.assignedToUserId,
    dueDate: row.dueDate,
    resolutionDescription: row.resolutionDescription,
    resolvedAt: row.resolvedAt,
    resolvedByUserId: row.resolvedByUserId,
    verifiedAt: row.verifiedAt,
    verifiedByUserId: row.verifiedByUserId,
    closedAt: row.closedAt,
    closedByUserId: row.closedByUserId,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateField = z.string().regex(DATE_RE, "تنسيق التاريخ غير صالح");

function todayDateOnly(): string {
  return new Date().toISOString().slice(0, 10);
}

// Validates a client-supplied assignedToUserId server-side: it must exist,
// belong to THIS company (never trusted as-is — blocks cross-company
// assignment), and be an active account. Returns null for "no assignee"
// (a valid, explicit choice), or an error string.
async function resolveAssignee(
  companyId: string,
  assignedToUserId: string | null | undefined,
): Promise<{ ok: true; assignedToUserId: string | null } | { ok: false; error: string }> {
  if (!assignedToUserId) return { ok: true, assignedToUserId: null };
  const user = await db.query.users.findFirst({
    where: and(eq(users.id, assignedToUserId), eq(users.companyId, companyId), eq(users.status, "active")),
  });
  if (!user) return { ok: false, error: "المستخدم المعيَّن غير موجود أو لا ينتمي لهذه الشركة" };
  return { ok: true, assignedToUserId: user.id };
}

// --- List (with server-side filters) ---
const VALID_STATUSES = ["open", "assigned", "in_progress", "resolved", "verified", "closed"] as const;
const VALID_PRIORITIES = ["low", "medium", "high", "critical"] as const;

punchItemsRouter.get("/", async (req: Request<ProjectParams>, res: Response) => {
  const conditions = [eq(projectPunchItems.projectId, req.params.projectId)];

  const statusQuery = req.query.status;
  if (typeof statusQuery === "string" && (VALID_STATUSES as readonly string[]).includes(statusQuery)) {
    conditions.push(eq(projectPunchItems.status, statusQuery as (typeof VALID_STATUSES)[number]));
  }
  const priorityQuery = req.query.priority;
  if (typeof priorityQuery === "string" && (VALID_PRIORITIES as readonly string[]).includes(priorityQuery)) {
    conditions.push(eq(projectPunchItems.priority, priorityQuery as (typeof VALID_PRIORITIES)[number]));
  }
  const assignedToQuery = req.query.assignedToUserId;
  if (typeof assignedToQuery === "string") {
    conditions.push(eq(projectPunchItems.assignedToUserId, assignedToQuery));
  }
  if (req.query.overdue === "true") {
    conditions.push(lt(projectPunchItems.dueDate, todayDateOnly()));
    conditions.push(ne(projectPunchItems.status, "closed"));
  }

  const rows = await db.query.projectPunchItems.findMany({
    where: and(...conditions),
    orderBy: (p, { desc }) => [desc(p.createdAt)],
  });
  res.json(rows.map(toPunchItemResponse));
});

punchItemsRouter.get("/:id", async (req: Request<ItemParams>, res: Response) => {
  const item = await db.query.projectPunchItems.findFirst({
    where: and(eq(projectPunchItems.id, req.params.id), eq(projectPunchItems.projectId, req.params.projectId)),
  });
  if (!item) return res.status(404).json({ error: "الملاحظة غير موجودة" });
  res.json(toPunchItemResponse(item));
});

// --- Create ---
// Status is never accepted from the client — it is entirely derived
// server-side: ASSIGNED when an assignee is supplied, otherwise OPEN, per
// this phase's own explicit "do not force unnecessary intermediate
// actions" instruction.
const createSchema = z.object({
  title: z.string().min(2, "العنوان قصير جداً").max(200, "العنوان طويل جداً"),
  description: z.string().max(5000, "الوصف طويل جداً").optional(),
  location: z.string().max(200, "الموقع طويل جداً").optional(),
  priority: z.enum(VALID_PRIORITIES).default("medium"),
  assignedToUserId: z.string().uuid().nullable().optional(),
  dueDate: dateField.nullable().optional(),
});

punchItemsRouter.post("/", async (req: Request<ProjectParams>, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const assigneeResult = await resolveAssignee(req.companyId!, parsed.data.assignedToUserId);
  if (!assigneeResult.ok) return res.status(400).json({ error: assigneeResult.error });

  const item = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(projectPunchItems)
      .values({
        companyId: req.companyId!,
        projectId: req.params.projectId,
        title: parsed.data.title,
        description: parsed.data.description ?? null,
        location: parsed.data.location ?? null,
        priority: parsed.data.priority,
        status: assigneeResult.assignedToUserId ? "assigned" : "open",
        assignedToUserId: assigneeResult.assignedToUserId,
        dueDate: parsed.data.dueDate ?? null,
        createdBy: req.userId!,
      })
      .returning();

    await recordAuditEvent(tx, {
      companyId: req.companyId!,
      actorUserId: req.userId!,
      action: "punchItem.created",
      entityType: "project_punch_item",
      entityId: created.id,
      afterValue: toPunchItemResponse(created),
      metadata: { projectId: req.params.projectId },
    });

    return created;
  });

  res.status(201).json(toPunchItemResponse(item));
});

// --- Update (generic fields only) ---
// .strict() rejects any unknown key outright (400), rather than silently
// stripping it — an explicit "no" to a client attempting to inject
// status/resolvedAt/resolvedByUserId/verifiedAt/verifiedByUserId/
// closedAt/closedByUserId/resolutionDescription through this endpoint.
// None of those seven system-owned fields appear in this schema at all;
// they are controlled exclusively by the POST .../status handler below.
const updateSchema = z
  .object({
    title: z.string().min(2, "العنوان قصير جداً").max(200, "العنوان طويل جداً").optional(),
    description: z.string().max(5000, "الوصف طويل جداً").nullable().optional(),
    location: z.string().max(200, "الموقع طويل جداً").nullable().optional(),
    priority: z.enum(VALID_PRIORITIES).optional(),
    assignedToUserId: z.string().uuid().nullable().optional(),
    dueDate: dateField.nullable().optional(),
  })
  .strict();

punchItemsRouter.patch("/:id", async (req: Request<ItemParams>, res: Response) => {
  const existing = await db.query.projectPunchItems.findFirst({
    where: and(eq(projectPunchItems.id, req.params.id), eq(projectPunchItems.projectId, req.params.projectId)),
  });
  if (!existing) return res.status(404).json({ error: "الملاحظة غير موجودة" });

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  let nextAssignedToUserId = existing.assignedToUserId;
  if (parsed.data.assignedToUserId !== undefined) {
    const assigneeResult = await resolveAssignee(req.companyId!, parsed.data.assignedToUserId);
    if (!assigneeResult.ok) return res.status(400).json({ error: assigneeResult.error });
    nextAssignedToUserId = assigneeResult.assignedToUserId;
  }

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(projectPunchItems)
      .set({
        ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
        ...(parsed.data.location !== undefined ? { location: parsed.data.location } : {}),
        ...(parsed.data.priority !== undefined ? { priority: parsed.data.priority } : {}),
        assignedToUserId: nextAssignedToUserId,
        ...(parsed.data.dueDate !== undefined ? { dueDate: parsed.data.dueDate } : {}),
        updatedAt: new Date(),
      })
      .where(eq(projectPunchItems.id, req.params.id))
      .returning();

    await recordAuditEvent(tx, {
      companyId: req.companyId!,
      actorUserId: req.userId!,
      action: "punchItem.updated",
      entityType: "project_punch_item",
      entityId: row.id,
      beforeValue: toPunchItemResponse(existing),
      afterValue: toPunchItemResponse(row),
      metadata: { projectId: req.params.projectId },
    });

    return row;
  });

  res.json(toPunchItemResponse(updated));
});

// The one irreversible action in this domain — owner-only, mirroring
// task.delete/dailyLog.delete/projectTask.delete exactly.
punchItemsRouter.delete(
  "/:id",
  requirePermission("punchItem.delete"),
  async (req: Request<ItemParams>, res: Response) => {
    const existing = await db.query.projectPunchItems.findFirst({
      where: and(eq(projectPunchItems.id, req.params.id), eq(projectPunchItems.projectId, req.params.projectId)),
    });
    if (!existing) return res.status(404).json({ error: "الملاحظة غير موجودة" });

    await db.transaction(async (tx) => {
      await tx.delete(projectPunchItems).where(eq(projectPunchItems.id, req.params.id));
      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "punchItem.deleted",
        entityType: "project_punch_item",
        entityId: existing.id,
        beforeValue: toPunchItemResponse(existing),
        metadata: { projectId: req.params.projectId },
      });
    });

    res.status(204).end();
  },
);

// --- Status lifecycle ---
// The canonical transition table this phase's own master prompt
// specifies, including both documented reopen edges (RESOLVED/VERIFIED ->
// IN_PROGRESS). "closed" is terminal — no outgoing edges.
const ALLOWED_TRANSITIONS: Record<(typeof VALID_STATUSES)[number], readonly (typeof VALID_STATUSES)[number][]> = {
  open: ["assigned", "in_progress"],
  assigned: ["in_progress", "open"],
  in_progress: ["resolved", "open"],
  resolved: ["verified", "in_progress"],
  verified: ["closed", "in_progress"],
  closed: [],
};

const statusTransitionSchema = z
  .object({
    status: z.enum(VALID_STATUSES),
    resolutionDescription: z.string().min(2, "وصف المعالجة قصير جداً").max(5000, "وصف المعالجة طويل جداً").optional(),
  })
  .strict();

punchItemsRouter.post("/:id/status", async (req: Request<ItemParams>, res: Response) => {
  const existing = await db.query.projectPunchItems.findFirst({
    where: and(eq(projectPunchItems.id, req.params.id), eq(projectPunchItems.projectId, req.params.projectId)),
  });
  if (!existing) return res.status(404).json({ error: "الملاحظة غير موجودة" });

  const parsed = statusTransitionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const nextStatus = parsed.data.status;

  if (!ALLOWED_TRANSITIONS[existing.status].includes(nextStatus)) {
    return res.status(400).json({ error: `لا يمكن الانتقال من هذه الحالة إلى الحالة المطلوبة` });
  }

  if (nextStatus === "assigned" && !existing.assignedToUserId) {
    return res.status(400).json({ error: "يجب تعيين مسؤول أولاً قبل تحديد الحالة كمعيَّنة" });
  }
  if (nextStatus === "resolved" && !parsed.data.resolutionDescription) {
    return res.status(400).json({ error: "وصف المعالجة مطلوب عند تحديد الملاحظة كمحلولة" });
  }

  // resolvedAt/resolvedByUserId/verifiedAt/verifiedByUserId/closedAt/
  // closedByUserId are ALWAYS computed here (req.userId!/new Date()),
  // never read from req.body — statusTransitionSchema above doesn't even
  // declare those field names, so a client attempting to supply them gets
  // a 400 from .strict(), not a silent ignore.
  //
  // Reopening (RESOLVED/VERIFIED -> IN_PROGRESS) deliberately does NOT
  // clear the previous resolution/verification fields — this phase's own
  // instruction is "do not silently erase previous audit history"; the
  // status transition itself is independently audited below, and the
  // stale resolvedAt/verifiedAt fields simply record "the last time this
  // was resolved/verified", which remains true even after reopening.
  const updated = await db.transaction(async (tx) => {
    const now = new Date();
    const [row] = await tx
      .update(projectPunchItems)
      .set({
        status: nextStatus,
        ...(nextStatus === "resolved"
          ? { resolutionDescription: parsed.data.resolutionDescription, resolvedAt: now, resolvedByUserId: req.userId! }
          : {}),
        ...(nextStatus === "verified" ? { verifiedAt: now, verifiedByUserId: req.userId! } : {}),
        ...(nextStatus === "closed" ? { closedAt: now, closedByUserId: req.userId! } : {}),
        updatedAt: now,
      })
      .where(eq(projectPunchItems.id, req.params.id))
      .returning();

    await recordAuditEvent(tx, {
      companyId: req.companyId!,
      actorUserId: req.userId!,
      action: "punchItem.statusChanged",
      entityType: "project_punch_item",
      entityId: row.id,
      beforeValue: { status: existing.status },
      afterValue: { status: row.status },
      metadata: { projectId: req.params.projectId },
    });

    return row;
  });

  res.json(toPunchItemResponse(updated));
});
