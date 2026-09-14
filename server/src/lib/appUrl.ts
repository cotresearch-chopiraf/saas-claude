// B1/B2 remediation — password-reset and invite emails previously embedded
// a bare relative path ("/reset-password?token=...", "/accept-invite?token=...")
// with no domain, which has no meaning inside a real email client. APP_URL
// is the one new piece of configuration this needs, read here — the single
// place any email-generated link is built — never duplicated as ad hoc
// string concatenation in a route file. Same fail-closed-in-production
// convention already established for CORS_ORIGIN (lib/corsOrigins.ts) and
// MAIL_PROVIDER (lib/mailer.ts): an explicit value is always honored; only
// a silently-unset one refuses to serve in production.

export class AppUrlConfigError extends Error {
  constructor() {
    super("APP_URL must be set when NODE_ENV=production — refusing to build an email link without a real domain.");
    this.name = "AppUrlConfigError";
  }
}

// Non-production fallback only — never used when NODE_ENV=production (see
// below). Matches this repo's own Vite dev server's default port
// (client/vite.config.ts sets no custom port, so Vite's own default,
// 5173, applies) so a link logged by the console mail provider during
// local development is actually a working link, not a placeholder.
const DEV_DEFAULT_APP_URL = "http://localhost:5173";

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

// pathAndQuery must start with "/" (e.g. "/accept-invite?token=..."). Accepts
// envValue/nodeEnv as parameters (defaulting to the real process.env) so this
// stays a pure, directly testable function — the same shape
// lib/corsOrigins.ts's buildCorsOptions() already uses for exactly this
// reason, reused here rather than inventing a second configuration pattern.
export function buildAppUrl(
  pathAndQuery: string,
  envValue: string | undefined = process.env.APP_URL,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): string {
  const trimmed = envValue?.trim();
  const base = trimmed && trimmed !== "" ? trimmed : nodeEnv === "production" ? undefined : DEV_DEFAULT_APP_URL;
  if (!base) {
    throw new AppUrlConfigError();
  }
  return `${stripTrailingSlashes(base)}${pathAndQuery}`;
}
