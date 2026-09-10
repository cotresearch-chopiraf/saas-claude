import { apiFetch } from "./client";
import type { BudgetAlert, BudgetAlertEvaluateResult, BudgetAlertSeverity, BudgetAlertStatus } from "./types";

// MIDAD Phase E — thin typed wrappers over the verified Budget Alerts API
// (server/src/routes/budgetAlerts.ts). No calculation of any kind lives
// here — every alert, severity, and metric value is server-generated;
// this file only shapes HTTP calls. INTERNAL ONLY: never imported from
// client/src/portal/.

export interface BudgetAlertFilters {
  projectId?: string;
  status?: BudgetAlertStatus;
  severity?: BudgetAlertSeverity;
}

export function listBudgetAlerts(filters: BudgetAlertFilters = {}): Promise<BudgetAlert[]> {
  const params = new URLSearchParams();
  if (filters.projectId) params.set("projectId", filters.projectId);
  if (filters.status) params.set("status", filters.status);
  if (filters.severity) params.set("severity", filters.severity);
  const query = params.toString();
  return apiFetch<BudgetAlert[]>(`/budget-alerts${query ? `?${query}` : ""}`);
}

export function getBudgetAlert(id: string): Promise<BudgetAlert> {
  return apiFetch<BudgetAlert>(`/budget-alerts/${id}`);
}

// projectId omitted -> evaluates every one of this company's active
// projects (bounded by the company's own project count).
export function evaluateBudgetAlerts(projectId?: string): Promise<BudgetAlertEvaluateResult> {
  return apiFetch<BudgetAlertEvaluateResult>("/budget-alerts/evaluate", {
    method: "POST",
    body: JSON.stringify(projectId ? { projectId } : {}),
  });
}

export function acknowledgeBudgetAlert(id: string): Promise<BudgetAlert> {
  return apiFetch<BudgetAlert>(`/budget-alerts/${id}/acknowledge`, { method: "POST" });
}

export function resolveBudgetAlert(id: string): Promise<BudgetAlert> {
  return apiFetch<BudgetAlert>(`/budget-alerts/${id}/resolve`, { method: "POST" });
}
