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
  // Compliance Invoice only (Slice B — verified against
  // compliance_invoice.pdf's "Shape 1" response). This endpoint tests
  // every invoice type generically, so its response carries clearance and
  // QR outcomes alongside reportingStatus even though this call is not
  // itself a real Clearance/Reporting submission — kept as distinct,
  // clearly-scoped passthrough fields rather than folded into `rawStatus`
  // (which already means something specific for Reporting/Clearance).
  // `null` when ZATCA itself returned null (not applicable to this
  // invoice); `undefined` when the response didn't include the field at
  // all or Compliance Invoice was not the call that produced this result.
  // Field names (qrSellertStatus/qrBuyertStatus) preserve ZATCA's own
  // spelling from the Swagger export verbatim, not a MIDAD typo.
  clearanceStatus?: string | null;
  qrSellertStatus?: string | null;
  qrBuyertStatus?: string | null;
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

// Production CSID Onboarding — VERIFIED (Slice C; see fatooraClient.ts's
// file comment; contract read directly from the real "Production CSID
// (Onboarding) API" Swagger export the user obtained from their own ZATCA
// Developer Portal account). Uses the Compliance CSID's own credential.
export interface ZatcaProductionCsidOnboardingResult {
  // Same String() convention as ZatcaComplianceCsidResult.requestId — see
  // its comment.
  requestId: string;
  dispositionMessage: string;
  binarySecurityToken: string;
  secret: string;
}

// Production CSID Renewal — VERIFIED (Slice C; see fatooraClient.ts's file
// comment; contract read directly from the real "Production CSID
// (Renewal) API" Swagger export). No credential parameter on the provider
// method below — see fatooraClient.ts's documented ambiguity: this
// endpoint's own Swagger export never shows an Authorization parameter
// row, even though 401 is a documented response.
//
// `outcome` is a required discriminant, not an afterthought: ZATCA's own
// verified 428 response ("NOT_COMPLIANT") is a genuinely different
// outcome from a 200 "issued" success, wrapped in its own {"value": {...}}
// envelope — callers MUST branch on this field rather than assuming any
// result with a `binarySecurityToken` was actually issued.
interface ZatcaProductionCsidRenewalFields {
  requestId: string;
  // ZATCA's own field — a URI string on a genuine "issued" success (per
  // the verified example), null on "not_compliant". Never fabricated.
  tokenType: string | null;
  dispositionMessage: string;
  binarySecurityToken: string;
  secret: string;
}
export interface ZatcaProductionCsidRenewalIssuedResult extends ZatcaProductionCsidRenewalFields {
  outcome: "issued";
}
export interface ZatcaProductionCsidRenewalNotCompliantResult extends ZatcaProductionCsidRenewalFields {
  outcome: "not_compliant";
}
export type ZatcaProductionCsidRenewalResult =
  | ZatcaProductionCsidRenewalIssuedResult
  | ZatcaProductionCsidRenewalNotCompliantResult;

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

  // Exchanges a Compliance CSID + compliance_request_id for a Production
  // CSID. VERIFIED contract (Slice C). Deliberately NOT wired to
  // domain/csr.ts, the CSID state machine, or any route — not
  // automatically called after requestComplianceCsid or
  // submitComplianceDocument, and does not attempt to resolve the
  // Missing-ComplianceSteps gap documented in
  // docs/zatca/ZATCA_NETWORK_INTEGRATION_SPEC.md (left for a future
  // slice).
  requestProductionCsidOnboarding(
    credential: ResolvedZatcaCredential,
    complianceRequestId: string,
  ): Promise<ZatcaProductionCsidOnboardingResult>;

  // Renews an existing Production CSID from a fresh CSR + OTP. VERIFIED
  // contract (Slice C). No credential parameter — see
  // ZatcaProductionCsidRenewalResult's comment and fatooraClient.ts's
  // documented ambiguity. Deliberately NOT wired to any state machine or
  // route in this slice.
  renewProductionCsid(csrBase64: string, otp: string): Promise<ZatcaProductionCsidRenewalResult>;
}
