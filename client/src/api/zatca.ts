import { apiFetch } from "./client";
import type { ZatcaConfig, ZatcaEgsUnit, ZatcaEnvironment, ZatcaSubmission, ZatcaVerifyConnectionResult } from "./types";

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
