// Raw FATOORA HTTP transport (Slice 3; Reporting/Clearance headers and
// response contract verified in the ZATCA Network Integration
// continuation). The ONLY module in this codebase that ever builds a
// ZATCA request or reads a raw ZATCA response — every other layer
// (fatooraProvider.ts, routes/zatca.ts, domain/) goes through this file's
// exported functions and only ever sees a normalized FatooraResponse or a
// lib/zatca/errors.ts ZatcaError subclass, never a raw fetch Response or
// response body.
//
// VERIFICATION STATUS — Reporting (POST /invoices/reporting/single),
// Clearance (POST /invoices/clearance/single), Compliance CSID
// (POST /compliance), and Compliance Invoice (POST /compliance/invoices):
// the exact header set, request body shape, and response schema were
// independently verified against the real "e-Invoicing Sandbox Release
// (2.1.0)" Swagger exports the user obtained directly from their own ZATCA
// Developer Portal account and shared in this conversation (reporting.pdf
// / clearance.pdf / compliance_csid.pdf / compliance_invoice.pdf) —
// genuinely read and extracted by this session, not cross-corroborated
// secondary-source guessing. See docs/zatca/ZATCA_NETWORK_INTEGRATION_SPEC.md
// for the full citation. Production CSID onboarding / renewal remain
// unverified in code (their Swagger exports were read too, but are not yet
// wired here — future slices).
//
// To avoid guessing beyond what was verified, NOTHING here hardcodes a
// ZATCA hostname or path: every one of them is required from environment
// configuration (loadFatooraEndpointConfig throws a clear
// ZatcaConfigurationError if unset). Accept-Version defaults to the
// verified literal "V2" (see below) since that's a fixed API version
// label, not a deployment choice — still overridable via
// ZATCA_FATOORA_*_API_VERSION for a future version bump. This module is
// genuinely functional and independently testable against a mock HTTP
// server; for Reporting/Clearance/Compliance CSID/Compliance Invoice the
// wire contract itself is now verified too — only real Sandbox credentials
// to test against remain unavailable in this environment.
//
// Compliance CSID (fatooraRequestComplianceCsid) and Compliance Invoice
// (fatooraRequestComplianceInvoice), both below, are deliberately SEPARATE
// functions from fatooraRequest/doFetch rather than generalizations of it:
// Compliance CSID is the one FATOORA call with no ResolvedZatcaCredential
// at all (no Authorization header — verified, see compliance_csid.pdf),
// using an OTP header instead, with its own distinct error-code vocabulary
// (Missing-OTP/Invalid-OTP/Missing-CSR/Invalid-CSR). Compliance Invoice
// returns structured, meaningful bodies under HTTP 400 itself (two
// genuinely distinct shapes — see fatooraProvider.ts's
// normalizeComplianceInvoiceResponse), unlike fatooraRequest's shared
// policy of treating any 400+ as terminal. Keeping both separate avoids
// threading extra branches through the already-verified-and-tested
// Reporting/Clearance path, which must not change.

import { randomUUID } from "node:crypto";
import { logger } from "../../logger.js";
import {
  ZatcaAuthenticationError,
  ZatcaAuthorizationError,
  ZatcaDuplicateError,
  ZatcaExternalServiceError,
  ZatcaConfigurationError,
  ZatcaNetworkError,
  ZatcaRateLimitedError,
  ZatcaValidationError,
} from "../errors.js";
import type { ResolvedZatcaCredential, ZatcaEnvironmentName } from "./types.js";

export interface FatooraEndpointConfig {
  baseUrl: string;
  compliancePath: string;
  clearancePath: string;
  reportingPath: string;
  // Compliance CSID's endpoint (POST /compliance per compliance_csid.pdf)
  // is a DIFFERENT path from compliancePath above — the existing
  // compliancePath/_COMPLIANCE_PATH env var is already used by
  // submitComplianceDocument/checkConnection for the Compliance Invoice
  // endpoint (/compliance/invoices, per this project's existing test
  // config). Renaming or repurposing that existing variable is out of
  // scope here (Slice A touches Compliance CSID only), so this is a new,
  // separately-configured, OPTIONAL path — unset unless
  // requestComplianceCsid is actually used.
  complianceCsidPath?: string;
  // Production CSID Onboarding (POST /production/csids, onboarding.pdf)
  // and Renewal (PATCH /production/csids, renewal.pdf) target the SAME
  // path with different HTTP methods — one env var covers both, unlike
  // Compliance CSID/Invoice which have genuinely distinct paths. Optional,
  // like complianceCsidPath: unset unless Slice C's methods are used.
  productionCsidPath?: string;
  apiVersion?: string;
  timeoutMs: number;
}

