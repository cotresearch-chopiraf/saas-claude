import { apiFetch } from "./client";
import type { ForecastMethod, ForecastResult, ForecastSnapshot } from "./types";

// Thin typed wrappers over the existing, verified Forecast API
// (server/src/routes/forecast.ts) — no calculation, no authorization
// logic. Every ETC/EAC/variance figure is computed exclusively by
// lib/forecast.ts's calculateForecast(); nothing here ever reproduces
// that arithmetic.

export function getForecast(projectId: string): Promise<ForecastResult> {
  return apiFetch<ForecastResult>(`/projects/${projectId}/forecast`);
}

export function listForecastSnapshots(projectId: string): Promise<ForecastSnapshot[]> {
  return apiFetch<ForecastSnapshot[]>(`/projects/${projectId}/forecast/snapshots`);
}

export function getForecastSnapshot(projectId: string, snapshotId: string): Promise<ForecastSnapshot> {
  return apiFetch<ForecastSnapshot>(`/projects/${projectId}/forecast/snapshots/${snapshotId}`);
}

export interface CreateForecastSnapshotInput {
  method: ForecastMethod;
  asOfDate?: string;
  notes?: string;
}

export function createForecastSnapshot(projectId: string, input: CreateForecastSnapshotInput): Promise<ForecastSnapshot> {
  return apiFetch<ForecastSnapshot>(`/projects/${projectId}/forecast/snapshots`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}
