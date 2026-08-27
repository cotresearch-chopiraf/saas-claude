import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { budgetItems, expenses, projects } from "../db/schema.js";

type ProjectParams = { projectId: string };
type ItemParams = ProjectParams & { itemId: string };
type ExpenseParams = ProjectParams & { expenseId: string };

export const budgetRouter = Router({ mergeParams: true });

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

  const spentByItem = new Map<string, number>();
  let totalSpent = 0;
  for (const expense of projectExpenses) {
    const amount = Number(expense.amount);
    totalSpent += amount;
    if (expense.budgetItemId) {
      spentByItem.set(expense.budgetItemId, (spentByItem.get(expense.budgetItemId) ?? 0) + amount);
    }
  }

  const totalPlanned = items.reduce((sum, item) => sum + Number(item.plannedAmount), 0);

  res.json({
    items: items.map((item) => ({
      ...item,
      spent: spentByItem.get(item.id) ?? 0,
    })),
    expenses: projectExpenses,
    totals: {
      planned: totalPlanned,
      spent: totalSpent,
      remaining: totalPlanned - totalSpent,
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

budgetRouter.post("/items", async (req: Request<ProjectParams>, res: Response) => {
  const parsed = itemSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const [item] = await db
    .insert(budgetItems)
    .values({
      projectId: req.params.projectId,
      category: parsed.data.category,
      plannedAmount: String(parsed.data.plannedAmount),
    })
    .returning();
  res.status(201).json(item);
});

budgetRouter.patch("/items/:itemId", async (req: Request<ItemParams>, res: Response) => {
  const parsed = itemSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const existing = await db.query.budgetItems.findFirst({
    where: and(eq(budgetItems.id, req.params.itemId), eq(budgetItems.projectId, req.params.projectId)),
  });
  if (!existing) return res.status(404).json({ error: "بند الميزانية غير موجود" });

  const { plannedAmount, ...rest } = parsed.data;
  const [updated] = await db
    .update(budgetItems)
    .set({
      ...rest,
      ...(plannedAmount !== undefined ? { plannedAmount: String(plannedAmount) } : {}),
    })
    .where(eq(budgetItems.id, req.params.itemId))
    .returning();
  res.json(updated);
});

budgetRouter.delete("/items/:itemId", async (req: Request<ItemParams>, res: Response) => {
  const existing = await db.query.budgetItems.findFirst({
    where: and(eq(budgetItems.id, req.params.itemId), eq(budgetItems.projectId, req.params.projectId)),
  });
  if (!existing) return res.status(404).json({ error: "بند الميزانية غير موجود" });

  await db.delete(budgetItems).where(eq(budgetItems.id, req.params.itemId));
  res.status(204).end();
});

const expenseSchema = z.object({
  description: z.string().min(2, "الوصف قصير جداً"),
  amount: z.coerce.number().positive("المبلغ يجب أن يكون أكبر من صفر"),
  expenseDate: z.string().min(1, "التاريخ مطلوب"),
  budgetItemId: z.string().uuid().optional(),
});

budgetRouter.post("/expenses", async (req: Request<ProjectParams>, res: Response) => {
  const parsed = expenseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const [expense] = await db
    .insert(expenses)
    .values({
      projectId: req.params.projectId,
      description: parsed.data.description,
      amount: String(parsed.data.amount),
      expenseDate: parsed.data.expenseDate,
      budgetItemId: parsed.data.budgetItemId,
    })
    .returning();
  res.status(201).json(expense);
});

budgetRouter.delete("/expenses/:expenseId", async (req: Request<ExpenseParams>, res: Response) => {
  const existing = await db.query.expenses.findFirst({
    where: and(eq(expenses.id, req.params.expenseId), eq(expenses.projectId, req.params.projectId)),
  });
  if (!existing) return res.status(404).json({ error: "المصروف غير موجود" });

  await db.delete(expenses).where(eq(expenses.id, req.params.expenseId));
  res.status(204).end();
});
