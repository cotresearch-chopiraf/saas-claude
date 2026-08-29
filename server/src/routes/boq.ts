import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { boqItems, boqRevisions, contracts, costCodes, projects } from "../db/schema.js";
import { requirePermission } from "../lib/permissions.js";
import { recordAuditEvent } from "../lib/audit.js";
import { roundMoney } from "../lib/money.js";

type ProjectParams = { projectId: string };
type RevisionParams = ProjectParams & { revisionId: string };
type ItemParams = RevisionParams & { itemId: string };

export const boqRouter = Router({ mergeParams: true });

boqRouter.use(async (req: Request<ProjectParams>, res: Response, next: NextFunction) => {
  const project = await db.query.projects.findFirst({
    where: and(eq(projects.id, req.params.projectId), eq(projects.companyId, req.companyId!)),
  });
  if (!project) return res.status(404).json({ error: "المشروع غير موجود" });
  next();
});

boqRouter.get("/", async (req: Request<ProjectParams>, res: Response) => {
  const rows = await db.query.boqRevisions.findMany({
    where: eq(boqRevisions.projectId, req.params.projectId),
    orderBy: (r, { desc }) => [desc(r.createdAt)],
  });
  res.json(rows);
});

const createRevisionSchema = z.object({
  contractId: z.string().uuid(),
  notes: z.string().optional(),
});

// revisionNumber is claimed with a single atomic INSERT ... SELECT
// subquery (the same discipline lib/numbering.ts already established for
// document numbering) rather than a separate SELECT-max-then-INSERT — two
// concurrent "create a new BOQ revision for this contract" requests can
// never be handed the same revision number.
boqRouter.post(
  "/",
  requirePermission("boq.manage"),
  async (req: Request<ProjectParams>, res: Response) => {
    const parsed = createRevisionSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

    const contract = await db.query.contracts.findFirst({
      where: and(eq(contracts.id, parsed.data.contractId), eq(contracts.projectId, req.params.projectId)),
    });
    if (!contract) return res.status(404).json({ error: "العقد غير موجود" });

    const result = await db.execute<{
      id: string;
      revision_number: number;
      status: string;
      created_at: string;
    }>(sql`
      INSERT INTO boq_revisions (company_id, project_id, contract_id, revision_number, status, notes, created_by)
      VALUES (
        ${req.companyId},
        ${req.params.projectId},
        ${parsed.data.contractId},
        (SELECT COALESCE(MAX(revision_number), 0) + 1 FROM boq_revisions WHERE contract_id = ${parsed.data.contractId}),
        'draft',
        ${parsed.data.notes ?? null},
        ${req.userId}
      )
      RETURNING id, revision_number, status, created_at
    `);
    const revision = result.rows[0];

    await recordAuditEvent(db, {
      companyId: req.companyId!,
      actorUserId: req.userId!,
      action: "boqRevision.created",
      entityType: "boq_revision",
      entityId: revision.id,
      afterValue: revision,
    });

    res.status(201).json(revision);
  },
);

async function findOwnedRevision(companyId: string, projectId: string, revisionId: string) {
  return db.query.boqRevisions.findFirst({
    where: and(
      eq(boqRevisions.id, revisionId),
      eq(boqRevisions.projectId, projectId),
      eq(boqRevisions.companyId, companyId),
    ),
  });
}

boqRouter.get("/:revisionId", async (req: Request<RevisionParams>, res: Response) => {
  const revision = await findOwnedRevision(req.companyId!, req.params.projectId, req.params.revisionId);
  if (!revision) return res.status(404).json({ error: "نسخة جدول الكميات غير موجودة" });

  const items = await db.query.boqItems.findMany({
    where: eq(boqItems.boqRevisionId, revision.id),
    orderBy: (i, { asc }) => [asc(i.sortOrder)],
  });
  res.json({ ...revision, items });
});

