// FATOORA implementation of ZatcaProvider (Slice 3). See fatooraClient.ts's
// header comment for the primary-source verification gap this whole file
// inherits — every endpoint path and header value is sourced from
// environment configuration, never hardcoded here. Callers (domain/routes)
// depend only on ./types.ts's ZatcaProvider interface, never on this class
// or on fatooraClient.ts directly.

import { fatooraProbe, fatooraRequest, loadFatooraEndpointConfig } from "./fatooraClient.js";
import type {
  ResolvedZatcaCredential,
  ZatcaConnectionCheckResult,
  ZatcaDocumentSubmissionInput,
  ZatcaEnvironmentName,
  ZatcaProvider,
  ZatcaSubmissionResult,
} from "./types.js";

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

  async submitComplianceDocument(
    credential: ResolvedZatcaCredential,
    input: ZatcaDocumentSubmissionInput,
  ): Promise<ZatcaSubmissionResult> {
    const config = loadFatooraEndpointConfig(this.environment);
    const res = await fatooraRequest("POST", config.compliancePath, buildDocumentBody(input), credential, config);
    return normalizeSubmissionResponse(res, "compliance_pending");
  }

  async clearInvoice(credential: ResolvedZatcaCredential, input: ZatcaDocumentSubmissionInput): Promise<ZatcaSubmissionResult> {
    const config = loadFatooraEndpointConfig(this.environment);
    const res = await fatooraRequest("POST", config.clearancePath, buildDocumentBody(input), credential, config);
    return normalizeSubmissionResponse(res, "cleared");
  }

  async reportInvoice(credential: ResolvedZatcaCredential, input: ZatcaDocumentSubmissionInput): Promise<ZatcaSubmissionResult> {
    const config = loadFatooraEndpointConfig(this.environment);
    const res = await fatooraRequest("POST", config.reportingPath, buildDocumentBody(input), credential, config);
    return normalizeSubmissionResponse(res, "reported");
  }
}

// Field names (invoiceHash / uuid / invoice) are the ones most consistently
// cross-corroborated across secondary ZATCA integration guides reachable
// via WebSearch in this environment — still unverified against the
// primary Developer Portal Manual/XSD (WebFetch cannot reach zatca.gov.sa
// here). Kept in one place so a confirmed correction only touches this
// function.
function buildDocumentBody(input: ZatcaDocumentSubmissionInput): unknown {
  return {
    invoiceHash: input.invoiceHashBase64,
    uuid: input.uuid,
    invoice: input.invoiceXmlBase64,
  };
}

// Some ZATCA responses return HTTP 200 with the actual outcome only
// visible inside the body (a document can be rejected with a 200 status
// and clearanceStatus/reportingStatus/validationResults describing why) —
// a commonly corroborated behavior across the secondary sources checked.
// fatooraRequest() already throws on a non-2xx status; this function is
// what catches the "200 OK but actually rejected" case so a rejected
// document is never reported to the caller as cleared/reported.
function normalizeSubmissionResponse(
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
    .some((value) => /reject|error|fail/i.test(value));

  return {
    status: rejected ? "rejected" : successStatus,
    correlationId: res.correlationId,
    rawStatus,
    warnings: body.validationResults ?? body.warnings ?? undefined,
    respondedAt: new Date(),
  };
}
