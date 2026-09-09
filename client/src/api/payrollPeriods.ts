import { apiFetch } from "./client";
import type { PayrollPeriod, PayrollPeriodWithRecords } from "./types";

// Thin typed wrappers over the existing, verified Payroll Period API
// (server/src/routes/payrollPeriods.ts) — no calculation, no
// authorization logic. Company-wide (not project-scoped). No delete
// endpoint exists; lifecycle is submit/approve/reject only.

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
