import type { CorsOptions } from "cors";

// CORS-001: a production deployment with no CORS_ORIGIN configured must
// never fall back to permissive (reflect-any-origin) CORS — combined with
// this API's Bearer-token auth, that would let a script on any origin
// coax a logged-in user's browser into carrying their token to this API.
// Fail loudly instead, the same fail-closed convention already used for a
// missing mail provider in production (see lib/mailer.ts).
export class CorsConfigError extends Error {
  constructor() {
    super("CORS_ORIGIN must be set when NODE_ENV=production — refusing to start with permissive CORS.");
    this.name = "CorsConfigError";
  }
}

// Development/test: CORS_ORIGIN is optional and intentionally unset by
// default (local dev and CI never set it, so behavior there is unchanged —
// cors() with undefined options reflects any request origin, exactly as
// before this file existed). No domain is hardcoded here: a production
// deployment sets CORS_ORIGIN itself once its real frontend origin is
// known. Comma-separated so a client served from more than one origin
// (e.g. an apex + www) doesn't need a second env var.
//
// nodeEnv defaults to the real process.env.NODE_ENV so the existing
// app.ts call site (buildCorsOptions(process.env.CORS_ORIGIN)) needs no
// change; tests can still pass it explicitly to exercise production
// behavior without mutating global process.env.
export function buildCorsOptions(
  envValue: string | undefined,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): CorsOptions | undefined {
  const origins = (envValue ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  if (origins.length === 0) {
    if (nodeEnv === "production") {
      throw new CorsConfigError();
    }
    return undefined;
  }
  return { origin: origins };
}
