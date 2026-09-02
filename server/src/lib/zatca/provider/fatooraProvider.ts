// FATOORA implementation of ZatcaProvider (Slice 3; Reporting/Clearance
// verified in the ZATCA Network Integration continuation — see
// fatooraClient.ts's header comment for the exact provenance: the real
// "e-Invoicing Sandbox Release (2.1.0)" Swagger export the user obtained
// from their own ZATCA Developer Portal account and shared directly in
// this conversation). Endpoint paths and hostnames are still sourced from
// environment configuration, never hardcoded here — the Swagger export
// confirms the WIRE CONTRACT (headers, body shape, response schema), not
// a specific deployment's base URL. Callers (domain/routes) depend only
// on ./types.ts's ZatcaProvider interface, never on this class or on
// fatooraClient.ts directly.
//
// submitComplianceDocument's contract remains UNVERIFIED — no Swagger
// export for Compliance CSID/compliance checks was available — so it
// still uses the older, conservative cross-corroborated normalization
// (normalizeUnverifiedComplianceResponse), kept separate and clearly
// labeled rather than assumed to share Reporting/Clearance's schema.

import { fatooraProbe, fatooraRequest, loadFatooraEndpointConfig } from "./fatooraClient.js";
import { ZatcaExternalServiceError } from "../errors.js";
import type {
  ResolvedZatcaCredential,
  ZatcaConnectionCheckResult,
  ZatcaDocumentSubmissionInput,
  ZatcaEnvironmentName,
  ZatcaProvider,
  ZatcaSubmissionResult,
} from "./types.js";

// Verified headers (see file header) — Clearance-Status is required by
// both the Reporting and Clearance endpoints and reflects which endpoint
// is being called, not a per-invoice runtime choice: "0" for Reporting,
// "1" for Clearance, per the Swagger doc's own header description
// ("0" when clearance is disabled, "1" when clearance is enabled).
const CLEARANCE_STATUS_DISABLED = { "Clearance-Status": "0" };
const CLEARANCE_STATUS_ENABLED = { "Clearance-Status": "1" };
const ACCEPT_LANGUAGE_EN = { "Accept-Language": "en" };

export class FatooraProvider implements ZatcaProvider {
  constructor(private readonly environment: ZatcaEnvironmentName) {}

  getEnvironment(): ZatcaEnvironmentName {
    return this.environment;
  }

  // Reads a real response from ZATCA when credentials and the environment
  // endpoint are configured; never fabricates a "connected" result. What
  // this can and cannot conclude (see fatooraClient.ts's fatooraProbe doc
  // comment): 401/403 -> definitely rejected; a network/timeout failure ->
  // definitely not connected; any other HTTP response -> "reached the
  // configured ZATCA endpoint and the credential was not rejected at the
  // transport/auth layer" — NOT a claim that the certificate is valid for
  // clearance/reporting, which only a real document submission can prove.
  async checkConnection(credential: ResolvedZatcaCredential): Promise<ZatcaConnectionCheckResult> {
    const config = loadFatooraEndpointConfig(this.environment);
    const probe = await fatooraProbe(config.compliancePath, credential, config);
    const checkedAt = new Date();
    if (probe.credentialRejected) {
      return {
        connected: false,
        checkedAt,
        correlationId: probe.correlationId,
        detail: `ZATCA rejected the configured credential (status ${probe.status})`,
      };
    }
    return {
      connected: true,
      checkedAt,
      correlationId: probe.correlationId,
      detail: `Reached the ${this.environment} ZATCA endpoint; credential not rejected (status ${probe.status})`,
    };
  }

  // Compliance document checks — contract UNVERIFIED (no Swagger export
  // available for this endpoint). Kept exactly as before: conservative,
  // generic status-field detection, never assumed to share Reporting/
  // Clearance's now-verified schema.
  async submitComplianceDocument(
    credential: ResolvedZatcaCredential,
    input: ZatcaDocumentSubmissionInput,
  ): Promise<ZatcaSubmissionResult> {
    const config = loadFatooraEndpointConfig(this.environment);
    const res = await fatooraRequest("POST", config.compliancePath, buildDocumentBody(input), credential, config);
    return normalizeUnverifiedComplianceResponse(res, "compliance_pending");
  }

  // Clearance — VERIFIED contract (POST /invoices/clearance/single).
  async clearInvoice(credential: ResolvedZatcaCredential, input: ZatcaDocumentSubmissionInput): Promise<ZatcaSubmissionResult> {
    const config = loadFatooraEndpointConfig(this.environment);
    const res = await fatooraRequest(
      "POST",
      config.clearancePath,
      buildDocumentBody(input),
      credential,
      config,
      { ...ACCEPT_LANGUAGE_EN, ...CLEARANCE_STATUS_ENABLED },
    );
    return normalizeClearanceResponse(res);
  }

  // Reporting — VERIFIED contract (POST /invoices/reporting/single).
  async reportInvoice(credential: ResolvedZatcaCredential, input: ZatcaDocumentSubmissionInput): Promise<ZatcaSubmissionResult> {
    const config = loadFatooraEndpointConfig(this.environment);
    const res = await fatooraRequest(
      "POST",
      config.reportingPath,
      buildDocumentBody(input),
      credential,
      config,
      { ...ACCEPT_LANGUAGE_EN, ...CLEARANCE_STATUS_DISABLED },
    );
    return normalizeReportingResponse(res);
  }
}

