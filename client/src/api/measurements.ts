import { apiFetch } from "./client";
import type { Measurement, MeasurementWithLines } from "./types";

// Thin typed wrappers over the existing, verified Measurement API
// (server/src/routes/measurements.ts) — no calculation, no authorization
// logic. measurementLines.value is frozen server-side; nothing here ever
// computes it, and "cumulative approved quantity" is never derived or
// stored client-side — it only ever appears inside an approve-attempt's
// 409 overrun body, surfaced verbatim by ApiError.

export function listMeasurements(projectId: string): Promise<Measurement[]> {
  return apiFetch<Measurement[]>(`/projects/${projectId}/measurements`);
}

export function getMeasurement(projectId: string, measurementId: string): Promise<MeasurementWithLines> {
  return apiFetch<MeasurementWithLines>(`/projects/${projectId}/measurements/${measurementId}`);
}

export interface CreateMeasurementInput {
  contractId: string;
  boqRevisionId: string;
  measurementDate: string;
  description?: string;
}

export function createMeasurement(projectId: string, input: CreateMeasurementInput): Promise<Measurement> {
  return apiFetch<Measurement>(`/projects/${projectId}/measurements`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export interface MeasurementLineInput {
  boqItemId: string;
  measuredQuantity: number;
  notes?: string;
}

export function addMeasurementLine(projectId: string, measurementId: string, input: MeasurementLineInput) {
  return apiFetch(`/projects/${projectId}/measurements/${measurementId}/items`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function deleteMeasurementLine(projectId: string, measurementId: string, lineId: string): Promise<void> {
  return apiFetch<void>(`/projects/${projectId}/measurements/${measurementId}/items/${lineId}`, { method: "DELETE" });
}

export function submitMeasurement(projectId: string, measurementId: string): Promise<Measurement> {
  return apiFetch<Measurement>(`/projects/${projectId}/measurements/${measurementId}/submit`, { method: "POST" });
}

export function approveMeasurement(projectId: string, measurementId: string): Promise<Measurement> {
  return apiFetch<Measurement>(`/projects/${projectId}/measurements/${measurementId}/approve`, { method: "POST" });
}

export function rejectMeasurement(projectId: string, measurementId: string, reason: string): Promise<Measurement> {
  return apiFetch<Measurement>(`/projects/${projectId}/measurements/${measurementId}/reject`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}
