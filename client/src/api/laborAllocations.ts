import { apiFetch } from "./client";
import type { LaborAllocation } from "./types";

// Thin typed wrappers over the existing, verified Labor Allocation API
// (server/src/routes/laborAllocations.ts) — no calculation, no
// authorization logic. `amount` is always server-computed; it is never
// sent from here.

export function listLaborAllocations(filters: { payrollRecordId?: string; payrollPeriodId?: string; projectId?: string } = {}): Promise<LaborAllocation[]> {
  const params = new URLSearchParams();
  if (filters.payrollRecordId) params.set("payrollRecordId", filters.payrollRecordId);
  if (filters.payrollPeriodId) params.set("payrollPeriodId", filters.payrollPeriodId);
  if (filters.projectId) params.set("projectId", filters.projectId);
  const query = params.toString();
  return apiFetch<LaborAllocation[]>(`/labor-allocations${query ? `?${query}` : ""}`);
}

export function getLaborAllocation(id: string): Promise<LaborAllocation> {
  return apiFetch<LaborAllocation>(`/labor-allocations/${id}`);
}

export interface CreateLaborAllocationInput {
  payrollRecordId: string;
  projectId: string;
  costCodeId?: string;
  percentage: number;
  notes?: string;
}

export function createLaborAllocation(input: CreateLaborAllocationInput): Promise<LaborAllocation> {
  return apiFetch<LaborAllocation>("/labor-allocations", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export interface UpdateLaborAllocationInput {
  costCodeId?: string | null;
  percentage?: number;
  notes?: string;
}

export function updateLaborAllocation(id: string, input: UpdateLaborAllocationInput): Promise<LaborAllocation> {
  return apiFetch<LaborAllocation>(`/labor-allocations/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function deleteLaborAllocation(id: string): Promise<void> {
  return apiFetch<void>(`/labor-allocations/${id}`, { method: "DELETE" });
}
