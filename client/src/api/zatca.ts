import { apiFetch } from "./client";
import type {
  ZatcaConfig,
  ZatcaEgsUnit,
  ZatcaEnvironment,
  ZatcaOnboardingStatusSummary,
  ZatcaPrepareResult,
  ZatcaSubmission,
  ZatcaSubmissionsPage,
  ZatcaSubmitResult,
  ZatcaVerifyConnectionResult,
  ZatcaCsrFields,
  ZatcaCsrCustomAttributeOids,
  ZatcaCsrGenerationResult,
  ZatcaCsrInstance,
  ZatcaCsidConfirmResult,
  ZatcaComplianceCsidRequestResult,
  ZatcaComplianceLifecycle,
  ZatcaComplianceDocumentType,
  ZatcaInvoiceFamily,
  ZatcaComplianceInvoiceResult,
  ZatcaComplianceAttempt,
  ZatcaProductionCsidRequestResult,
  ZatcaProductionCsidRenewalResult,
  ZatcaProviderOperation,
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

// AC-08 — paginated; the caller decides how much of the first page it
// needs (see ZatcaSettings.tsx's HistoryCard, which shows only the most
// recent submissions and does not need offset/limit controls of its own).
export interface ListZatcaSubmissionsInput {
  limit?: number;
  offset?: number;
}

export function listAllZatcaSubmissions(input: ListZatcaSubmissionsInput = {}): Promise<ZatcaSubmissionsPage> {
  const params = new URLSearchParams();
  if (input.limit !== undefined) params.set("limit", String(input.limit));
  if (input.offset !== undefined) params.set("offset", String(input.offset));
  const qs = params.toString();
  return apiFetch<ZatcaSubmissionsPage>(`/zatca/submissions${qs ? `?${qs}` : ""}`);
}

// --- ZATCA Customer Onboarding & Compliance Center ------------------------
// Thin wrappers over server/src/routes/zatca.ts's CSR/CSID/Compliance
// CSID/Compliance Invoice/Production CSID/Renewal routes, mirroring every
// function above's own thin-wrapper convention — no derived state, no
// fabricated success, every response passed through exactly as the backend
// returned it. The OTP is the only sensitive value any of these functions
// ever sends; none of them ever receive one back (see routes/zatca.ts's
// comments on why the backend never echoes an OTP, private key, or
// binarySecurityToken/secret in a response body).

export function getZatcaCsrInstance(egsUnitId: string): Promise<{ csrInstance: ZatcaCsrInstance | null }> {
  return apiFetch(`/zatca/egs-units/${egsUnitId}/csr`);
}

export function generateZatcaCsr(
  egsUnitId: string,
  input: { otp: string; fields: ZatcaCsrFields; customAttributeOids: ZatcaCsrCustomAttributeOids },
): Promise<ZatcaCsrGenerationResult> {
  return apiFetch<ZatcaCsrGenerationResult>(`/zatca/egs-units/${egsUnitId}/csr`, { method: "POST", body: JSON.stringify(input) });
}

export function confirmZatcaCsid(
  egsUnitId: string,
  input: { binarySecurityToken: string; secret: string; stage: "compliance" | "production" },
): Promise<ZatcaCsidConfirmResult> {
  return apiFetch<ZatcaCsidConfirmResult>(`/zatca/egs-units/${egsUnitId}/csid`, { method: "POST", body: JSON.stringify(input) });
}

export function getZatcaComplianceLifecycle(egsUnitId: string): Promise<{ complianceLifecycle: ZatcaComplianceLifecycle | null }> {
  return apiFetch(`/zatca/egs-units/${egsUnitId}/compliance-csid`);
}

// The one real ZATCA network call in this onboarding flow that the browser
// can trigger without the tenant leaving MIDAD — requests a real Compliance
// CSID. Per domain/complianceCsid.ts's own documented architectural
// boundary, this deliberately does NOT activate the EGS unit's connection
// by itself; confirmZatcaCsid (stage "compliance") remains the separate,
// required step — see the ZATCA Center UI's own explanatory copy for why.
export function requestZatcaComplianceCsid(
  egsUnitId: string,
  input: { otp: string; csrBase64: string },
): Promise<ZatcaComplianceCsidRequestResult> {
  return apiFetch<ZatcaComplianceCsidRequestResult>(`/zatca/egs-units/${egsUnitId}/compliance-csid`, { method: "POST", body: JSON.stringify(input) });
}

export function listZatcaComplianceAttempts(egsUnitId: string): Promise<{ attempts: ZatcaComplianceAttempt[] }> {
  return apiFetch(`/zatca/egs-units/${egsUnitId}/compliance-invoices`);
}

export function submitZatcaComplianceInvoice(
  egsUnitId: string,
  input: { documentType: ZatcaComplianceDocumentType; invoiceFamily: ZatcaInvoiceFamily; invoiceXmlBase64: string; invoiceHashBase64: string; uuid: string },
): Promise<ZatcaComplianceInvoiceResult> {
  return apiFetch<ZatcaComplianceInvoiceResult>(`/zatca/egs-units/${egsUnitId}/compliance-invoices`, { method: "POST", body: JSON.stringify(input) });
}

export function listZatcaProductionCsidOperations(egsUnitId: string): Promise<{ operations: ZatcaProviderOperation[] }> {
  return apiFetch(`/zatca/egs-units/${egsUnitId}/production-csid`);
}

export function requestZatcaProductionCsid(egsUnitId: string): Promise<ZatcaProductionCsidRequestResult> {
  return apiFetch<ZatcaProductionCsidRequestResult>(`/zatca/egs-units/${egsUnitId}/production-csid`, { method: "POST" });
}

export function renewZatcaProductionCsid(
  egsUnitId: string,
  input: { csrBase64: string; otp: string },
): Promise<ZatcaProductionCsidRenewalResult> {
  return apiFetch<ZatcaProductionCsidRenewalResult>(`/zatca/egs-units/${egsUnitId}/production-csid/renew`, { method: "POST", body: JSON.stringify(input) });
}
