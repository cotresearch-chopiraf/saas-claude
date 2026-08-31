// ZATCA provider abstraction (Slice 3). Nothing in routes/ or domain/ may
// import fatooraClient.ts or fatooraProvider.ts directly — every caller
// goes through this ZatcaProvider interface, so the business/domain layer
// never knows this is HTTP underneath (headers, auth scheme, base URL,
// JSON shape) and a future non-FATOORA implementation (e.g. a recorded-
// fixture provider for tests) is a drop-in.

export type ZatcaEnvironmentName = "simulation" | "production";

// Resolved just-in-time from ZatcaSecretStore for the single call that
// needs it — never cached, never logged, never returned from an API route.
// Field names follow ZATCA's own onboarding terminology: the X.509
// certificate issued during CSID onboarding (binarySecurityToken) paired
// with its secret, used as HTTP Basic Authentication credentials.
export interface ResolvedZatcaCredential {
  binarySecurityToken: string;
  secret: string;
}

export interface ZatcaConnectionCheckResult {
  connected: boolean;
  checkedAt: Date;
  correlationId?: string;
  // Safe-for-UI/log/audit text only — never a raw response body.
  detail?: string;
}

export interface ZatcaDocumentSubmissionInput {
  // Base64-encoded UBL 2.1 XML — produced by lib/zatca/xmlBuilder.ts.
  invoiceXmlBase64: string;
  // Base64-encoded SHA-256 hash of the same XML — from lib/zatca/hash.ts.
  invoiceHashBase64: string;
  uuid: string;
}

export interface ZatcaSubmissionResult {
  status: "cleared" | "reported" | "compliance_pending" | "rejected";
  correlationId?: string;
  // Raw ZATCA status string (e.g. reportingStatus/clearanceStatus), kept
  // for diagnostics — never a full response body.
  rawStatus?: string;
  warnings?: unknown;
  respondedAt: Date;
}

export interface ZatcaProvider {
  getEnvironment(): ZatcaEnvironmentName;

  // See fatooraProvider.ts's own file comment for exactly what this probe
  // does and does not prove, and the primary-source verification this
  // still needs before production use.
  checkConnection(credential: ResolvedZatcaCredential): Promise<ZatcaConnectionCheckResult>;

  submitComplianceDocument(
    credential: ResolvedZatcaCredential,
    input: ZatcaDocumentSubmissionInput,
  ): Promise<ZatcaSubmissionResult>;

  clearInvoice(credential: ResolvedZatcaCredential, input: ZatcaDocumentSubmissionInput): Promise<ZatcaSubmissionResult>;

  reportInvoice(credential: ResolvedZatcaCredential, input: ZatcaDocumentSubmissionInput): Promise<ZatcaSubmissionResult>;
}
