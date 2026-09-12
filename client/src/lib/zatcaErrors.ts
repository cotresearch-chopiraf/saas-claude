import { ApiError } from "../api/client";

// ZATCA Customer Onboarding & Compliance Center — maps
// server/src/lib/zatca/errors.ts's ZatcaErrorCategory into customer-facing
// guidance. This is presentation only: it never changes what
// actually happened (the raw backend message is always shown alongside),
// never claims a category the response didn't send, and never invents a
// category — an error with no `category` (any non-ZATCA route, or a ZATCA
// response that genuinely omitted one) falls through to a generic, honest
// "unknown outcome" presentation rather than guessing one of these.
// Takes t as a parameter (rather than a plain Record) since this module has
// no React context of its own — every call site already has its own
// useTranslation(). retryGuidance and needsAdminOrSupport are technical
// classifications, not display text, so they are never translated.

export interface ZatcaErrorPresentation {
  title: string;
  // Whether the customer should simply try again.
  retryGuidance: "retry" | "fix_then_retry" | "no_retry" | "wait_and_retry";
  retryGuidanceText: string;
  // Whether this requires MIDAD support / a company admin to intervene
  // (vs. something the current user can resolve themselves).
  needsAdminOrSupport: boolean;
}

const KNOWN_CATEGORIES = [
  "configuration",
  "authentication",
  "authorization",
  "validation",
  "duplicate",
  "rate_limited",
  "network",
  "external_service",
  "not_implemented",
  "internal",
] as const;

type KnownCategory = (typeof KNOWN_CATEGORIES)[number];

const RETRY_GUIDANCE: Record<KnownCategory, ZatcaErrorPresentation["retryGuidance"]> = {
  configuration: "fix_then_retry",
  authentication: "no_retry",
  authorization: "no_retry",
  validation: "fix_then_retry",
  duplicate: "no_retry",
  rate_limited: "wait_and_retry",
  network: "wait_and_retry",
  external_service: "wait_and_retry",
  not_implemented: "no_retry",
  internal: "no_retry",
};

const NEEDS_ADMIN_OR_SUPPORT: Record<KnownCategory, boolean> = {
  configuration: false,
  authentication: true,
  authorization: true,
  validation: false,
  duplicate: false,
  rate_limited: false,
  network: false,
  external_service: false,
  not_implemented: true,
  internal: true,
};

const UNKNOWN_PRESENTATION_DEFAULTS = {
  retryGuidance: "retry" as const,
  needsAdminOrSupport: false,
};

export interface PresentedZatcaError extends ZatcaErrorPresentation {
  message: string;
}

function isKnownCategory(category: string): category is KnownCategory {
  return (KNOWN_CATEGORIES as readonly string[]).includes(category);
}

// Never receives or exposes an Authorization header, credential, private
// key, or raw stack trace — err.message on ApiError is always the safe,
// already-sanitized string the backend itself chose to send (see
// errors.ts's own file comment: every ZatcaError message is safe to
// render before it is ever thrown).
export function presentZatcaError(t: (key: string) => string, err: unknown, fallbackMessage: string): PresentedZatcaError {
  if (err instanceof ApiError && err.category && isKnownCategory(err.category)) {
    return {
      title: t(`zatcaErrorPresentations.${err.category}.title`),
      retryGuidance: RETRY_GUIDANCE[err.category],
      retryGuidanceText: t(`zatcaErrorPresentations.${err.category}.retryGuidanceText`),
      needsAdminOrSupport: NEEDS_ADMIN_OR_SUPPORT[err.category],
      message: err.message,
    };
  }
  return {
    title: t("zatcaErrorPresentations.unknown.title"),
    retryGuidanceText: t("zatcaErrorPresentations.unknown.retryGuidanceText"),
    ...UNKNOWN_PRESENTATION_DEFAULTS,
    message: err instanceof ApiError ? err.message : fallbackMessage,
  };
}
