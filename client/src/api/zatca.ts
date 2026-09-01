import { apiFetch } from "./client";
import type {
  ZatcaConfig,
  ZatcaEgsUnit,
  ZatcaEnvironment,
  ZatcaOnboardingStatusSummary,
  ZatcaPrepareResult,
  ZatcaSubmission,
  ZatcaSubmitResult,
  ZatcaVerifyConnectionResult,
} from "./types";

// MIDAD ZATCA e-invoicing (Slice 3) — thin typed wrappers over
// server/src/routes/zatca.ts. No status derivation, no fabricated state:
// every response is passed through exactly as the backend returned it,
// mirroring api/compliance.ts's own thin-wrapper convention.

export function getZatcaConfig(): Promise<ZatcaConfig> {
  return apiFetch<ZatcaConfig>("/zatca/config");
}

export function updateZatcaIdentity(input: { vatNumber?: string; commercialRegistration?: string }): Promise<{ identity: ZatcaConfig["identity"] }> {
  return apiFetch("/zatca/config", { method: "PATCH", body: JSON.stringify(input) });
}

export function createZatcaEgsUnit(input: { name: string; environment: ZatcaEnvironment }): Promise<ZatcaEgsUnit> {
  return apiFetch<ZatcaEgsUnit>("/zatca/egs-units", { method: "POST", body: JSON.stringify(input) });
}

export function deactivateZatcaEgsUnit(egsUnitId: string): Promise<ZatcaEgsUnit> {
  return apiFetch<ZatcaEgsUnit>(`/zatca/egs-units/${egsUnitId}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "deactivated" }),
  });
}

// The only place raw credential material is ever sent from the browser —
// never stored client-side, never included in any other request.
export function configureZatcaCredential(egsUnitId: string, input: { binarySecurityToken: string; secret: string }): Promise<ZatcaEgsUnit> {
  return apiFetch<ZatcaEgsUnit>(`/zatca/egs-units/${egsUnitId}/credential`, { method: "POST", body: JSON.stringify(input) });
}

export function clearZatcaCredential(egsUnitId: string): Promise<ZatcaEgsUnit> {
  return apiFetch<ZatcaEgsUnit>(`/zatca/egs-units/${egsUnitId}/credential`, { method: "DELETE" });
}

export function verifyZatcaConnection(egsUnitId: string): Promise<ZatcaVerifyConnectionResult> {
  return apiFetch<ZatcaVerifyConnectionResult>(`/zatca/egs-units/${egsUnitId}/verify-connection`, { method: "POST" });
}

export function listZatcaSubmissions(egsUnitId: string): Promise<ZatcaSubmission[]> {
  return apiFetch<ZatcaSubmission[]>(`/zatca/egs-units/${egsUnitId}/submissions`);
}

export function getZatcaOnboardingStatus(): Promise<ZatcaOnboardingStatusSummary> {
  return apiFetch<ZatcaOnboardingStatusSummary>("/zatca/onboarding-status");
}

// Builds the real UBL XML + hash/ICV/PIH for a real invoice, without
// signing or contacting ZATCA — see server/src/routes/zatca.ts's own
// comment on this route. Idempotent: calling this again for the same
// (egsUnitId, invoiceId) returns the submission that already exists.
export function prepareZatcaSubmission(egsUnitId: string, invoiceId: string): Promise<ZatcaPrepareResult> {
  return apiFetch<ZatcaPrepareResult>(`/zatca/egs-units/${egsUnitId}/invoices/${invoiceId}/prepare`, { method: "POST" });
}

// The real Simulation submission attempt — in this environment this
// always ends honestly at the signing boundary (category "not_implemented")
// since no verified ZATCA cryptographic specification or real credential
// material exists here. Never returns a fabricated accepted/cleared
// result. apiFetch throws on a non-2xx status, so callers should read the
// thrown ApiError's message/category for the 400/404/409/501 cases this
// route can return, not just the resolved value.
export function submitZatcaSubmission(submissionId: string): Promise<ZatcaSubmitResult> {
  return apiFetch<ZatcaSubmitResult>(`/zatca/submissions/${submissionId}/submit`, { method: "POST" });
}

export function listAllZatcaSubmissions(): Promise<ZatcaSubmission[]> {
  return apiFetch<ZatcaSubmission[]>("/zatca/submissions");
}
