import { apiFetch, ApiError, getToken } from "./client";
import type {
  CompliancePeriod,
  ComplianceWorkforceSnapshot,
  NitaqatComplianceRecord,
  GosiComplianceRecord,
  ComplianceException,
  ComplianceEvidence,
  ComplianceDashboard,
  ComplianceSourceType,
  GosiStatus,
  ComplianceExceptionSeverity,
} from "./types";

// MIDAD Phase D1 — thin typed wrappers over the verified Nitaqat/GOSI
// compliance API (server/src/routes/workforceCompliance.ts). No
// calculation, no authorization logic, and — critically — no Nitaqat
// classification/GOSI contribution-rate formula of any kind lives here or
// anywhere else in this codebase. INTERNAL ONLY: never imported from
// client/src/portal/.

export function getComplianceDashboard(): Promise<ComplianceDashboard> {
  return apiFetch<ComplianceDashboard>("/workforce-compliance");
}

// --- Periods ---
export function listCompliancePeriods(): Promise<CompliancePeriod[]> {
  return apiFetch<CompliancePeriod[]>("/workforce-compliance/periods");
}
export interface CreatePeriodInput {
  periodStart: string;
  periodEnd: string;
  label?: string;
}
export function createCompliancePeriod(input: CreatePeriodInput): Promise<CompliancePeriod> {
  return apiFetch<CompliancePeriod>("/workforce-compliance/periods", { method: "POST", body: JSON.stringify(input) });
}
export function updateCompliancePeriod(id: string, input: { label?: string; status?: "open" | "closed" }): Promise<CompliancePeriod> {
  return apiFetch<CompliancePeriod>(`/workforce-compliance/periods/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}

// --- Workforce snapshots ---
export function listComplianceSnapshots(): Promise<ComplianceWorkforceSnapshot[]> {
  return apiFetch<ComplianceWorkforceSnapshot[]>("/workforce-compliance/snapshots");
}
export interface CreateSnapshotInput {
  compliancePeriodId: string;
  snapshotDate: string;
  totalEmployees: number;
  saudiEmployees: number;
  nonSaudiEmployees: number;
  sourceType?: ComplianceSourceType;
  sourceReference?: string;
  notes?: string;
}
export function createComplianceSnapshot(input: CreateSnapshotInput): Promise<ComplianceWorkforceSnapshot> {
  return apiFetch<ComplianceWorkforceSnapshot>("/workforce-compliance/snapshots", { method: "POST", body: JSON.stringify(input) });
}
export function updateComplianceSnapshot(id: string, input: Partial<CreateSnapshotInput>): Promise<ComplianceWorkforceSnapshot> {
  return apiFetch<ComplianceWorkforceSnapshot>(`/workforce-compliance/snapshots/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}
export function verifyComplianceSnapshot(id: string): Promise<ComplianceWorkforceSnapshot> {
  return apiFetch<ComplianceWorkforceSnapshot>(`/workforce-compliance/snapshots/${id}/verify`, { method: "POST" });
}

// --- Nitaqat ---
export function listNitaqatRecords(): Promise<NitaqatComplianceRecord[]> {
  return apiFetch<NitaqatComplianceRecord[]>("/workforce-compliance/nitaqat");
}
export interface CreateNitaqatInput {
  compliancePeriodId: string;
  classification?: string;
  saudiCount: number;
  nonSaudiCount: number;
  totalCount: number;
  sourceType?: ComplianceSourceType;
  externalReference?: string;
  notes?: string;
}
export function createNitaqatRecord(input: CreateNitaqatInput): Promise<NitaqatComplianceRecord> {
  return apiFetch<NitaqatComplianceRecord>("/workforce-compliance/nitaqat", { method: "POST", body: JSON.stringify(input) });
}
export function updateNitaqatRecord(id: string, input: Partial<CreateNitaqatInput>): Promise<NitaqatComplianceRecord> {
  return apiFetch<NitaqatComplianceRecord>(`/workforce-compliance/nitaqat/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}
export function verifyNitaqatRecord(id: string): Promise<NitaqatComplianceRecord> {
  return apiFetch<NitaqatComplianceRecord>(`/workforce-compliance/nitaqat/${id}/verify`, { method: "POST" });
}
export function listNitaqatEvidence(id: string): Promise<ComplianceEvidence[]> {
  return apiFetch<ComplianceEvidence[]>(`/workforce-compliance/nitaqat/${id}/evidence`);
}
export async function uploadNitaqatEvidence(id: string, file: File): Promise<ComplianceEvidence> {
  const form = new FormData();
  form.append("evidence", file);
  const res = await fetch(`/api/workforce-compliance/nitaqat/${id}/evidence`, { method: "POST", headers: { Authorization: `Bearer ${getToken()}` }, body: form });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.error ?? "تعذّر رفع الملف", res.status);
  return body as ComplianceEvidence;
}
export async function downloadNitaqatEvidence(id: string, fileId: string, fileName: string): Promise<void> {
  const res = await fetch(`/api/workforce-compliance/nitaqat/${id}/evidence/${fileId}`, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!res.ok) throw new ApiError("تعذّر تنزيل الملف", res.status);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

// --- GOSI ---
export function listGosiRecords(): Promise<GosiComplianceRecord[]> {
  return apiFetch<GosiComplianceRecord[]>("/workforce-compliance/gosi");
}
export interface CreateGosiInput {
  compliancePeriodId: string;
  registeredEmployeeCount?: number;
  contributionStatus?: GosiStatus;
  submissionStatus?: GosiStatus;
  paymentStatus?: GosiStatus;
  sourceType?: ComplianceSourceType;
  externalReference?: string;
  notes?: string;
}
export function createGosiRecord(input: CreateGosiInput): Promise<GosiComplianceRecord> {
  return apiFetch<GosiComplianceRecord>("/workforce-compliance/gosi", { method: "POST", body: JSON.stringify(input) });
}
export function updateGosiRecord(id: string, input: Partial<CreateGosiInput>): Promise<GosiComplianceRecord> {
  return apiFetch<GosiComplianceRecord>(`/workforce-compliance/gosi/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}
export function verifyGosiRecord(id: string): Promise<GosiComplianceRecord> {
  return apiFetch<GosiComplianceRecord>(`/workforce-compliance/gosi/${id}/verify`, { method: "POST" });
}
export function listGosiEvidence(id: string): Promise<ComplianceEvidence[]> {
  return apiFetch<ComplianceEvidence[]>(`/workforce-compliance/gosi/${id}/evidence`);
}
export async function uploadGosiEvidence(id: string, file: File): Promise<ComplianceEvidence> {
  const form = new FormData();
  form.append("evidence", file);
  const res = await fetch(`/api/workforce-compliance/gosi/${id}/evidence`, { method: "POST", headers: { Authorization: `Bearer ${getToken()}` }, body: form });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.error ?? "تعذّر رفع الملف", res.status);
  return body as ComplianceEvidence;
}
export async function downloadGosiEvidence(id: string, fileId: string, fileName: string): Promise<void> {
  const res = await fetch(`/api/workforce-compliance/gosi/${id}/evidence/${fileId}`, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!res.ok) throw new ApiError("تعذّر تنزيل الملف", res.status);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

// --- Exceptions ---
export interface ExceptionFilters {
  status?: "open" | "in_progress" | "resolved" | "closed";
  severity?: ComplianceExceptionSeverity;
}
export function listComplianceExceptions(filters: ExceptionFilters = {}): Promise<ComplianceException[]> {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.severity) params.set("severity", filters.severity);
  const query = params.toString();
  return apiFetch<ComplianceException[]>(`/workforce-compliance/exceptions${query ? `?${query}` : ""}`);
}
export interface CreateExceptionInput {
  compliancePeriodId?: string | null;
  category?: string;
  description: string;
  severity?: ComplianceExceptionSeverity;
  dueDate?: string | null;
}
export function createComplianceException(input: CreateExceptionInput): Promise<ComplianceException> {
  return apiFetch<ComplianceException>("/workforce-compliance/exceptions", { method: "POST", body: JSON.stringify(input) });
}
export function updateComplianceException(id: string, input: Partial<CreateExceptionInput> & { status?: "open" | "in_progress" }): Promise<ComplianceException> {
  return apiFetch<ComplianceException>(`/workforce-compliance/exceptions/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}
export function resolveComplianceException(id: string): Promise<ComplianceException> {
  return apiFetch<ComplianceException>(`/workforce-compliance/exceptions/${id}/resolve`, { method: "POST" });
}
export function closeComplianceException(id: string): Promise<ComplianceException> {
  return apiFetch<ComplianceException>(`/workforce-compliance/exceptions/${id}/close`, { method: "POST" });
}