// Atomic: only succeeds if the revision is still "draft" at the moment
// this exact statement runs (WHERE status = 'draft' on the UPDATE itself,
// not a separate SELECT check) — two concurrent publish calls on the same
// revision can never both succeed, matching the pattern already
// established (and known to matter — see the tax-engine audit) in
// changeOrders.ts.
boqRouter.post(
  "/:revisionId/publish",
  requirePermission("boq.manage"),
  async (req: Request<RevisionParams>, res: Response) => {
    const existing = await findOwnedRevision(req.companyId!, req.params.projectId, req.params.revisionId);
    if (!existing) return res.status(404).json({ error: "نسخة جدول الكميات غير موجودة" });

    const published = await db.transaction(async (tx) => {
      // Lock the parent contract row for the duration of this
      // transaction. Without this, two DIFFERENT draft revisions of the
      // SAME contract published concurrently would each pass their own
      // independent "WHERE status = 'draft'" check below (they're
      // different rows, so that guard alone can't see each other) and
      // both end up published at once. Locking the shared contract row
      // serializes any two publish attempts under the same contract, so
      // "at most one published revision per contract" and the
      // supersedesRevisionId link below can never race each other —
      // whichever transaction gets here first finishes (commit or
      // rollback) before the other proceeds past this point.
      await tx.select().from(contracts).where(eq(contracts.id, existing.contractId)).for("update");

      const [updated] = await tx
        .update(boqRevisions)
        .set({ status: "published", publishedAt: new Date() })
        .where(and(eq(boqRevisions.id, existing.id), eq(boqRevisions.status, "draft")))
        .returning();
      if (!updated) return null;

      // Supersede whichever revision(s) were previously published for
      // this same contract — a contract has at most one published BOQ
      // revision "current" at a time, but every prior one stays in the
      // table, unaltered, exactly as boq_revisions is designed to.
      const supersededRows = await tx
        .update(boqRevisions)
        .set({ status: "superseded" })
        .where(
          and(
            eq(boqRevisions.contractId, existing.contractId),
            eq(boqRevisions.status, "published"),
            sql`${boqRevisions.id} != ${existing.id}`,
          ),
        )
        .returning();

      // Records which single revision this one most directly replaces —
      // normally there is exactly one (the contract-row lock above rules
      // out a concurrent second publish changing this answer underneath
      // us); the most-recently-published of the superseded rows is used
      // as a defensive tie-breaker in case more than one was ever found.
      let finalRevision = updated;
      if (supersededRows.length > 0) {
        const directPredecessor = supersededRows.sort(
          (a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0),
        )[0];
        [finalRevision] = await tx
          .update(boqRevisions)
          .set({ supersedesRevisionId: directPredecessor.id })
          .where(eq(boqRevisions.id, updated.id))
          .returning();
      }

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "boqRevision.published",
        entityType: "boq_revision",
        entityId: existing.id,
        beforeValue: { status: existing.status },
        afterValue: { status: "published", supersedesRevisionId: finalRevision.supersedesRevisionId ?? null },
      });

      return finalRevision;
    });

    if (!published) {
      return res.status(409).json({ error: "لا يمكن نشر نسخة ليست في حالة مسودة" });
    }
    res.json(published);
  },
);

const itemSchema = z.object({
  parentItemId: z.string().uuid().optional(),
  itemType: z.enum(["section", "item"]).default("item"),
  code: z.string().optional(),
  description: z.string().min(1, "الوصف مطلوب"),
  unit: z.string().optional(),
  quantity: z.coerce.number().nonnegative().optional(),
  rate: z.coerce.number().nonnegative().optional(),
  costCodeId: z.string().uuid().optional(),
  sortOrder: z.coerce.number().int().optional(),
});

