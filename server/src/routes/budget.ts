import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { budgetItems, budgetRevisions, expenses, projects } from "../db/schema.js";
import { sumMoney, roundMoney } from "../lib/money.js";
import { recordAuditEvent } from "../lib/audit.js";
import { requirePermission } from "../lib/permissions.js";
import { pgErrorInfo } from "../lib/pgError.js";
import { withIdempotency, IdempotencyConflictError } from "../lib/idempotency.js";

type ProjectParams = { projectId: string };
type ItemParams = ProjectParams & { itemId: string };
type ExpenseParams = ProjectParams & { expenseId: string };

export const budgetRouter = Router({ mergeParams: true });

// P0 remediation (Final Pre-Launch Audit) — mirrors budgetRevisions.ts's own
// "revision.status !== 'draft'" fast-path check: once a budget revision is
// approved, its item set is meant to be an immutable historical record (see
// that file's comment). This is only the fast-path; the actual guarantee
// against racing a concurrent approve is the `SELECT ... FOR UPDATE` inside
// each mutating route's own transaction below, same discipline as
// budgetRevisions.ts's item-assignment route.
async function assertItemMutable(budgetRevisionId: string | null): Promise<string | null> {
  if (!budgetRevisionId) return null;
  const revision = await db.query.budgetRevisions.findFirst({ where: eq(budgetRevisions.id, budgetRevisionId) });
  if (revision && revision.status !== "draft") {
    return "لا يمكن تعديل بند ميزانية تابع لنسخة معتمدة أو مستبدلة — أنشئ نسخة جديدة بدلاً من ذلك";
  }
  return null;
}

// Every route below hangs off /api/projects/:projectId/budget — verify the
// project exists and belongs to the caller's company before touching anything.
budgetRouter.use(async (req: Request<ProjectParams>, res: Response, next: NextFunction) => {
  const project = await db.query.projects.findFirst({
    where: and(eq(projects.id, req.params.projectId), eq(projects.companyId, req.companyId!)),
  });
  if (!project) return res.status(404).json({ error: "المشروع غير موجود" });
  next();
});

budgetRouter.get("/", async (req: Request<ProjectParams>, res: Response) => {
  const projectId = req.params.projectId;

  const items = await db.query.budgetItems.findMany({
    where: eq(budgetItems.projectId, projectId),
    orderBy: (b, { asc }) => [asc(b.createdAt)],
  });
  const projectExpenses = await db.query.expenses.findMany({
    where: eq(expenses.projectId, projectId),
    orderBy: (e, { desc }) => [desc(e.expenseDate)],
  });

  const amountsByItem = new Map<string, number[]>();
  const allExpenseAmounts: number[] = [];
  for (const expense of projectExpenses) {
    const amount = Number(expense.amount);
    allExpenseAmounts.push(amount);
    if (expense.budgetItemId) {
      const amounts = amountsByItem.get(expense.budgetItemId) ?? [];
      amounts.push(amount);
      amountsByItem.set(expense.budgetItemId, amounts);
    }
  }
  const spentByItem = new Map<string, number>();
  for (const [itemId, amounts] of amountsByItem) {
    spentByItem.set(itemId, sumMoney(amounts));
  }

  const totalPlanned = sumMoney(items.map((item) => Number(item.plannedAmount)));
  const totalSpent = sumMoney(allExpenseAmounts);

  res.json({
    items: items.map((item) => ({
      ...item,
      spent: spentByItem.get(item.id) ?? 0,
    })),
    expenses: projectExpenses,
    totals: {
      planned: totalPlanned,
      spent: totalSpent,
      remaining: roundMoney(totalPlanned - totalSpent),
    },
  });
});

