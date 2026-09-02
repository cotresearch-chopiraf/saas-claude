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
//
// privateKeyPem/curve (Slice 5 continuation) — the ECDSA private key
// MIDAD generated locally (lib/zatca/csr/keyPair.ts) alongside the CSR
// that produced this credential's certificate. ZATCA never sends this
// back; it exists here only because ZatcaSecretStore is where MIDAD keeps
// the whole credential together (private key included) once CSID
// onboarding (task #51) actually persists one. Optional because every
// credential created before that exists (the Slice 3 manual
// "connect credentials" form) has no private key at all — signing with
// such a credential fails with a clear configuration error, never a
// fabricated signature. Never logged, never returned from an API route,
// never written to an ordinary DB column — ZatcaSecretStore's own
// implementation is what's responsible for keeping it out of plaintext at
// rest.
export interface ResolvedZatcaCredential {
  binarySecurityToken: string;
  secret: string;
  privateKeyPem?: string;
  curve?: string;
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
  // Clearance only (verified — see fatooraClient.ts's file comment): the
  // ZATCA-signed/stamped invoice XML (base64), returned only on a real
  // "CLEARED" response. This is the actual legal cleared document — never
  // fabricated, and undefined for every status other than a genuine
  // clearance success.
  clearedInvoiceXmlBase64?: string;
}

// Compliance CSID — VERIFIED (see fatooraClient.ts's file comment; contract
// read directly from the real "Compliance CSID API" Swagger export the user
// obtained from their own ZATCA Developer Portal account). This is the
// bootstrapping call: no ResolvedZatcaCredential exists yet at this point
// (it's what this call produces), so it takes the raw CSR and OTP instead.
export interface ZatcaComplianceCsidResult {
  // ZATCA's requestID — returned as a JSON number in the verified example,
  // stored here as a string since it is used only as an opaque identifier
  // (e.g. later passed as Production CSID's compliance_request_id), never
  // arithmetic.
  requestId: string;
  dispositionMessage: string;
  binarySecurityToken: string;
  secret: string;
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

  // Issues a Compliance CSID from a CSR + OTP. VERIFIED contract (see
  // fatooraClient.ts). Deliberately NOT wired to domain/csr.ts's
  // confirmCsidForEgsUnit, the CSID state machine, or any route in this
  // slice — see docs/zatca/ZATCA_NETWORK_INTEGRATION_SPEC.md for why.
  requestComplianceCsid(csrBase64: string, otp: string): Promise<ZatcaComplianceCsidResult>;
}