// Reads process.env fresh on every call (not cached at module load) —
// tests point each run at a fresh local mock-server URL, and a
// load-time snapshot would silently keep serving whatever was set first.
export function loadFatooraEndpointConfig(environment: ZatcaEnvironmentName): FatooraEndpointConfig {
  const prefix = environment === "simulation" ? "ZATCA_FATOORA_SIMULATION" : "ZATCA_FATOORA_PRODUCTION";
  const baseUrl = process.env[`${prefix}_BASE_URL`];
  const compliancePath = process.env[`${prefix}_COMPLIANCE_PATH`];
  const clearancePath = process.env[`${prefix}_CLEARANCE_PATH`];
  const reportingPath = process.env[`${prefix}_REPORTING_PATH`];
  if (!baseUrl || !compliancePath || !clearancePath || !reportingPath) {
    throw new ZatcaConfigurationError(
      `ZATCA ${environment} endpoint is not configured (${prefix}_BASE_URL / _COMPLIANCE_PATH / _CLEARANCE_PATH / ` +
        `_REPORTING_PATH). MIDAD never guesses ZATCA endpoint paths — set these from the verified ZATCA Developer ` +
        `Portal integration guide before use.`,
    );
  }
  return {
    baseUrl,
    compliancePath,
    clearancePath,
    reportingPath,
    // Optional and separate from the mandatory check above — see the
    // FatooraEndpointConfig field comment. requestComplianceCsid below
    // throws its own ZatcaConfigurationError if this is unset when needed.
    complianceCsidPath: process.env[`${prefix}_COMPLIANCE_CSID_PATH`] || undefined,
    productionCsidPath: process.env[`${prefix}_PRODUCTION_CSID_PATH`] || undefined,
    apiVersion: process.env[`${prefix}_API_VERSION`] || undefined,
    timeoutMs: Number(process.env.ZATCA_FATOORA_TIMEOUT_MS) || 15000,
  };
}

function basicAuthHeader(credential: ResolvedZatcaCredential): string {
  const token = Buffer.from(`${credential.binarySecurityToken}:${credential.secret}`, "utf8").toString("base64");
  return `Basic ${token}`;
}

interface RawFetchResult {
  status: number;
  body: unknown;
  bodyWasValidJson: boolean;
  correlationId: string;
}

// Verified literal (see file header) — the Reporting/Clearance Swagger
// export documents this as a fixed API version label, not a per-tenant or
// per-environment configuration choice.
const VERIFIED_ACCEPT_VERSION = "V2";

