import { apiFetch } from "./client";
import type { BudgetItem, BudgetRevision, BudgetRevisionWithItems, BudgetSummary, CostCode, Expense } from "./types";

// Thin typed wrappers over the existing, verified Budget / Budget Revision /
// Cost Code APIs (server/src/routes/budget.ts, budgetRevisions.ts,
// costCodes.ts) — no calculation, no authorization logic. Totals below are
// exactly what GET /budget already computes server-side; nothing here
// re-derives planned/spent/remaining.

export function getBudget(projectId: string): Promise<BudgetSummary> {
  return apiFetch<BudgetSummary>(`/projects/${projectId}/budget`);
}

export interface BudgetItemInput {
  category: string;
  plannedAmount: number;
}

export function createBudgetItem(projectId: string, input: BudgetItemInput): Promise<BudgetItem> {
  return apiFetch<BudgetItem>(`/projects/${projectId}/budget/items`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateBudgetItem(projectId: string, itemId: string, input: Partial<BudgetItemInput>): Promise<BudgetItem> {
  return apiFetch<BudgetItem>(`/projects/${projectId}/budget/items/${itemId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function deleteBudgetItem(projectId: string, itemId: string): Promise<void> {
  return apiFetch<void>(`/projects/${projectId}/budget/items/${itemId}`, { method: "DELETE" });
}

// --- MIDAD UI-03B: Actual Cost (Expense) ---
// Expenses are already part of GET /budget's response (see getBudget
// above) — these are only the create/delete wrappers, matching
// server/src/routes/budget.ts's expense routes exactly. No permission
// gate exists server-side, so no RBAC visibility is applied client-side
// either (same posture as Budget Item CRUD, mirrored deliberately).

export interface ExpenseInput {
  description: string;
  amount: number;
  expenseDate: string;
  budgetItemId?: string;
}

export function createExpense(projectId: string, input: ExpenseInput): Promise<Expense> {
  return apiFetch<Expense>(`/projects/${projectId}/budget/expenses`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function deleteExpense(projectId: string, expenseId: string): Promise<void> {
  return apiFetch<void>(`/projects/${projectId}/budget/expenses/${expenseId}`, { method: "DELETE" });
}

export function listCostCodes(projectId?: string): Promise<CostCode[]> {
  return apiFetch<CostCode[]>(`/cost-codes${projectId ? `?projectId=${projectId}` : ""}`);
}

export function listBudgetRevisions(projectId: string): Promise<BudgetRevision[]> {
  return apiFetch<BudgetRevision[]>(`/projects/${projectId}/budget-revisions`);
}

export function getBudgetRevision(projectId: string, revisionId: string): Promise<BudgetRevisionWithItems> {
  return apiFetch<BudgetRevisionWithItems>(`/projects/${projectId}/budget-revisions/${revisionId}`);
}

export function createBudgetRevision(projectId: string, input: { reason?: string }): Promise<BudgetRevision> {
  return apiFetch<BudgetRevision>(`/projects/${projectId}/budget-revisions`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function approveBudgetRevision(projectId: string, revisionId: string): Promise<BudgetRevision> {
  return apiFetch<BudgetRevision>(`/projects/${projectId}/budget-revisions/${revisionId}/approve`, { method: "POST" });
}

export function assignBudgetItemToRevision(
  projectId: string,
  revisionId: string,
  itemId: string,
  input: { costCodeId?: string | null },
): Promise<BudgetItem> {
  return apiFetch<BudgetItem>(`/projects/${projectId}/budget-revisions/${revisionId}/items/${itemId}`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}