function csvCell(value: string | number): string {
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

// Directly answers the #1 complaint about the market leader (Buildertrend):
// "no simple or bulk way to download years of ... data." Your numbers are
// never locked in here — one click, always a plain CSV.
budgetRouter.get("/export.csv", async (req: Request<ProjectParams>, res: Response) => {
  const projectId = req.params.projectId;
  const items = await db.query.budgetItems.findMany({ where: eq(budgetItems.projectId, projectId) });
  const projectExpenses = await db.query.expenses.findMany({ where: eq(expenses.projectId, projectId) });

  const itemNameById = new Map(items.map((item) => [item.id, item.category]));

  const rows = [
    ["النوع", "البند", "الوصف", "المبلغ", "التاريخ"],
    ...items.map((item) => ["بند ميزانية", item.category, "", item.plannedAmount, ""]),
    ...projectExpenses.map((expense) => [
      "مصروف",
      expense.budgetItemId ? (itemNameById.get(expense.budgetItemId) ?? "") : "",
      expense.description,
      expense.amount,
      expense.expenseDate,
    ]),
  ];

  const csv = "﻿" + rows.map((row) => row.map(csvCell).join(",")).join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="budget-${projectId}.csv"`);
  res.send(csv);
});

const itemSchema = z.object({
  category: z.string().min(2, "اسم البند قصير جداً"),
  plannedAmount: z.coerce.number().nonnegative(),
});

// Hardening 2: budget items are one of the two most directly
// Phase-1-relevant financial mutation surfaces (the other is expenses,
// below) and — unlike Contract/CostCode/BOQ/BudgetRevision — were not yet
// writing to the canonical audit_events table, only to the (non-durable,
// non-queryable) structured log. Wrapped in the same insert+audit
// transaction discipline already used everywhere else recordAuditEvent is
// called: a failed audit write rolls back the mutation too, matching
// established policy.
budgetRouter.post("/items", requirePermission("budget.manage"), async (req: Request<ProjectParams>, res: Response) => {
  const parsed = itemSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const item = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(budgetItems)
      .values({
        projectId: req.params.projectId,
        category: parsed.data.category,
        plannedAmount: String(parsed.data.plannedAmount),
      })
      .returning();

    await recordAuditEvent(tx, {
      companyId: req.companyId!,
      actorUserId: req.userId!,
      action: "budgetItem.created",
      entityType: "budget_item",
      entityId: created.id,
      afterValue: created,
      metadata: { projectId: req.params.projectId },
    });

    return created;
  });

  res.status(201).json(item);
});

budgetRouter.patch("/items/:itemId", requirePermission("budget.manage"), async (req: Request<ItemParams>, res: Response) => {
  const parsed = itemSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const existing = await db.query.budgetItems.findFirst({
    where: and(eq(budgetItems.id, req.params.itemId), eq(budgetItems.projectId, req.params.projectId)),
  });
  if (!existing) return res.status(404).json({ error: "بند الميزانية غير موجود" });

  const immutableError = await assertItemMutable(existing.budgetRevisionId);
  if (immutableError) return res.status(409).json({ error: immutableError });

  const { plannedAmount, ...rest } = parsed.data;
  const result = await db.transaction(async (tx) => {
    if (existing.budgetRevisionId) {
      const [lockedRevision] = await tx
        .select()
        .from(budgetRevisions)
        .where(eq(budgetRevisions.id, existing.budgetRevisionId))
        .for("update");
      if (lockedRevision && lockedRevision.status !== "draft") {
        return { outcome: "immutable" as const };
      }
    }

    const [row] = await tx
      .update(budgetItems)
      .set({
        ...rest,
        ...(plannedAmount !== undefined ? { plannedAmount: String(plannedAmount) } : {}),
      })
      .where(eq(budgetItems.id, req.params.itemId))
      .returning();

    await recordAuditEvent(tx, {
      companyId: req.companyId!,
      actorUserId: req.userId!,
      action: "budgetItem.updated",
      entityType: "budget_item",
      entityId: existing.id,
      beforeValue: existing,
      afterValue: row,
      metadata: { projectId: req.params.projectId },
    });

    return { outcome: "ok" as const, item: row };
  });

  if (result.outcome === "immutable") {
    return res.status(409).json({ error: "لا يمكن تعديل بند ميزانية تابع لنسخة معتمدة أو مستبدلة — أنشئ نسخة جديدة بدلاً من ذلك" });
  }
  res.json(result.item);
});

budgetRouter.delete("/items/:itemId", requirePermission("budget.manage"), async (req: Request<ItemParams>, res: Response) => {
  const existing = await db.query.budgetItems.findFirst({
    where: and(eq(budgetItems.id, req.params.itemId), eq(budgetItems.projectId, req.params.projectId)),
  });
  if (!existing) return res.status(404).json({ error: "بند الميزانية غير موجود" });

  const immutableError = await assertItemMutable(existing.budgetRevisionId);
  if (immutableError) return res.status(409).json({ error: immutableError });

  const result = await db.transaction(async (tx) => {
    if (existing.budgetRevisionId) {
      const [lockedRevision] = await tx
        .select()
        .from(budgetRevisions)
        .where(eq(budgetRevisions.id, existing.budgetRevisionId))
        .for("update");
      if (lockedRevision && lockedRevision.status !== "draft") {
        return { outcome: "immutable" as const };
      }
    }

    await tx.delete(budgetItems).where(eq(budgetItems.id, req.params.itemId));

    await recordAuditEvent(tx, {
      companyId: req.companyId!,
      actorUserId: req.userId!,
      action: "budgetItem.deleted",
      entityType: "budget_item",
      entityId: existing.id,
      beforeValue: existing,
      metadata: { projectId: req.params.projectId },
    });

    return { outcome: "ok" as const };
  });

  if (result.outcome === "immutable") {
    return res.status(409).json({ error: "لا يمكن تعديل بند ميزانية تابع لنسخة معتمدة أو مستبدلة — أنشئ نسخة جديدة بدلاً من ذلك" });
  }
  res.status(204).end();
});

const expenseSchema = z.object({
  description: z.string().min(2, "الوصف قصير جداً"),
  amount: z.coerce.number().positive("المبلغ يجب أن يكون أكبر من صفر"),
  expenseDate: z.string().min(1, "التاريخ مطلوب"),
  budgetItemId: z.string().uuid().optional(),
});

// Factored out of the route handler so both the idempotent path (wrapped in
// withIdempotency below) and the plain non-idempotent path can share the
// exact same validation/insert/audit logic without duplication — same shape
// as invoices.ts's createInvoice(). Business logic (validation, ownership
// check, insert, audit event) is completely unchanged from before Wave 1F.
async function createExpense(
  companyId: string,
  actorUserId: string,
  projectId: string,
  data: z.infer<typeof expenseSchema>,
): Promise<{ error: string; status: number } | { expense: typeof expenses.$inferSelect }> {
  // A budget item id is never trusted as-is: without this check, any
  // authenticated member of THIS company could attach an expense to a
  // budget item belonging to a DIFFERENT project (this company's own, or —
  // since budgetItemId was never scoped at all — even one visible only by
  // guessing a UUID) silently corrupting that other project's spent/
  // remaining totals. Same ownership-validation discipline invoices.ts
  // already applies to quoteId.
  if (data.budgetItemId) {
    const owningItem = await db.query.budgetItems.findFirst({
      where: and(eq(budgetItems.id, data.budgetItemId), eq(budgetItems.projectId, projectId)),
    });
    if (!owningItem) return { error: "بند الميزانية غير موجود", status: 404 };
  }

  const expense = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(expenses)
      .values({
        projectId,
        description: data.description,
        amount: String(data.amount),
        expenseDate: data.expenseDate,
        budgetItemId: data.budgetItemId,
      })
      .returning();

    await recordAuditEvent(tx, {
      companyId,
      actorUserId,
      action: "expense.created",
      entityType: "expense",
      entityId: created.id,
      afterValue: created,
      metadata: { projectId },
    });

    return created;
  });

  return { expense };
}

budgetRouter.post("/expenses", requirePermission("budget.manage"), async (req: Request<ProjectParams>, res: Response) => {
  const parsed = expenseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  // Wave 1F (W1E-002 remediation) — opt-in idempotency, same pattern as
  // invoices.ts/quotes.ts: a client that supplies an Idempotency-Key header
  // is protected from creating a duplicate expense on a retried request; a
  // client that doesn't send the header keeps the exact prior behavior.
  const idempotencyKey = req.header("Idempotency-Key");
  if (idempotencyKey) {
    try {
      const outcome = await withIdempotency<typeof expenses.$inferSelect | { error: string; status: number }>(
        req.companyId!,
        "expense.create",
        idempotencyKey,
        req.body,
        async () => {
          const result = await createExpense(req.companyId!, req.userId!, req.params.projectId, parsed.data);
          if ("error" in result) return { status: result.status, body: result };
          return { status: 201, body: result.expense };
        },
      );
      return res.status(outcome.status).json(outcome.body);
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {
        return res.status(409).json({ error: "تم استخدام مفتاح idempotency هذا مسبقاً بطلب مختلف" });
      }
      throw err;
    }
  }

  const result = await createExpense(req.companyId!, req.userId!, req.params.projectId, parsed.data);
  if ("error" in result) return res.status(result.status).json({ error: result.error });
  res.status(201).json(result.expense);
});

// No PATCH /expenses/:expenseId route exists in this codebase — an
// expense is create-or-delete only, so "updated" is not part of the
// actual mutation surface and has no audit event to add here.
//
// A labor-posted expense (one with a labor_cost_postings row pointing at
// it — see that table's schema comment) is never deletable through this
// route: `expenseId` there has no onDelete action, so Postgres itself
// would refuse the delete (23503 foreign_key_violation) — this just
// converts that into a clean application error before it happens, rather
// than exposing the raw constraint error. Normal (non-labor-posted)
// expense deletion is completely unchanged.
budgetRouter.delete("/expenses/:expenseId", requirePermission("budget.manage"), async (req: Request<ExpenseParams>, res: Response) => {
  const existing = await db.query.expenses.findFirst({
    where: and(eq(expenses.id, req.params.expenseId), eq(expenses.projectId, req.params.projectId)),
  });
  if (!existing) return res.status(404).json({ error: "المصروف غير موجود" });

  try {
    await db.transaction(async (tx) => {
      await tx.delete(expenses).where(eq(expenses.id, req.params.expenseId));

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "expense.deleted",
        entityType: "expense",
        entityId: existing.id,
        beforeValue: existing,
        metadata: { projectId: req.params.projectId },
      });
    });
  } catch (err) {
    if (pgErrorInfo(err).code === "23503") {
      return res.status(409).json({ error: "لا يمكن حذف مصروف ناتج عن ترحيل تكلفة عمالة — استخدم عملية العكس بدلاً من ذلك" });
    }
    throw err;
  }

  res.status(204).end();
});
