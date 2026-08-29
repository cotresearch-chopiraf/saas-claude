import { apiFetch } from "./client";
import type { CashFlowResult } from "./types";

// Thin typed wrapper over the existing, verified Cash Flow API
// (server/src/routes/cashflow.ts) — no calculation, no authorization
// logic. Every figure is computed exclusively by lib/cashflow.ts's
// calculateCashFlow() (which itself reuses Forecast's own ETC/committed-
// cost verbatim); nothing here ever reproduces that arithmetic.
export function getCashFlow(projectId: string, asOfDate?: string): Promise<CashFlowResult> {
  const query = asOfDate ? `?asOfDate=${encodeURIComponent(asOfDate)}` : "";
  return apiFetch<CashFlowResult>(`/projects/${projectId}/cash-flow${query}`);
}
