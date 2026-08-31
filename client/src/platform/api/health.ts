import { platformApiFetch } from "./platformClient";

export interface HealthStatus {
  status: "ok" | "error";
  error?: string;
}

// /api/health/live and /api/health/ready are public (no auth required —
// see server/src/routes/health.ts), reused as-is through the same
// platformApiFetch wrapper every other platform page already uses. A
// non-2xx /ready response (real 503 when Postgres is unreachable) throws
// an ApiError, exactly like every other platformApiFetch call in this
// codebase — the dashboard interprets that as "not ready", never as a
// reason to fabricate a status.
export function checkHealthLive(): Promise<HealthStatus> {
  return platformApiFetch("/health/live");
}

export function checkHealthReady(): Promise<HealthStatus> {
  return platformApiFetch("/health/ready");
}