// Field names (invoiceHash / uuid / invoice) — VERIFIED against the real
// Reporting/Clearance Swagger export's request body examples (see file
// header). The same shape is reused for the still-unverified Compliance
// endpoint since no contrary evidence exists for it and this is the one
// piece of the compliance contract explicitly confirmed elsewhere.
function buildDocumentBody(input: ZatcaDocumentSubmissionInput): unknown {
  return {
    invoiceHash: input.invoiceHashBase64,
    uuid: input.uuid,
    invoice: input.invoiceXmlBase64,
  };
}

interface ValidationResults {
  status?: string;
  infoMessages?: unknown[];
  warningMessages?: unknown[];
  errorMessages?: unknown[];
}

// Reporting response — VERIFIED shape:
//   { validationResults: { status: "PASS"|"WARNING"|"ERROR", ... },
//     reportingStatus: "REPORTED" | "NOT_REPORTED" }
// A "WARNING" validationResults.status with reportingStatus "REPORTED" is
// still a real success (the Swagger doc's own 202 example) — warnings are
// carried through, never treated as rejection.
function normalizeReportingResponse(res: { body: unknown; correlationId: string }): ZatcaSubmissionResult {
  const body = (res.body ?? {}) as Record<string, unknown>;
  const reportingStatus = body.reportingStatus;
  const validationResults = body.validationResults as ValidationResults | undefined;

  if (reportingStatus !== "REPORTED" && reportingStatus !== "NOT_REPORTED") {
    throw new ZatcaExternalServiceError(
      `ZATCA Reporting response did not include a recognized reportingStatus (correlationId: ${res.correlationId})`,
    );
  }

  return {
    status: reportingStatus === "REPORTED" ? "reported" : "rejected",
    correlationId: res.correlationId,
    rawStatus: reportingStatus,
    warnings: validationResults,
    respondedAt: new Date(),
  };
}

// Clearance response — VERIFIED shape:
//   { validationResults: {...}, clearanceStatus: "CLEARED"|"NOT_CLEARED",
//     clearedInvoice: string | null }
// clearedInvoice (the real ZATCA-signed/stamped invoice XML, base64) is
// only ever populated from a genuine "CLEARED" response — never derived
// or fabricated.
function normalizeClearanceResponse(res: { body: unknown; correlationId: string }): ZatcaSubmissionResult {
  const body = (res.body ?? {}) as Record<string, unknown>;
  const clearanceStatus = body.clearanceStatus;
  const validationResults = body.validationResults as ValidationResults | undefined;

  if (clearanceStatus !== "CLEARED" && clearanceStatus !== "NOT_CLEARED") {
    throw new ZatcaExternalServiceError(
      `ZATCA Clearance response did not include a recognized clearanceStatus (correlationId: ${res.correlationId})`,
    );
  }

  const clearedInvoice = clearanceStatus === "CLEARED" && typeof body.clearedInvoice === "string" ? body.clearedInvoice : undefined;

  return {
    status: clearanceStatus === "CLEARED" ? "cleared" : "rejected",
    correlationId: res.correlationId,
    rawStatus: clearanceStatus,
    warnings: validationResults,
    clearedInvoiceXmlBase64: clearedInvoice,
    respondedAt: new Date(),
  };
}

// Compliance — UNCHANGED from Slice 5 (contract still unverified). Some
// ZATCA responses return HTTP 200 with the actual outcome only visible
// inside the body (a document can be rejected with a 200 status and
// clearanceStatus/reportingStatus/validationResults describing why) — a
// commonly corroborated behavior across the secondary sources checked
// for this specific, still-unverified endpoint. fatooraRequest() already
// throws on a non-2xx status; this function is what catches the
// "200 OK but actually rejected" case so a rejected document is never
// reported to the caller as accepted.
//
// Equally important the other way: a 2xx response whose body carries NONE
// of the recognized status fields is NOT treated as success either — this
// function must never convert an unrecognized/ambiguous result into a
// claimed success. It throws ZatcaExternalServiceError instead, the same
// category used for "reached ZATCA but got something unusable".
function normalizeUnverifiedComplianceResponse(
  res: { body: unknown; correlationId: string },
  successStatus: ZatcaSubmissionResult["status"],
): ZatcaSubmissionResult {
  const body = (res.body ?? {}) as Record<string, unknown>;
  const clearanceStatus = typeof body.clearanceStatus === "string" ? body.clearanceStatus : undefined;
  const reportingStatus = typeof body.reportingStatus === "string" ? body.reportingStatus : undefined;
  const genericStatus = typeof body.status === "string" ? body.status : undefined;
  const validationResults = body.validationResults as { status?: string } | undefined;

  const rawStatus = clearanceStatus ?? reportingStatus ?? genericStatus;
  const rejected = [clearanceStatus, reportingStatus, validationResults?.status]
    .filter((value): value is string => typeof value === "string")
    .some((value) => /reject|error|fail|not_reported|not_cleared/i.test(value));

  if (!rejected && rawStatus === undefined && validationResults === undefined) {
    throw new ZatcaExternalServiceError(
      `ZATCA returned a response with no recognizable status field (correlationId: ${res.correlationId})`,
    );
  }

  return {
    status: rejected ? "rejected" : successStatus,
    correlationId: res.correlationId,
    rawStatus,
    warnings: body.validationResults ?? body.warnings ?? undefined,
    respondedAt: new Date(),
  };
}
