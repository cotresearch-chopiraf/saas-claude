import { apiFetch } from "./client";
import type { PayrollRecord } from "./types";

// Thin typed wrappers over the existing, verified Payroll Record API
// (server/src/routes/payrollRecords.ts) — no calculation, no
// authorization logic. netAmount is always server-computed; it is never
// sent from here.

export function listPayrollRecords(payrollPeriodId?: string): Promise<PayrollRecord[]> {
  const query = payrollPeriodId ? `?payrollPeriodId=${payrollPeriodId}` : "";
  return apiFetch<PayrollRecord[]>(`/payroll-records${query}`);
}

export function getPayrollRecord(id: string): Promise<PayrollRecord> {
  return apiFetch<PayrollRecord>(`/payroll-records/${id}`);
}

export interface CreatePayrollRecordInput {
  payrollPeriodId: string;
  employeeId: string;
  grossAmount: number;
  deductionsAmount?: number;
}

export function createPayrollRecord(input: CreatePayrollRecordInput): Promise<PayrollRecord> {
  return apiFetch<PayrollRecord>("/payroll-records", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export interface UpdatePayrollRecordInput {
  grossAmount?: number;
  deductionsAmount?: number;
}

export function updatePayrollRecord(id: string, input: UpdatePayrollRecordInput): Promise<PayrollRecord> {
  return apiFetch<PayrollRecord>(`/payroll-records/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}
