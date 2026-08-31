import type { CorsOptions } from "cors";

// Production launch hardening: CORS_ORIGIN is optional and intentionally
// unset by default (local dev and CI never set it, so behavior there is
// unchanged — cors() with undefined options reflects any request origin,
// exactly as before this file existed). No domain is hardcoded here: a
// production deployment sets CORS_ORIGIN itself once its real frontend
// origin is known. Comma-separated so a client served from more than one
// origin (e.g. an apex + www) doesn't need a second env var.
export function buildCorsOptions(envValue: string | undefined): CorsOptions | undefined {
  const origins = (envValue ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  if (origins.length === 0) return undefined;
  return { origin: origins };
}
