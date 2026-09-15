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

// 18-phase internal remediation, Phase 11 — investigated and deliberately
// NOT changed: an external audit pass flagged that this check only fails
// closed when NODE_ENV is the exact literal "production", so an operator
// who forgot to set NODE_ENV at all would get permissive CORS. Verified
// against the actual deployment path (not just this file in isolation):
// the Dockerfile hardcodes `ENV NODE_ENV=production` (server/../Dockerfile),
// so a real deployment built from this image always has NODE_ENV set
// correctly regardless of what an operator does or forgets — the
// scenario isn't reachable through the documented deployment path.
// Meanwhile server/package.json's own "dev" script (`tsx watch
// src/index.ts`) deliberately leaves NODE_ENV unset for local
// development, so tightening this check to fail closed on "unset" would
// break `npm run dev` for every contributor without closing a gap that
// exists in practice. Left as-is.

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
