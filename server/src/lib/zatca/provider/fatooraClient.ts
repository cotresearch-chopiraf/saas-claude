// Raw FATOORA HTTP transport (Slice 3). The ONLY module in this codebase
// that ever builds a ZATCA request or reads a raw ZATCA response — every
// other layer (fatooraProvider.ts, routes/zatca.ts, domain/) goes through
// this file's exported functions and only ever sees a normalized
// FatooraResponse or a lib/zatca/errors.ts ZatcaError subclass, never a raw
// fetch Response or response body.
//
// PRIMARY-SOURCE VERIFICATION GAP (see the Slice 3 discovery report): this
// environment's WebFetch tool cannot reach zatca.gov.sa or any other host
// (confirmed non-domain-specific network egress block), so the exact
// endpoint paths, header names, and request/response schema below could
// only be cross-corroborated via WebSearch against secondary integration
// guides (Qoyod, Jibrid, the Fatoora developer community forum) — never
// verified against ZATCA's own primary Developer Portal Manual/XSD. To
// avoid guessing, NOTHING here hardcodes a ZATCA hostname, path, or header
// value: every one of them is required from environment configuration
// (loadFatooraEndpointConfig throws a clear ZatcaConfigurationError if
// unset), and a deploying operator is expected to source the real values
// from the verified ZATCA Developer Portal before configuring production
// use. This module is genuinely functional and independently testable
// against a mock HTTP server regardless of that gap; only "these exact
// bytes are what ZATCA's production API expects" is unverified.

import { randomUUID } from "node:crypto";
import { logger } from "../../logger.js";
import {
  ZatcaAuthenticationError,
  ZatcaExternalServiceError,
  ZatcaConfigurationError,
  ZatcaNetworkError,
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

// Does the actual network call and best-effort JSON parse only — no status
// interpretation, so it is shared by both the throwing (fatooraRequest) and
// non-throwing (fatooraProbe) callers below. Never logs headers or body.
async function doFetch(
  method: "GET" | "POST",
  path: string,
  body: unknown,
  credential: ResolvedZatcaCredential,
  config: FatooraEndpointConfig,
): Promise<RawFetchResult> {
  const url = new URL(path.replace(/^\//, ""), config.baseUrl.endsWith("/") ? config.baseUrl : `${config.baseUrl}/`).toString();
  const correlationId = randomUUID();

  const headers: Record<string, string> = {
    Authorization: basicAuthHeader(credential),
    "X-Correlation-Id": correlationId,
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (config.apiVersion) headers["Accept-Version"] = config.apiVersion;

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
export async function fatooraRequest(
  method: "GET" | "POST",
  path: string,
  body: unknown,
  credential: ResolvedZatcaCredential,
  config: FatooraEndpointConfig,
): Promise<FatooraResponse> {
  const result = await doFetch(method, path, body, credential, config);

  if (result.status === 401 || result.status === 403) {
    throw new ZatcaAuthenticationError(`ZATCA rejected the configured credential (status ${result.status}, correlationId: ${result.correlationId})`);
  }
  if (result.status >= 500) {
    throw new ZatcaExternalServiceError(`ZATCA is unavailable (status ${result.status}, correlationId: ${result.correlationId})`);
  }
  if (!result.bodyWasValidJson) {
    throw new ZatcaExternalServiceError(`ZATCA returned a non-JSON response (status ${result.status}, correlationId: ${result.correlationId})`);
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
