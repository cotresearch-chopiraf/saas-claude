import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { budgetItems, budgetRevisions, costCodes, projects } from "../db/schema.js";
import { requirePermission } from "../lib/permissions.js";
import { recordAuditEvent } from "../lib/audit.js";

type ProjectParams = { projectId: string };
type RevisionParams = ProjectParams & { revisionId: string };
type RevisionItemParams = RevisionParams & { itemId: string };

export const budgetRevisionsRouter = Router({ mergeParams: true });

// Same tenant/ownership-scoping pattern as every other project sub-resource.
budgetRevisionsRouter.use(async (req: Request<ProjectParams>, res: Response, next: NextFunction) => {
  const project = await db.query.projects.findFirst({
    where: and(eq(projects.id, req.params.projectId), eq(projects.companyId, req.companyId!)),
  });
  if (!project) return res.status(404).json({ error: "المشروع غير موجود" });
  next();
});

budgetRevisionsRouter.get("/", async (req: Request<ProjectParams>, res: Response) => {
  const rows = await db.query.budgetRevisions.findMany({
    where: eq(budgetRevisions.projectId, req.params.projectId),
    orderBy: (r, { desc }) => [desc(r.createdAt)],
  });
  res.json(rows);
});

const createSchema = z.object({
  reason: z.string().optional(),
});

// revisionNumber is claimed with the same atomic INSERT...SELECT-subquery
// discipline used for BOQ revisions (routes/boq.ts) — two concurrent
// "create a new budget revision for this project" requests can never be
// handed the same revision number.
budgetRevisionsRouter.post(
  "/",
  requirePermission("budgetRevision.manage"),
  async (req: Request<ProjectParams>, res: Response) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

    const result = await db.execute<{
      id: string;
      revision_number: number;
      status: string;
      created_at: string;
    }>(sql`
      INSERT INTO budget_revisions (company_id, project_id, revision_number, status, reason, created_by)
      VALUES (
        ${req.companyId},
        ${req.params.projectId},
        (SELECT COALESCE(MAX(revision_number), 0) + 1 FROM budget_revisions WHERE project_id = ${req.params.projectId}),
        'draft',
        ${parsed.data.reason ?? null},
        ${req.userId}
      )
      RETURNING id, revision_number, status, created_at
    `);
    const revision = result.rows[0];

    await recordAuditEvent(db, {
      companyId: req.companyId!,
      actorUserId: req.userId!,
      action: "budgetRevision.created",
      entityType: "budget_revision",
      entityId: revision.id,
      afterValue: revision,
    });

    res.status(201).json(revision);
  },
);

async function findOwnedRevision(companyId: string, projectId: string, revisionId: string) {
  return db.query.budgetRevisions.findFirst({
    where: and(
      eq(budgetRevisions.id, revisionId),
      eq(budgetRevisions.projectId, projectId),
      eq(budgetRevisions.companyId, companyId),
    ),
  });
}

budgetRevisionsRouter.get("/:revisionId", async (req: Request<RevisionParams>, res: Response) => {
  const revision = await findOwnedRevision(req.companyId!, req.params.projectId, req.params.revisionId);
  if (!revision) return res.status(404).json({ error: "نسخة الميزانية غير موجودة" });

  const items = await db.query.budgetItems.findMany({
    where: eq(budgetItems.budgetRevisionId, revision.id),
    orderBy: (b, { asc }) => [asc(b.createdAt)],
  });
  res.json({ ...revision, items });
});

// Atomic: only succeeds if the revision is still "draft" at the moment this
// exact statement runs (WHERE status = 'draft' on the UPDATE itself) — the
// same conditional-UPDATE discipline as changeOrders.ts / boq.ts's publish
// route, so two concurrent approvals of the same revision can never both
// succeed.
budgetRevisionsRouter.post(
  "/:revisionId/approve",
  requirePermission("budgetRevision.manage"),
  async (req: Request<RevisionParams>, res: Response) => {
    const existing = await findOwnedRevision(req.companyId!, req.params.projectId, req.params.revisionId);
    if (!existing) return res.status(404).json({ error: "نسخة الميزانية غير موجودة" });

    const approved = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(budgetRevisions)
        .set({ status: "approved", approvedBy: req.userId!, approvedAt: new Date() })
        .where(and(eq(budgetRevisions.id, existing.id), eq(budgetRevisions.status, "draft")))
        .returning();
      if (!updated) return null;

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "budgetRevision.approved",
        entityType: "budget_revision",
        entityId: existing.id,
        beforeValue: { status: existing.status },
        afterValue: { status: "approved" },
      });

      return updated;
    });

    if (!approved) {
      return res.status(409).json({ error: "لا يمكن اعتماد نسخة ليست في حالة مسودة" });
    }
    res.json(approved);
  },
);

const assignItemSchema = z.object({
  costCodeId: z.string().uuid().nullable().optional(),
});

// Attaches an existing budget item (already scoped to this project) to this
// revision — the "move this planned amount under this approval batch, and
// optionally re-tag its cost code" operation (a budget transfer between
// cost codes). Only permitted while the revision is still draft: once
// approved, a revision's item set is a historical record, exactly like a
// published BOQ revision's items — a further change means creating a new
// revision, not editing an approved one in place.
budgetRevisionsRouter.post(
  "/:revisionId/items/:itemId",
  requirePermission("budgetRevision.manage"),
  async (req: Request<RevisionItemParams>, res: Response) => {
    const revision = await findOwnedRevision(req.companyId!, req.params.projectId, req.params.revisionId);
    if (!revision) return res.status(404).json({ error: "نسخة الميزانية غير موجودة" });
    if (revision.status !== "draft") {
      return res.status(409).json({ error: "لا يمكن تعديل بنود نسخة معتمدة" });
    }

    const existingItem = await db.query.budgetItems.findFirst({
      where: and(eq(budgetItems.id, req.params.itemId), eq(budgetItems.projectId, req.params.projectId)),
    });
    if (!existingItem) return res.status(404).json({ error: "بند الميزانية غير موجود" });

    const parsed = assignItemSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

    if (parsed.data.costCodeId) {
      const costCode = await db.query.costCodes.findFirst({
        where: and(eq(costCodes.id, parsed.data.costCodeId), eq(costCodes.companyId, req.companyId!)),
      });
      if (!costCode) return res.status(404).json({ error: "بند التكلفة غير موجود" });
    }

    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(budgetItems)
        .set({
          budgetRevisionId: revision.id,
          ...(parsed.data.costCodeId !== undefined ? { costCodeId: parsed.data.costCodeId } : {}),
        })
        .where(eq(budgetItems.id, existingItem.id))
        .returning();

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "budgetItem.assignedToRevision",
        entityType: "budget_item",
        entityId: existingItem.id,
        beforeValue: { budgetRevisionId: existingItem.budgetRevisionId, costCodeId: existingItem.costCodeId },
        afterValue: { budgetRevisionId: row.budgetRevisionId, costCodeId: row.costCodeId },
        metadata: { budgetRevisionId: revision.id },
      });

      return row;
    });

    res.json(updated);
  },
);