// Does the actual network call and best-effort JSON parse only — no status
// interpretation, so it is shared by both the throwing (fatooraRequest) and
// non-throwing (fatooraProbe) callers below. Never logs headers or body.
//
// extraHeaders lets callers (fatooraRequest below) pass endpoint-specific
// headers verified for Reporting/Clearance (Accept-Language,
// Clearance-Status) without this transport-level function needing to know
// their business meaning.
async function doFetch(
  method: "GET" | "POST",
  path: string,
  body: unknown,
  credential: ResolvedZatcaCredential,
  config: FatooraEndpointConfig,
  extraHeaders: Record<string, string> = {},
): Promise<RawFetchResult> {
  const url = new URL(path.replace(/^\//, ""), config.baseUrl.endsWith("/") ? config.baseUrl : `${config.baseUrl}/`).toString();
  const correlationId = randomUUID();

  const headers: Record<string, string> = {
    Authorization: basicAuthHeader(credential),
    "X-Correlation-Id": correlationId,
    Accept: "application/json",
    "Accept-Version": config.apiVersion || VERIFIED_ACCEPT_VERSION,
    ...extraHeaders,
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  const startedAt = Date.now();

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = controller.signal.aborted;
    logger.warn("zatca_fatoora_network_error", { correlationId, path, method, durationMs: Date.now() - startedAt, aborted });
    if (aborted) {
      throw new ZatcaNetworkError(`ZATCA request timed out after ${config.timeoutMs}ms (correlationId: ${correlationId})`);
    }
    throw new ZatcaNetworkError(`Could not reach ZATCA (correlationId: ${correlationId})`);
  } finally {
    clearTimeout(timeout);
  }

  const rawText = await res.text();
  let parsedBody: unknown = null;
  let bodyWasValidJson = true;
  if (rawText) {
    try {
      parsedBody = JSON.parse(rawText);
    } catch {
      bodyWasValidJson = false;
    }
  }

  logger.info("zatca_fatoora_response", { correlationId, path, method, status: res.status, durationMs: Date.now() - startedAt });
  return { status: res.status, body: parsedBody, bodyWasValidJson, correlationId };
}

export interface FatooraResponse {
  status: number;
  body: unknown;
  correlationId: string;
}

// For real document exchanges (compliance/clearance/reporting) — always
// throws a specific ZatcaError subclass on anything but a clean 2xx JSON
// response, so fatooraProvider.ts never has to re-interpret a status code.
//
// extraHeaders: Reporting/Clearance callers pass Clearance-Status here
// (verified required header — see file header comment); Compliance
// (unverified contract) passes none.
export async function fatooraRequest(
  method: "GET" | "POST",
  path: string,
  body: unknown,
  credential: ResolvedZatcaCredential,
  config: FatooraEndpointConfig,
  extraHeaders: Record<string, string> = {},
): Promise<FatooraResponse> {
  const result = await doFetch(method, path, body, credential, config, extraHeaders);

  // Slice 5 / Network Integration continuation — most branches map
  // standard HTTP status semantics (RFC 7231/6585); 208 and 303 are
  // Reporting/Clearance-specific codes confirmed directly against the
  // real Swagger export (see file header) rather than generic HTTP
  // meaning, and are documented as such here.
  if (result.status === 401) {
    throw new ZatcaAuthenticationError(`ZATCA rejected the configured credential (status 401, correlationId: ${result.correlationId})`);
  }
  if (result.status === 403) {
    throw new ZatcaAuthorizationError(
      `The configured credential is not authorized for this operation (status 403, correlationId: ${result.correlationId})`,
    );
  }
  if (result.status === 429) {
    throw new ZatcaRateLimitedError(`ZATCA rate-limited this request (status 429, correlationId: ${result.correlationId})`);
  }
  if (result.status >= 500) {
    throw new ZatcaExternalServiceError(`ZATCA is unavailable (status ${result.status}, correlationId: ${result.correlationId})`);
  }
  if (!result.bodyWasValidJson) {
    throw new ZatcaExternalServiceError(`ZATCA returned a non-JSON response (status ${result.status}, correlationId: ${result.correlationId})`);
  }
  // 409 (Reporting) and 208 (Clearance) both mean "this document hash was
  // already submitted successfully" per the verified Swagger doc's own
  // status descriptions ("Invoice was already Reported successfully
  // earlier." / "Invoice Hash Previously Submitted") — the same semantic
  // outcome under two different status codes, one per endpoint.
  if (result.status === 409 || result.status === 208) {
    throw new ZatcaDuplicateError(
      `ZATCA reports this document was already submitted (status ${result.status}, correlationId: ${result.correlationId})`,
    );
  }
  // 303 (Clearance only): the submitted invoice's clearance was
  // deactivated for this account — ZATCA's own guidance is to call
  // Reporting instead. This is a MIDAD-side routing mistake (called the
  // wrong endpoint for this invoice/tenant configuration), not a ZATCA
  // failure or a document-validation error.
  if (result.status === 303) {
    throw new ZatcaConfigurationError(
      `ZATCA indicates clearance is deactivated for this account — use the Reporting endpoint instead (status 303, correlationId: ${result.correlationId})`,
    );
  }
  if (result.status >= 400) {
    throw new ZatcaValidationError(`ZATCA rejected the request (status ${result.status}, correlationId: ${result.correlationId})`);
  }

  return { status: result.status, body: result.body, correlationId: result.correlationId };
}

// Compliance Invoice — POST /compliance/invoices. VERIFIED (see file
// header; compliance_invoice.pdf, "e-Invoicing Sandbox Release (2.1.0)").
// Deliberately a SEPARATE function from fatooraRequest (used unchanged by
// Reporting/Clearance) rather than a new branch inside it: this endpoint's
// own Swagger doc documents multiple genuinely distinct, structured
// response bodies under HTTP 400 itself (both the nested validationResults
// shape and the flat InvoiceResultModel shape a QR/signature/certificate
// failure returns — see fatooraProvider.ts's normalizeComplianceInvoiceResponse).
// The 400 body is this endpoint's primary way of reporting most compliance-
// check failures, not an afterthought, so this function RETURNS (never
// throws) on both 200 and 400, and only throws for the other documented
// statuses (401, 406, 500) or a transport failure — letting the normalizer
// interpret the 400 body instead of a generic throw discarding it, exactly
// as fatooraRequest's shared 400 handling would (and must continue to, for
// Reporting/Clearance, which this function does not touch).
export async function fatooraRequestComplianceInvoice(
  path: string,
  body: unknown,
  credential: ResolvedZatcaCredential,
  config: FatooraEndpointConfig,
  extraHeaders: Record<string, string> = {},
): Promise<FatooraResponse> {
  const result = await doFetch("POST", path, body, credential, config, extraHeaders);

  if (result.status === 401) {
    throw new ZatcaAuthenticationError(
      `ZATCA rejected the configured credential for the Compliance Invoice request (status 401, correlationId: ${result.correlationId})`,
    );
  }
  if (result.status === 406) {
    throw new ZatcaValidationError(
      `ZATCA rejected the API version for the Compliance Invoice request (status 406, correlationId: ${result.correlationId})`,
    );
  }
  if (result.status >= 500) {
    throw new ZatcaExternalServiceError(
      `ZATCA Compliance Invoice endpoint is unavailable (status ${result.status}, correlationId: ${result.correlationId})`,
    );
  }
  if (result.status !== 200 && result.status !== 400) {
    throw new ZatcaExternalServiceError(
      `ZATCA returned an unexpected status for the Compliance Invoice request (status ${result.status}, correlationId: ${result.correlationId})`,
    );
  }
  if (!result.bodyWasValidJson) {
    throw new ZatcaExternalServiceError(
      `ZATCA returned a non-JSON response for the Compliance Invoice request (status ${result.status}, correlationId: ${result.correlationId})`,
    );
  }

  return { status: result.status, body: result.body, correlationId: result.correlationId };
}

export interface FatooraProbeResult {
  status: number;
  correlationId: string;
  credentialRejected: boolean;
}

// For checkConnection ONLY. Deliberately does not throw on a non-2xx
// status the way fatooraRequest does — the exact ZATCA response to a bare
// probe request against the compliance endpoint is unverified (see this
// file's header comment), so the only signal this treats as conclusive is
// 401/403 (credential rejected) vs. a genuine network/timeout failure vs.
// "some other structured HTTP response came back" (credential was at
// least not explicitly rejected). fatooraProvider.ts's checkConnection is
// deliberately conservative about what it claims from this result.
export async function fatooraProbe(
  path: string,
  credential: ResolvedZatcaCredential,
  config: FatooraEndpointConfig,
): Promise<FatooraProbeResult> {
  const result = await doFetch("GET", path, undefined, credential, config);
  return { status: result.status, correlationId: result.correlationId, credentialRejected: result.status === 401 || result.status === 403 };
}

export interface ComplianceCsidRawResult {
  requestId: string;
  dispositionMessage: string;
  binarySecurityToken: string;
  secret: string;
}

// Extracts the documented {code, message} (400's {errors:[{code,message}]}
// or 500's {code,message}) into a single safe-to-log/return string. Never
// interpolates the raw response body itself (see errors.ts's file header) —
// only these two specific, documented string fields, and only when they
// are actually present as strings. Falls back to a generic message with no
// body detail for anything else, rather than guessing a shape.
function formatComplianceCsidErrorDetail(body: unknown, bodyWasValidJson: boolean): string | undefined {
  if (!bodyWasValidJson || !body || typeof body !== "object") return undefined;
  const record = body as Record<string, unknown>;

  if (Array.isArray(record.errors)) {
    const parts = record.errors
      .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
      .map((entry) => [entry.code, entry.message].filter((value) => typeof value === "string").join(": "))
      .filter((part) => part.length > 0);
    if (parts.length > 0) return parts.join("; ");
  }

  if (typeof record.code === "string" || typeof record.message === "string") {
    const part = [record.code, record.message].filter((value) => typeof value === "string").join(": ");
    if (part.length > 0) return part;
  }

  return undefined;
}

// Compliance CSID — POST /compliance. VERIFIED (see file header). The one
// FATOORA call with no ResolvedZatcaCredential: no certificate/secret
// exists yet at this point in onboarding, so authentication is the OTP
// header instead of Basic Auth, per compliance_csid.pdf's own Parameters
// table (only OTP and Accept-Version are listed; no Authorization row).
export async function fatooraRequestComplianceCsid(
  csrBase64: string,
  otp: string,
  config: FatooraEndpointConfig,
): Promise<ComplianceCsidRawResult> {
  if (!config.complianceCsidPath) {
    throw new ZatcaConfigurationError(
      "ZATCA Compliance CSID endpoint path is not configured (ZATCA_FATOORA_SIMULATION_COMPLIANCE_CSID_PATH or " +
        "ZATCA_FATOORA_PRODUCTION_COMPLIANCE_CSID_PATH). MIDAD never guesses ZATCA endpoint paths — set this from " +
        "the verified ZATCA Developer Portal Compliance CSID API Swagger documentation before use.",
    );
  }

  const url = new URL(
    config.complianceCsidPath.replace(/^\//, ""),
    config.baseUrl.endsWith("/") ? config.baseUrl : `${config.baseUrl}/`,
  ).toString();
  const correlationId = randomUUID();

  // Verified headers only — no Authorization, no Clearance-Status, no
  // Accept-Language (compliance_csid.pdf's Parameters table lists exactly
  // OTP and Accept-Version, both required).
  const headers: Record<string, string> = {
    OTP: otp,
    "Accept-Version": config.apiVersion || VERIFIED_ACCEPT_VERSION,
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Correlation-Id": correlationId,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  const startedAt = Date.now();

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      // Verified body shape (compliance_csid.pdf's CSRRequest example):
      // {"csr": "<base64 PEM CSR>"} — exactly one field.
      body: JSON.stringify({ csr: csrBase64 }),
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = controller.signal.aborted;
    logger.warn("zatca_fatoora_compliance_csid_network_error", { correlationId, durationMs: Date.now() - startedAt, aborted });
    if (aborted) {
      throw new ZatcaNetworkError(`ZATCA Compliance CSID request timed out after ${config.timeoutMs}ms (correlationId: ${correlationId})`);
    }
    throw new ZatcaNetworkError(`Could not reach ZATCA Compliance CSID endpoint (correlationId: ${correlationId})`);
  } finally {
    clearTimeout(timeout);
  }

  const rawText = await res.text();
  let parsedBody: unknown = null;
  let bodyWasValidJson = true;
  if (rawText) {
    try {
      parsedBody = JSON.parse(rawText);
    } catch {
      bodyWasValidJson = false;
    }
  }

  logger.info("zatca_fatoora_compliance_csid_response", { correlationId, status: res.status, durationMs: Date.now() - startedAt });

  const detail = formatComplianceCsidErrorDetail(parsedBody, bodyWasValidJson);
  const detailSuffix = detail ? `: ${detail}` : "";

  // Only the status codes compliance_csid.pdf actually documents (400,
  // 406, 500) get a specific mapping — no 401/403/409/429 branches, since
  // none of those are documented for this endpoint (consistent with there
  // being no Authorization header to reject or conflict on).
  if (res.status === 400) {
    throw new ZatcaValidationError(`ZATCA rejected the Compliance CSID request (status 400, correlationId: ${correlationId})${detailSuffix}`);
  }
  if (res.status === 406) {
    throw new ZatcaValidationError(
      `ZATCA rejected the API version for the Compliance CSID request (status 406, correlationId: ${correlationId})${detailSuffix}`,
    );
  }
  if (res.status >= 500) {
    throw new ZatcaExternalServiceError(`ZATCA Compliance CSID endpoint is unavailable (status ${res.status}, correlationId: ${correlationId})${detailSuffix}`);
  }
  if (res.status !== 200) {
    throw new ZatcaExternalServiceError(
      `ZATCA returned an unexpected status for the Compliance CSID request (status ${res.status}, correlationId: ${correlationId})`,
    );
  }
  if (!bodyWasValidJson) {
    throw new ZatcaExternalServiceError(`ZATCA returned a non-JSON response for the Compliance CSID request (correlationId: ${correlationId})`);
  }

  const body = (parsedBody ?? {}) as Record<string, unknown>;
  const { requestID, dispositionMessage, binarySecurityToken, secret } = body;
  if (
    (typeof requestID !== "number" && typeof requestID !== "string") ||
    typeof dispositionMessage !== "string" ||
    typeof binarySecurityToken !== "string" ||
    typeof secret !== "string"
  ) {
    throw new ZatcaExternalServiceError(
      `ZATCA Compliance CSID response did not include the expected fields (requestID/dispositionMessage/` +
        `binarySecurityToken/secret) (correlationId: ${correlationId})`,
    );
  }

  return {
    requestId: String(requestID),
    dispositionMessage,
    binarySecurityToken,
    secret,
  };
}

export interface ProductionCsidOnboardingRawResult {
  requestId: string;
  dispositionMessage: string;
  binarySecurityToken: string;
  secret: string;
}

// Production CSID Onboarding — POST /production/csids. VERIFIED (see file
// header; onboarding.pdf). Basic Auth with the Compliance CSID's own
// credential (binarySecurityToken/secret), same auth pattern as Compliance
// Invoice/Reporting/Clearance — onboarding.pdf's own Parameters table
// documents an Authorization row with exactly this description.
//
// KNOWN AMBIGUITY (Slice C, documented — never resolved by guessing):
// onboarding.pdf's 400 error list includes Missing-CurrentCCSID /
// Invalid-CurrentCCSID ("currentCCSID is a required header" /
// "currentCCSID is invalid"), but NO "currentCCSID" (or similarly named)
// parameter appears anywhere in this same export's documented Parameters
// table for this endpoint — only Authorization and Accept-Version are
// listed there. This reads as leftover/copy-pasted error-list text from
// Renewal (which genuinely deals with a "currentCSID" concept), not a
// confirmed real requirement of Onboarding — but since the contract
// cannot be confirmed either way from what was provided, this function
// deliberately sends no currentCCSID header/field and does not invent
// one. If ZATCA's real Sandbox ever returns Missing-CurrentCCSID against
// this exact call, that would be direct confirmation worth revisiting.
export async function fatooraRequestProductionCsidOnboarding(
  complianceRequestId: string,
  credential: ResolvedZatcaCredential,
  config: FatooraEndpointConfig,
): Promise<ProductionCsidOnboardingRawResult> {
  if (!config.productionCsidPath) {
    throw new ZatcaConfigurationError(
      "ZATCA Production CSID endpoint path is not configured (ZATCA_FATOORA_SIMULATION_PRODUCTION_CSID_PATH or " +
        "ZATCA_FATOORA_PRODUCTION_PRODUCTION_CSID_PATH). MIDAD never guesses ZATCA endpoint paths — set this from " +
        "the verified ZATCA Developer Portal Production CSID API Swagger documentation before use.",
    );
  }

  const url = new URL(
    config.productionCsidPath.replace(/^\//, ""),
    config.baseUrl.endsWith("/") ? config.baseUrl : `${config.baseUrl}/`,
  ).toString();
  const correlationId = randomUUID();

  const headers: Record<string, string> = {
    Authorization: basicAuthHeader(credential),
    "Accept-Version": config.apiVersion || VERIFIED_ACCEPT_VERSION,
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Correlation-Id": correlationId,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  const startedAt = Date.now();

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      // Verified body shape (onboarding.pdf's example): exactly one
      // field, compliance_request_id, submitted as a STRING even though
      // Compliance CSID's requestID is returned as a JSON number in its
      // own response — this is the documented contract's own
      // inconsistency, not a MIDAD bug. The String() conversion at the
      // call boundary (fatooraProvider.ts) is the only place this is
      // handled, deliberately explicit rather than silently coerced here.
      body: JSON.stringify({ compliance_request_id: complianceRequestId }),
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = controller.signal.aborted;
    logger.warn("zatca_fatoora_production_csid_onboarding_network_error", { correlationId, durationMs: Date.now() - startedAt, aborted });
    if (aborted) {
      throw new ZatcaNetworkError(
        `ZATCA Production CSID (Onboarding) request timed out after ${config.timeoutMs}ms (correlationId: ${correlationId})`,
      );
    }
    throw new ZatcaNetworkError(`Could not reach ZATCA Production CSID (Onboarding) endpoint (correlationId: ${correlationId})`);
  } finally {
    clearTimeout(timeout);
  }

  const rawText = await res.text();
  let parsedBody: unknown = null;
  let bodyWasValidJson = true;
  if (rawText) {
    try {
      parsedBody = JSON.parse(rawText);
    } catch {
      bodyWasValidJson = false;
    }
  }

  logger.info("zatca_fatoora_production_csid_onboarding_response", { correlationId, status: res.status, durationMs: Date.now() - startedAt });

  const detail = formatComplianceCsidErrorDetail(parsedBody, bodyWasValidJson);
  const detailSuffix = detail ? `: ${detail}` : "";

  // Only the status codes onboarding.pdf actually documents (400, 401,
  // 406, 500) get a specific mapping.
  if (res.status === 401) {
    throw new ZatcaAuthenticationError(
      `ZATCA rejected the configured credential for the Production CSID (Onboarding) request (status 401, correlationId: ${correlationId})`,
    );
  }
  if (res.status === 400) {
    throw new ZatcaValidationError(
      `ZATCA rejected the Production CSID (Onboarding) request (status 400, correlationId: ${correlationId})${detailSuffix}`,
    );
  }
  if (res.status === 406) {
    throw new ZatcaValidationError(
      `ZATCA rejected the API version for the Production CSID (Onboarding) request (status 406, correlationId: ${correlationId})`,
    );
  }
  if (res.status >= 500) {
    throw new ZatcaExternalServiceError(
      `ZATCA Production CSID (Onboarding) endpoint is unavailable (status ${res.status}, correlationId: ${correlationId})${detailSuffix}`,
    );
  }
  if (res.status !== 200) {
    throw new ZatcaExternalServiceError(
      `ZATCA returned an unexpected status for the Production CSID (Onboarding) request (status ${res.status}, correlationId: ${correlationId})`,
    );
  }
  if (!bodyWasValidJson) {
    throw new ZatcaExternalServiceError(
      `ZATCA returned a non-JSON response for the Production CSID (Onboarding) request (correlationId: ${correlationId})`,
    );
  }

  const body = (parsedBody ?? {}) as Record<string, unknown>;
  const { requestID, dispositionMessage, binarySecurityToken, secret } = body;
  if (
    (typeof requestID !== "number" && typeof requestID !== "string") ||
    typeof dispositionMessage !== "string" ||
    typeof binarySecurityToken !== "string" ||
    typeof secret !== "string"
  ) {
    throw new ZatcaExternalServiceError(
      `ZATCA Production CSID (Onboarding) response did not include the expected fields (requestID/dispositionMessage/` +
        `binarySecurityToken/secret) (correlationId: ${correlationId})`,
    );
  }

  return {
    requestId: String(requestID),
    dispositionMessage,
    binarySecurityToken,
    secret,
  };
}

export type ProductionCsidRenewalRawResult =
  | { outcome: "issued"; requestId: string; tokenType: string | null; dispositionMessage: string; binarySecurityToken: string; secret: string }
  | { outcome: "not_compliant"; requestId: string; tokenType: string | null; dispositionMessage: string; binarySecurityToken: string; secret: string };

function parseProductionCsidRenewalFields(
  body: Record<string, unknown>,
  correlationId: string,
): Omit<ProductionCsidRenewalRawResult, "outcome"> {
  const { requestID, tokenType, dispositionMessage, binarySecurityToken, secret } = body;
  if (
    (typeof requestID !== "number" && typeof requestID !== "string") ||
    (tokenType !== null && typeof tokenType !== "string") ||
    typeof dispositionMessage !== "string" ||
    typeof binarySecurityToken !== "string" ||
    typeof secret !== "string"
  ) {
    throw new ZatcaExternalServiceError(
      `ZATCA Production CSID (Renewal) response did not include the expected fields (requestID/tokenType/` +
        `dispositionMessage/binarySecurityToken/secret) (correlationId: ${correlationId})`,
    );
  }
  return { requestId: String(requestID), tokenType, dispositionMessage, binarySecurityToken, secret };
}

// Production CSID Renewal — PATCH /production/csids. VERIFIED (see file
// header; renewal.pdf).
//
// KNOWN AMBIGUITY (Slice C, documented — never resolved by guessing):
// renewal.pdf's captured Parameters table lists only OTP (header,
// required), accept-language (header, optional), and Accept-Version
// (header, required) — UNLIKE Onboarding and Compliance Invoice, no
// "Authorization" row with a description appears anywhere in this
// export's extracted text for this endpoint, even though a 401
// "Unauthorized" response IS documented as a possible outcome. Every
// other authenticated CSID/invoice endpoint in this project uses Basic
// Auth (binarySecurityToken:secret), so it is plausible the same applies
// here and the row simply was not captured by this session's text
// extraction (Swagger UI sometimes renders a global "Authorize" padlock
// rather than a per-endpoint parameter row) — but that would be a guess,
// not something confirmed by what was provided. Per this slice's explicit
// instruction not to invent undocumented Authorization behavior, this
// function sends NO Authorization header and takes no credential
// parameter. The 401 status is still mapped (it is a documented response
// code for this endpoint), but real-world testing may reveal this call
// actually requires a credential this function does not send — revisit
// only with clearer Swagger evidence, never by guessing now.
//
// 428 NOT_COMPLIANT is a genuinely distinct outcome (see the special
// {"value": {...}} wrapper documented in renewal.pdf) — this function
// never normalizes it into the same shape as a 200 "issued" success;
// callers must branch on the returned `outcome` discriminant.
export async function fatooraRequestProductionCsidRenewal(
  csrBase64: string,
  otp: string,
  config: FatooraEndpointConfig,
): Promise<ProductionCsidRenewalRawResult> {
  if (!config.productionCsidPath) {
    throw new ZatcaConfigurationError(
      "ZATCA Production CSID endpoint path is not configured (ZATCA_FATOORA_SIMULATION_PRODUCTION_CSID_PATH or " +
        "ZATCA_FATOORA_PRODUCTION_PRODUCTION_CSID_PATH). MIDAD never guesses ZATCA endpoint paths — set this from " +
        "the verified ZATCA Developer Portal Production CSID (Renewal) API Swagger documentation before use.",
    );
  }

  const url = new URL(
    config.productionCsidPath.replace(/^\//, ""),
    config.baseUrl.endsWith("/") ? config.baseUrl : `${config.baseUrl}/`,
  ).toString();
  const correlationId = randomUUID();

  // Verified headers only (see ambiguity note above) — no Authorization.
  const headers: Record<string, string> = {
    OTP: otp,
    "Accept-Version": config.apiVersion || VERIFIED_ACCEPT_VERSION,
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Correlation-Id": correlationId,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  const startedAt = Date.now();

  let res: Response;
  try {
    res = await fetch(url, {
      method: "PATCH",
      headers,
      // Verified body shape (renewal.pdf's example): {"csr": "<base64
      // PEM CSR>"} — the same single-field shape as Compliance CSID.
      body: JSON.stringify({ csr: csrBase64 }),
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = controller.signal.aborted;
    logger.warn("zatca_fatoora_production_csid_renewal_network_error", { correlationId, durationMs: Date.now() - startedAt, aborted });
    if (aborted) {
      throw new ZatcaNetworkError(
        `ZATCA Production CSID (Renewal) request timed out after ${config.timeoutMs}ms (correlationId: ${correlationId})`,
      );
    }
    throw new ZatcaNetworkError(`Could not reach ZATCA Production CSID (Renewal) endpoint (correlationId: ${correlationId})`);
  } finally {
    clearTimeout(timeout);
  }

  const rawText = await res.text();
  let parsedBody: unknown = null;
  let bodyWasValidJson = true;
  if (rawText) {
    try {
      parsedBody = JSON.parse(rawText);
    } catch {
      bodyWasValidJson = false;
    }
  }

  logger.info("zatca_fatoora_production_csid_renewal_response", { correlationId, status: res.status, durationMs: Date.now() - startedAt });

  const detail = formatComplianceCsidErrorDetail(parsedBody, bodyWasValidJson);
  const detailSuffix = detail ? `: ${detail}` : "";

  if (res.status === 401) {
    throw new ZatcaAuthenticationError(
      `ZATCA rejected the request for the Production CSID (Renewal) request (status 401, correlationId: ${correlationId})`,
    );
  }
  if (res.status === 400) {
    throw new ZatcaValidationError(
      `ZATCA rejected the Production CSID (Renewal) request (status 400, correlationId: ${correlationId})${detailSuffix}`,
    );
  }
  if (res.status === 406) {
    throw new ZatcaValidationError(
      `ZATCA rejected the API version for the Production CSID (Renewal) request (status 406, correlationId: ${correlationId})`,
    );
  }
  if (res.status >= 500) {
    throw new ZatcaExternalServiceError(
      `ZATCA Production CSID (Renewal) endpoint is unavailable (status ${res.status}, correlationId: ${correlationId})${detailSuffix}`,
    );
  }
  // 428 (verified — renewal.pdf's own documented status): NOT_COMPLIANT,
  // wrapped in {"value": {...}}. Never treated as a transport error and
  // never normalized into "issued" — a distinct, legitimate outcome.
  if (res.status === 428) {
    if (!bodyWasValidJson) {
      throw new ZatcaExternalServiceError(
        `ZATCA returned a non-JSON 428 response for the Production CSID (Renewal) request (correlationId: ${correlationId})`,
      );
    }
    const wrapper = (parsedBody ?? {}) as Record<string, unknown>;
    const value = wrapper.value;
    if (!value || typeof value !== "object") {
      throw new ZatcaExternalServiceError(
        `ZATCA 428 NOT_COMPLIANT response for the Production CSID (Renewal) request was missing the documented ` +
          `"value" wrapper (correlationId: ${correlationId})`,
      );
    }
    return { outcome: "not_compliant", ...parseProductionCsidRenewalFields(value as Record<string, unknown>, correlationId) };
  }
  if (res.status !== 200) {
    throw new ZatcaExternalServiceError(
      `ZATCA returned an unexpected status for the Production CSID (Renewal) request (status ${res.status}, correlationId: ${correlationId})`,
    );
  }
  if (!bodyWasValidJson) {
    throw new ZatcaExternalServiceError(
      `ZATCA returned a non-JSON response for the Production CSID (Renewal) request (correlationId: ${correlationId})`,
    );
  }

  return { outcome: "issued", ...parseProductionCsidRenewalFields(parsedBody as Record<string, unknown>, correlationId) };
}
