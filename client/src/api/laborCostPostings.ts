import { apiFetch } from "./client";
import type { LaborCostPosting } from "./types";

// Thin typed wrappers over the existing, verified Labor Cost Posting API
// (server/src/routes/laborCostPostings.ts) — no calculation, no
// authorization logic. Listing/reading is member-open; reversal requires
// `payroll.post`, same gate as posting itself.

export function listLaborCostPostings(filters: { payrollPeriodId?: string; laborAllocationId?: string } = {}): Promise<LaborCostPosting[]> {
  const params = new URLSearchParams();
  if (filters.payrollPeriodId) params.set("payrollPeriodId", filters.payrollPeriodId);
  if (filters.laborAllocationId) params.set("laborAllocationId", filters.laborAllocationId);
  const query = params.toString();
  return apiFetch<LaborCostPosting[]>(`/labor-cost-postings${query ? `?${query}` : ""}`);
}

export function getLaborCostPosting(id: string): Promise<LaborCostPosting> {
  return apiFetch<LaborCostPosting>(`/labor-cost-postings/${id}`);
}

export interface ReverseLaborCostPostingResult {
  reversal: LaborCostPosting;
  expense: { id: string; amount: string; expenseDate: string; description: string };
}

// Never edits or deletes the original posting/Expense — creates a NEW
// negative Expense plus a NEW posting row (kind="reversal") linked back
// via reversalOfPostingId. A posting can be reversed at most once; a
// reversal itself can never be reversed (server-enforced).
export function reverseLaborCostPosting(id: string): Promise<ReverseLaborCostPostingResult> {
  return apiFetch<ReverseLaborCostPostingResult>(`/labor-cost-postings/${id}/reverse`, { method: "POST" });
}