// Items can only be added to a revision that is still "draft" — a
// published revision is immutable (mission requirement: "never overwrite
// BOQ history"); a change means creating a NEW revision (POST / above),
// never editing a published one's items in place.
//
// Hardening 1: the early "revision.status !== 'draft'" check below is only
// a fast-path (cheap 409 for the common non-racing case) — it is NOT what
// actually makes this safe under concurrency, because a plain SELECT can
// be stale relative to an in-flight, not-yet-committed publish. The real
// guarantee is the `SELECT ... FOR UPDATE` inside the transaction just
// before the insert: it takes the same row-level lock publish's own
// UPDATE takes, so whichever of the two (this insert, or a concurrent
// publish) reaches the row first finishes before the other proceeds, and
// the second one re-reads the now-current, post-commit status rather than
// trusting anything read earlier.
boqRouter.post(
  "/:revisionId/items",
  requirePermission("boq.manage"),
  async (req: Request<RevisionParams>, res: Response) => {
    const revision = await findOwnedRevision(req.companyId!, req.params.projectId, req.params.revisionId);
    if (!revision) return res.status(404).json({ error: "نسخة جدول الكميات غير موجودة" });
    if (revision.status !== "draft") {
      return res.status(409).json({ error: "لا يمكن إضافة بنود إلى نسخة منشورة" });
    }

    const parsed = itemSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

    // Neither reference is trusted as-is: a parent item must belong to THIS
    // same revision (never another revision, another project, or another
    // company's), and a cost code must belong to this company — otherwise a
    // BOQ item could silently point at a relationship that doesn't exist
    // from this tenant's point of view.
    if (parsed.data.parentItemId) {
      const parent = await db.query.boqItems.findFirst({
        where: and(eq(boqItems.id, parsed.data.parentItemId), eq(boqItems.boqRevisionId, revision.id)),
      });
      if (!parent) return res.status(404).json({ error: "البند الأصل غير موجود" });
    }
    if (parsed.data.costCodeId) {
      const costCode = await db.query.costCodes.findFirst({
        where: and(eq(costCodes.id, parsed.data.costCodeId), eq(costCodes.companyId, req.companyId!)),
      });
      if (!costCode) return res.status(404).json({ error: "بند التكلفة غير موجود" });
    }

    const amount =
      parsed.data.quantity !== undefined && parsed.data.rate !== undefined
        ? roundMoney(parsed.data.quantity * parsed.data.rate)
        : undefined;

    const item = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(boqRevisions).where(eq(boqRevisions.id, revision.id)).for("update");
      if (!locked || locked.status !== "draft") return null;

      const [inserted] = await tx
        .insert(boqItems)
        .values({
          boqRevisionId: revision.id,
          parentItemId: parsed.data.parentItemId,
          itemType: parsed.data.itemType,
          code: parsed.data.code,
          description: parsed.data.description,
          unit: parsed.data.unit,
          quantity: parsed.data.quantity !== undefined ? String(parsed.data.quantity) : undefined,
          rate: parsed.data.rate !== undefined ? String(parsed.data.rate) : undefined,
          amount: amount !== undefined ? String(amount) : undefined,
          costCodeId: parsed.data.costCodeId,
          sortOrder: parsed.data.sortOrder ?? 0,
        })
        .returning();
      return inserted;
    });

    if (!item) {
      return res.status(409).json({ error: "لا يمكن إضافة بنود إلى نسخة منشورة" });
    }
    res.status(201).json(item);
  },
);

// Hardening 1: same atomic-lock discipline as add-item above — the early
// status check is a fast-path only; the `FOR UPDATE` lock inside the
// transaction is what actually prevents a delete from racing a concurrent
// publish.
boqRouter.delete(
  "/:revisionId/items/:itemId",
  requirePermission("boq.manage"),
  async (req: Request<ItemParams>, res: Response) => {
    const revision = await findOwnedRevision(req.companyId!, req.params.projectId, req.params.revisionId);
    if (!revision) return res.status(404).json({ error: "نسخة جدول الكميات غير موجودة" });
    if (revision.status !== "draft") {
      return res.status(409).json({ error: "لا يمكن حذف بنود من نسخة منشورة" });
    }

    const existing = await db.query.boqItems.findFirst({
      where: and(eq(boqItems.id, req.params.itemId), eq(boqItems.boqRevisionId, revision.id)),
    });
    if (!existing) return res.status(404).json({ error: "البند غير موجود" });

    const deleted = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(boqRevisions).where(eq(boqRevisions.id, revision.id)).for("update");
      if (!locked || locked.status !== "draft") return null;

      const [row] = await tx.delete(boqItems).where(eq(boqItems.id, existing.id)).returning();
      return row;
    });

    if (!deleted) {
      return res.status(409).json({ error: "لا يمكن حذف بنود من نسخة منشورة" });
    }
    res.status(204).end();
  },
);
