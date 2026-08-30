import { apiFetch } from "./client";
import type {
  ComplianceAuditEvent,
  ComplianceCountry,
  ComplianceOverride,
  ComplianceProfile,
  ComplianceRulesResponse,
  ComplianceStatus,
  CreateOverrideResult,
} from "./types";

// MIDAD Phase 4 — thin typed wrappers over the existing, already-live
// Compliance / Tax Center API (server/src/routes/compliance.ts). No
// calculation, no rule logic, no status derivation — every response is
// passed through exactly as the backend returned it. Mirrors
// api/subcontractIpcs.ts's own thin-wrapper convention.

export function getCountries(): Promise<ComplianceCountry[]> {
  return apiFetch<ComplianceCountry[]>("/compliance/countries");
}

// Throws ApiError(404) when the company has not configured a profile yet —
// callers must handle that as the legitimate "not configured" state, never
// as a generic failure.
export function getProfile(): Promise<ComplianceProfile> {
  return apiFetch<ComplianceProfile>("/compliance/profile");
}

export function setProfile(input: {
  countryCode: string;
  legalEntityType?: string;
  businessActivity?: string;
  taxRegistrationStatus?: string;
}): Promise<ComplianceProfile> {
  return apiFetch<ComplianceProfile>("/compliance/profile", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// asOf is optional — the backend defaults to today when omitted, matching
// GET /compliance/rules's own default.
export function getRules(asOf?: string): Promise<ComplianceRulesResponse> {
  const query = asOf ? `?asOf=${encodeURIComponent(asOf)}` : "";
  return apiFetch<ComplianceRulesResponse>(`/compliance/rules${query}`);
}

export function getStatus(): Promise<ComplianceStatus> {
  return apiFetch<ComplianceStatus>("/compliance/status");
}

export function listOverrides(): Promise<ComplianceOverride[]> {
  return apiFetch<ComplianceOverride[]>("/compliance/overrides");
}

// The exact two-step contract: the first call (confirmed omitted/false)
// may come back as {status:"confirmation_required", warning,
// officialDefault} instead of creating anything — the caller must inspect
// the result and, only on explicit user confirmation, call this again with
// confirmed:true. This wrapper never defaults confirmed to true itself.
export function createOverride(input: {
  settingKey: string;
  value: unknown;
  effectiveFrom: string;
  effectiveTo?: string;
  reason?: string;
  confirmed?: boolean;
}): Promise<CreateOverrideResult> {
  return apiFetch<CreateOverrideResult>("/compliance/overrides", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function resetOverride(overrideId: string, reason?: string): Promise<ComplianceOverride> {
  return apiFetch<ComplianceOverride>(`/compliance/overrides/${overrideId}/reset`, {
    method: "POST",
    body: JSON.stringify(reason ? { reason } : {}),
  });
}

export function listOverrideHistory(): Promise<ComplianceOverride[]> {
  return apiFetch<ComplianceOverride[]>("/compliance/overrides/history");
}

export function listHistory(): Promise<ComplianceAuditEvent[]> {
  return apiFetch<ComplianceAuditEvent[]>("/compliance/history");
}

export function getOverridableSettings(): Promise<string[]> {
  return apiFetch<string[]>("/compliance/overridable-settings");
}
