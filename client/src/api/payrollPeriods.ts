import { apiFetch } from "./client";
import type { PayrollPeriod, PayrollPeriodPostResult, PayrollPeriodWithRecords } from "./types";

// Thin typed wrappers over the existing, verified Payroll Period API
// (server/src/routes/payrollPeriods.ts) — no calculation, no
// authorization logic. Company-wide (not project-scoped). No delete
// endpoint exists; lifecycle is submit/approve/post/reject only.

export function listPayrollPeriods(): Promise<PayrollPeriod[]> {
  return apiFetch<PayrollPeriod[]>("/payroll-periods");
}

export function getPayrollPeriod(id: string): Promise<PayrollPeriodWithRecords> {
  return apiFetch<PayrollPeriodWithRecords>(`/payroll-periods/${id}`);
}

export interface CreatePayrollPeriodInput {
  periodStart: string;
  periodEnd: string;
  payrollDate?: string;
  notes?: string;
}

export function createPayrollPeriod(input: CreatePayrollPeriodInput): Promise<PayrollPeriod> {
  return apiFetch<PayrollPeriod>("/payroll-periods", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export interface UpdatePayrollPeriodInput {
  periodStart?: string;
  periodEnd?: string;
  payrollDate?: string;
  notes?: string;
}

export function updatePayrollPeriod(id: string, input: UpdatePayrollPeriodInput): Promise<PayrollPeriod> {
  return apiFetch<PayrollPeriod>(`/payroll-periods/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function submitPayrollPeriod(id: string): Promise<PayrollPeriod> {
  return apiFetch<PayrollPeriod>(`/payroll-periods/${id}/submit`, { method: "POST" });
}

export function approvePayrollPeriod(id: string): Promise<PayrollPeriod> {
  return apiFetch<PayrollPeriod>(`/payroll-periods/${id}/approve`, { method: "POST" });
}

export function rejectPayrollPeriod(id: string, reason: string): Promise<PayrollPeriod> {
  return apiFetch<PayrollPeriod>(`/payroll-periods/${id}/reject`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

// MIDAD Phase A5 — financial posting. Requires `payroll.post`, not
// `payroll.manage` (see auth/permissions.ts's OWNER_ONLY_ACTIONS). Creates
// real `expenses` rows server-side; this call has no undo — see
// reverseLaborCostPosting in api/laborCostPostings.ts for the only
// controlled correction path.
export function postPayrollPeriod(id: string): Promise<PayrollPeriodPostResult> {
  return apiFetch<PayrollPeriodPostResult>(`/payroll-periods/${id}/post`, { method: "POST" });
}
