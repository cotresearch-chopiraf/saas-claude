// MIDAD Phase B — the machine-readable taxonomy behind every existing
// {error:"..."} response. Deliberately just the categories this codebase's
// real HTTP status usage already justifies (see errorEnvelope.ts) — not a
// speculative, larger error-code system.
export type ErrorCode =
  | "VALIDATION"
  | "AUTHENTICATION"
  | "AUTHORIZATION"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "SERVICE_UNAVAILABLE"
  | "INTERNAL";

export function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return "VALIDATION";
    case 401:
      return "AUTHENTICATION";
    case 403:
      return "AUTHORIZATION";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    case 429:
      return "RATE_LIMITED";
    case 503:
      return "SERVICE_UNAVAILABLE";
    default:
      return "INTERNAL";
  }
}
