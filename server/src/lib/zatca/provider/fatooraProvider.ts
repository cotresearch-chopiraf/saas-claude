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
// submitComplianceDocument — VERIFIED contract (Slice B; POST
// /compliance/invoices, see compliance_invoice.pdf and
// fatooraClient.ts's header comment). requestComplianceCsid below is a
// SEPARATE, also-VERIFIED endpoint (POST /compliance, not
// /compliance/invoices).

import {
  fatooraProbe,
  fatooraRequest,
  fatooraRequestComplianceCsid,
  fatooraRequestComplianceInvoice,
  loadFatooraEndpointConfig,
} from "./fatooraClient.js";
import { ZatcaExternalServiceError } from "../errors.js";
import type {
  ResolvedZatcaCredential,
  ZatcaComplianceCsidResult,
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

  // Compliance Invoice (compliance checks) — VERIFIED contract (Slice B;
  // POST /compliance/invoices).
  async submitComplianceDocument(
    credential: ResolvedZatcaCredential,
    input: ZatcaDocumentSubmissionInput,
  ): Promise<ZatcaSubmissionResult> {
    const config = loadFatooraEndpointConfig(this.environment);
    const res = await fatooraRequestComplianceInvoice(
      config.compliancePath,
      buildDocumentBody(input),
      credential,
      config,
      { ...ACCEPT_LANGUAGE_EN },
    );
    return normalizeComplianceInvoiceResponse(res);
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

  // Compliance CSID — VERIFIED contract (POST /compliance). No
  // ResolvedZatcaCredential parameter: this call is what PRODUCES the
  // first credential, so it takes the raw CSR + OTP instead (see
  // fatooraClient.ts's fatooraRequestComplianceCsid). Deliberately not
  // called from anywhere else in this slice — domain/csr.ts's
  // confirmCsidForEgsUnit, the CSID state machine, and every route are
  // untouched; see docs/zatca/ZATCA_NETWORK_INTEGRATION_SPEC.md.
  async requestComplianceCsid(csrBase64: string, otp: string): Promise<ZatcaComplianceCsidResult> {
    const config = loadFatooraEndpointConfig(this.environment);
    return fatooraRequestComplianceCsid(csrBase64, otp, config);
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

// Compliance Invoice response — Slice B, VERIFIED against
// compliance_invoice.pdf. This endpoint's own Swagger doc documents TWO
// genuinely distinct response body shapes, both confirmed occurring under
// EITHER HTTP 200 or HTTP 400 (this endpoint does not reserve one shape
// per status code — see fatooraClient.ts's fatooraRequestComplianceInvoice,
// which returns rather than throws on 400 for exactly this reason):
//
//   Shape 1 ("Reporting-style"): { validationResults: {status, ...},
//     reportingStatus: "REPORTED"|"NOT_REPORTED", clearanceStatus,
//     qrSellertStatus, qrBuyertStatus }. The same nested shape as the
//     already-verified Reporting endpoint's response, plus three extra
//     diagnostic fields unique to this endpoint (it tests every invoice
//     type generically, so it reports clearance/QR outcomes too, even
//     though this call is a compliance check, not a real submission).
//     Discriminated by the presence of `reportingStatus`, a field Shape 2
//     never carries.
//
//   Shape 2 (InvoiceResultModel — the shape ZATCA's own examples show for
//     QR-code, digital-signature, and authentication-certificate failures
//     specifically): { invoiceHash, status: "Reported"|"Not Reported"|
//     "Accepted with Warnings", warnings, errors: [{category, code,
//     message}] }. A flat shape with its own `status` enum, discriminated
//     from Shape 1 by NOT carrying `reportingStatus` and instead carrying
//     one of these three literal values.
//
// A response matching NEITHER shape is never treated as success — this
// function throws ZatcaExternalServiceError instead, the same discipline
// normalizeReportingResponse/normalizeClearanceResponse already follow.
// This function is intentionally NOT reused for Reporting or Clearance —
// their own normalizers (above) are unchanged by this slice.
const COMPLIANCE_INVOICE_RESULT_STATUSES = ["Reported", "Not Reported", "Accepted with Warnings"] as const;
type ComplianceInvoiceResultStatus = (typeof COMPLIANCE_INVOICE_RESULT_STATUSES)[number];

// null means ZATCA itself returned null (field not applicable to this
// invoice); undefined means the field was absent or not a string — never
// invented, just faithfully passed through either way.
function normalizeNullableStringField(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function normalizeComplianceInvoiceResponse(res: { body: unknown; correlationId: string }): ZatcaSubmissionResult {
  const body = (res.body ?? {}) as Record<string, unknown>;

  // Shape 1 — discriminator: reportingStatus present (Shape 2 never has it).
  if (typeof body.reportingStatus === "string") {
    const reportingStatus = body.reportingStatus;
    if (reportingStatus !== "REPORTED" && reportingStatus !== "NOT_REPORTED") {
      throw new ZatcaExternalServiceError(
        `ZATCA Compliance Invoice response had an unrecognized reportingStatus (correlationId: ${res.correlationId})`,
      );
    }
    const validationResults = body.validationResults as { status?: string } | undefined;
    return {
      status: reportingStatus === "REPORTED" ? "compliance_pending" : "rejected",
      correlationId: res.correlationId,
      rawStatus: reportingStatus,
      warnings: validationResults,
      clearanceStatus: normalizeNullableStringField(body.clearanceStatus),
      qrSellertStatus: normalizeNullableStringField(body.qrSellertStatus),
      qrBuyertStatus: normalizeNullableStringField(body.qrBuyertStatus),
      respondedAt: new Date(),
    };
  }

  // Shape 2 (InvoiceResultModel) — discriminator: its own documented
  // status enum. "Accepted with Warnings" is a real success (the document
  // was still processed), mirroring how Reporting's own WARNING
  // validationResults.status is never treated as rejection.
  if (typeof body.status === "string" && (COMPLIANCE_INVOICE_RESULT_STATUSES as readonly string[]).includes(body.status)) {
    const status = body.status as ComplianceInvoiceResultStatus;
    return {
      status: status === "Not Reported" ? "rejected" : "compliance_pending",
      correlationId: res.correlationId,
      rawStatus: status,
      // Both documented fields preserved verbatim (category/code/message
      // intact per error entry) — never collapsed into a single string.
      warnings: { warnings: body.warnings ?? null, errors: Array.isArray(body.errors) ? body.errors : null },
      respondedAt: new Date(),
    };
  }

  throw new ZatcaExternalServiceError(
    `ZATCA Compliance Invoice response matched neither documented shape (no reportingStatus, no recognized ` +
      `InvoiceResultModel status) (correlationId: ${res.correlationId})`,
  );
}
