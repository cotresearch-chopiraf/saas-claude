// Raw FATOORA HTTP transport (Slice 3; Reporting/Clearance headers and
// response contract verified in the ZATCA Network Integration
// continuation). The ONLY module in this codebase that ever builds a
// ZATCA request or reads a raw ZATCA response — every other layer
// (fatooraProvider.ts, routes/zatca.ts, domain/) goes through this file's
// exported functions and only ever sees a normalized FatooraResponse or a
// lib/zatca/errors.ts ZatcaError subclass, never a raw fetch Response or
// response body.
//
// VERIFICATION STATUS — Reporting (POST /invoices/reporting/single) and
// Clearance (POST /invoices/clearance/single): the exact header set
// (Authorization, Accept-Language, Clearance-Status, Accept-Version),
// request body shape ({invoiceHash, uuid, invoice}), and response schema
// were independently verified against the real "e-Invoicing Sandbox
// Release (2.1.0)" Swagger export the user obtained directly from their
// own ZATCA Developer Portal account and shared in this conversation
// (reporting.pdf / clearance.pdf) — genuinely read and extracted by this
// session, not cross-corroborated secondary-source guessing. See
// docs/zatca/ZATCA_NETWORK_INTEGRATION_SPEC.md for the full citation.
// Compliance CSID / Production CSID onboarding remain unverified — no
// Swagger export for those was available.
//
// To avoid guessing beyond what was verified, NOTHING here hardcodes a
// ZATCA hostname or path: every one of them is required from environment
// configuration (loadFatooraEndpointConfig throws a clear
// ZatcaConfigurationError if unset). Accept-Version defaults to the
// verified literal "V2" (see below) since that's a fixed API version
// label, not a deployment choice — still overridable via
// ZATCA_FATOORA_*_API_VERSION for a future version bump. This module is
// genuinely functional and independently testable against a mock HTTP
// server; for Reporting/Clearance the wire contract itself is now
// verified too — only real Sandbox credentials to test against remain
// unavailable in this environment. Compliance CSID's contract is still
// unverified, so submitComplianceDocument's request/response handling
// below remains the older, conservative cross-corroborated shape.

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
