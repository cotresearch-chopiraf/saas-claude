// Structured ZATCA error taxonomy (Slice 3, extended Slice 5). Every error
// the provider layer, secret store, or /api/zatca/* routes raise is one of
// these categories — never a raw Error — so callers (routes, Admin
// Dashboard, audit) can handle "the tenant hasn't finished setup"
// (configuration) differently from "ZATCA itself is down" (network/
// external_service) without string-matching messages. Slice 5 split
// authorization/duplicate/rate_limited out of the generic authentication/
// validation buckets using only standard HTTP semantics (RFC 7231/6585) —
// never a ZATCA-specific response-body guess (see
// docs/zatca/SPECIFICATION-VERIFICATION.md).
//
// `message` on every subclass here must already be safe to return in an
// API response, render in the UI, write to a log line, or store in an
// audit event's metadata — never interpolate a raw upstream response body,
// a request header, or credential material into it. See fatooraClient.ts's
// normalizeError() for where raw HTTP/network failures are translated into
// these before anything else ever sees them.

export type ZatcaErrorCategory =
  | "configuration"
  | "authentication"
  | "authorization"
  | "validation"
  | "duplicate"
  | "rate_limited"
  | "network"
  | "external_service"
  | "internal"
  | "not_implemented";

export class ZatcaError extends Error {
  readonly category: ZatcaErrorCategory;
  readonly retryable: boolean;

  constructor(category: ZatcaErrorCategory, message: string, options: { retryable?: boolean } = {}) {
    super(message);
    this.name = "ZatcaError";
    this.category = category;
    this.retryable = options.retryable ?? false;
  }
}

// The tenant's own MIDAD-side ZATCA setup is incomplete or invalid — e.g.
// no EGS unit, no VAT number configured, no secretRef yet. Always the
// caller's (tenant's) own fault to fix; never means ZATCA was contacted.
export class ZatcaConfigurationError extends ZatcaError {
  constructor(message: string) {
    super("configuration", message);
    this.name = "ZatcaConfigurationError";
  }
}

// ZATCA itself rejected the credential (expired/revoked CSID, bad OTP,
// wrong environment). A real response was received FROM ZATCA — this is
// never raised without an actual round trip having happened.
export class ZatcaAuthenticationError extends ZatcaError {
  constructor(message: string) {
    super("authentication", message);
    this.name = "ZatcaAuthenticationError";
  }
}

// Slice 5 — HTTP 403: the credential was authenticated but is not
// permitted to perform this action (e.g. a Compliance CSID used against a
// Production-only endpoint). Standard HTTP semantics (RFC 7231 §6.5.3),
// not a ZATCA-specific guess — deliberately distinct from 401
// "authentication" so a caller can tell "this credential is invalid" from
// "this credential is valid but not allowed to do this."
export class ZatcaAuthorizationError extends ZatcaError {
  constructor(message: string) {
    super("authorization", message);
    this.name = "ZatcaAuthorizationError";
  }
}

// ZATCA received the request and rejected the document/content itself
// (business-rule or schema violation, document rejected). Not retryable
// as-is — the document must change first.
export class ZatcaValidationError extends ZatcaError {
  constructor(message: string) {
    super("validation", message);
    this.name = "ZatcaValidationError";
  }
}

// Slice 5 — HTTP 409: standard HTTP semantics for "conflicts with the
// current state of the resource" (RFC 7231 §6.5.8), commonly used by
// submission-style APIs to signal an already-processed/duplicate request.
// This is a generic HTTP interpretation, not a verified ZATCA-specific
// response field — see docs/zatca/SPECIFICATION-VERIFICATION.md. Not
// retryable: resubmitting the identical request will not change a
// genuine conflict.
export class ZatcaDuplicateError extends ZatcaError {
  constructor(message: string) {
    super("duplicate", message);
    this.name = "ZatcaDuplicateError";
  }
}

// Slice 5 — HTTP 429: standard HTTP semantics (RFC 6585 §4). Distinct
// from generic "validation" so callers can back off and retry rather than
// treating it as a permanent rejection.
export class ZatcaRateLimitedError extends ZatcaError {
  constructor(message: string) {
    super("rate_limited", message, { retryable: true });
    this.name = "ZatcaRateLimitedError";
  }
}

// Never reached ZATCA at all — DNS failure, connection refused, timeout.
export class ZatcaNetworkError extends ZatcaError {
  constructor(message: string) {
    super("network", message, { retryable: true });
    this.name = "ZatcaNetworkError";
  }
}

// Reached ZATCA, but it returned something MIDAD cannot safely interpret
// (5xx, malformed body, unexpected shape) — distinct from "network" because
// a response genuinely came back, just not a usable one.
export class ZatcaExternalServiceError extends ZatcaError {
  constructor(message: string) {
    super("external_service", message, { retryable: true });
    this.name = "ZatcaExternalServiceError";
  }
}

// A MIDAD-side bug or invariant violation (e.g. document generation
// failure before any HTTP call was even attempted) — never the tenant's
// fault and never a real ZATCA response.
export class ZatcaInternalError extends ZatcaError {
  constructor(message: string) {
    super("internal", message);
    this.name = "ZatcaInternalError";
  }
}

// Slice 4 — a deliberate, documented capability boundary (e.g. XAdES
// signing, for which no primary ZATCA specification is verifiable in this
// environment — see lib/zatca/signer/notImplementedSigner.ts). Distinct
// from "internal" (a bug) — this is not a bug, it is an honest "this
// exists in the architecture but is not built yet" answer, never a
// fabricated success.
export class ZatcaNotImplementedError extends ZatcaError {
  constructor(message: string) {
    super("not_implemented", message);
    this.name = "ZatcaNotImplementedError";
  }
}

// One place every route maps a category to an HTTP status — kept separate
// from lib/errorCodes.ts's existing MIDAD-wide taxonomy (AUTHENTICATION/
// AUTHORIZATION there mean MIDAD's own login/permission system, which is
// not what these mean) rather than overloading it.
export function httpStatusForZatcaError(err: ZatcaError): number {
  switch (err.category) {
    case "configuration":
    case "validation":
      return 400;
    case "authentication":
      return 502;
    case "authorization":
      return 502;
    case "duplicate":
      return 409;
    case "rate_limited":
      return 429;
    case "network":
      return 504;
    case "external_service":
      return 503;
    case "not_implemented":
      return 501;
    case "internal":
    default:
      return 500;
  }
}
