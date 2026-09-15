import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { buildCorsOptions, CorsConfigError } from "../src/lib/corsOrigins.js";

// MIDAD production launch hardening: CORS_ORIGIN restriction (opt-in via
// env, never a hardcoded domain) and safe Helmet defaults, including CSP
// (enabled — see app.ts's own comment for the real-browser verification
// behind the exact policy asserted below). No auth/register calls in this
// file at all — every assertion here works against the unauthenticated
// /api/health endpoint, so this file can never contend with the shared
// authRateLimit budget the way a heavier integration-test file could.

describe("buildCorsOptions (pure)", () => {
  it("returns undefined when CORS_ORIGIN is unset — identical to the previous cors() with no options", () => {
    expect(buildCorsOptions(undefined)).toBeUndefined();
    expect(buildCorsOptions("")).toBeUndefined();
  });

  it("parses a single origin", () => {
    expect(buildCorsOptions("https://app.example.com")).toEqual({ origin: ["https://app.example.com"] });
  });

  it("parses multiple comma-separated origins, trimming whitespace", () => {
    expect(buildCorsOptions("https://a.example.com, https://b.example.com")).toEqual({
      origin: ["https://a.example.com", "https://b.example.com"],
    });
  });

  // CORS-001: outside production, a missing CORS_ORIGIN still returns
  // undefined (permissive) — dev/test behavior is deliberately unchanged.
  it("outside production, an unset CORS_ORIGIN still returns undefined (dev/test unaffected)", () => {
    expect(buildCorsOptions(undefined, "development")).toBeUndefined();
    expect(buildCorsOptions(undefined, "test")).toBeUndefined();
    expect(buildCorsOptions(undefined, undefined)).toBeUndefined();
  });

  // CORS-001: production must never fall back to permissive CORS.
  it("throws CorsConfigError when NODE_ENV=production and CORS_ORIGIN is unset", () => {
    expect(() => buildCorsOptions(undefined, "production")).toThrow(CorsConfigError);
    expect(() => buildCorsOptions("", "production")).toThrow(CorsConfigError);
  });

  it("does not throw when NODE_ENV=production and CORS_ORIGIN is configured", () => {
    expect(buildCorsOptions("https://app.example.com", "production")).toEqual({
      origin: ["https://app.example.com"],
    });
  });
});

describe("CORS behavior over real HTTP", () => {
  const originalCorsOrigin = process.env.CORS_ORIGIN;
  afterEach(() => {
    if (originalCorsOrigin === undefined) delete process.env.CORS_ORIGIN;
    else process.env.CORS_ORIGIN = originalCorsOrigin;
  });

  it("with CORS_ORIGIN unset, any origin is allowed via the cors package's own default (unchanged from before this change)", async () => {
    delete process.env.CORS_ORIGIN;
    const app = buildApp();
    const res = await request(app).get("/api/health").set("Origin", "https://anything.example.com");
    expect(res.status).toBe(200);
    // cors() with no options set defaults to Access-Control-Allow-Origin: *
    // — the exact behavior the previous, unconditional cors() call already
    // had; buildCorsOptions(undefined) reproduces it exactly.
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it("with CORS_ORIGIN configured, the allowed origin is reflected", async () => {
    process.env.CORS_ORIGIN = "https://allowed.example.com";
    const app = buildApp();
    const res = await request(app).get("/api/health").set("Origin", "https://allowed.example.com");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("https://allowed.example.com");
  });

  it("with CORS_ORIGIN configured, a disallowed origin is not granted CORS headers", async () => {
    process.env.CORS_ORIGIN = "https://allowed.example.com";
    const app = buildApp();
    const res = await request(app).get("/api/health").set("Origin", "https://evil.example.com");
    // The request itself still completes server-side (CORS is a browser-
    // enforced restriction, not a server-side block) — what must differ is
    // that no Access-Control-Allow-Origin header is issued for this origin,
    // which is what makes a real browser refuse to expose the response.
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("existing API functionality is unaffected regardless of CORS_ORIGIN configuration", async () => {
    process.env.CORS_ORIGIN = "https://allowed.example.com";
    const app = buildApp();
    const res = await request(app).get("/api/health/live");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

// CORS-001: production must fail closed. These mutate NODE_ENV alongside
// CORS_ORIGIN (restored in afterEach) and only ever touch the
// unauthenticated /api/health endpoint, so they can't interact with
// anything else that branches on NODE_ENV (mailer, storage provider, ZATCA
// secret store) — none of those are reachable from a plain health check.
describe("CORS behavior over real HTTP — production", () => {
  const originalCorsOrigin = process.env.CORS_ORIGIN;
  const originalNodeEnv = process.env.NODE_ENV;
  afterEach(() => {
    if (originalCorsOrigin === undefined) delete process.env.CORS_ORIGIN;
    else process.env.CORS_ORIGIN = originalCorsOrigin;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it("production + missing CORS_ORIGIN: buildApp() refuses to start instead of falling back to permissive CORS", () => {
    process.env.NODE_ENV = "production";
    delete process.env.CORS_ORIGIN;
    expect(() => buildApp()).toThrow(CorsConfigError);
  });

  it("production + configured CORS_ORIGIN: the allowed origin is reflected", async () => {
    process.env.NODE_ENV = "production";
    process.env.CORS_ORIGIN = "https://allowed.example.com";
    const app = buildApp();
    const res = await request(app).get("/api/health").set("Origin", "https://allowed.example.com");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe("https://allowed.example.com");
  });

  it("production + configured CORS_ORIGIN: a disallowed origin gets no CORS headers", async () => {
    process.env.NODE_ENV = "production";
    process.env.CORS_ORIGIN = "https://allowed.example.com";
    const app = buildApp();
    const res = await request(app).get("/api/health").set("Origin", "https://evil.example.com");
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("security headers", () => {
  it("responses carry safe Helmet defaults", async () => {
    const app = buildApp();
    const res = await request(app).get("/api/health");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBeTruthy();
    // frameguard default is SAMEORIGIN
    expect(res.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });

  // Security fix — CSP enabled with the policy a dedicated read-only audit
  // browser-verified (zero securitypolicyviolation events, zero console
  // errors) across /, /settings (incl. the logo <img>), /projects,
  // /invoices, /quotes on the real production build. See app.ts's own
  // comment for the full rationale; asserted here as individual directive
  // substrings rather than one exact string so the test doesn't depend on
  // Helmet's own directive-ordering/formatting.
  it("sets the verified Content-Security-Policy header", async () => {
    const app = buildApp();
    const res = await request(app).get("/api/health");
    const csp = res.headers["content-security-policy"];
    expect(csp).toBeTruthy();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'self'");
    // The exact directives this fix must never add, regardless of Helmet
    // version/formatting changes.
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
  });

  // 18-phase internal remediation, Phase 5 — the one gap the CSP/headers
  // audit found: no Permissions-Policy header at all.
  it("sets a restrictive Permissions-Policy header", async () => {
    const app = buildApp();
    const res = await request(app).get("/api/health");
    const policy = res.headers["permissions-policy"];
    expect(policy).toBeTruthy();
    expect(policy).toContain("camera=()");
    expect(policy).toContain("microphone=()");
    expect(policy).toContain("geolocation=()");
  });
});

// 18-phase internal remediation, Phase 3 — trust proxy was never
// configured at all (not even env-driven); see app.ts's own comment for
// why the actual hop-count value stays a deployment (Railway) decision,
// not something this internal pass invents. These tests only prove the
// wiring: unset behaves exactly as before (Express's own false default,
// so every existing test/dev-local behavior is unchanged), and a value
// actually reaches app.set("trust proxy", ...) when TRUST_PROXY is set.
describe("trust proxy configuration (TRUST_PROXY env var)", () => {
  const original = process.env.TRUST_PROXY;
  afterEach(() => {
    if (original === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = original;
  });

  it("TRUST_PROXY unset reproduces Express's own prior default (false) — no behavior change", () => {
    delete process.env.TRUST_PROXY;
    const app = buildApp();
    expect(app.get("trust proxy")).toBe(false);
  });

  it("TRUST_PROXY=1 sets a numeric hop count", () => {
    process.env.TRUST_PROXY = "1";
    const app = buildApp();
    expect(app.get("trust proxy")).toBe(1);
  });

  it("TRUST_PROXY=true sets boolean trust-all", () => {
    process.env.TRUST_PROXY = "true";
    const app = buildApp();
    expect(app.get("trust proxy")).toBe(true);
  });

  it("TRUST_PROXY as a subnet/address list is passed through unchanged", () => {
    process.env.TRUST_PROXY = "loopback,uniquelocal";
    const app = buildApp();
    expect(app.get("trust proxy")).toBe("loopback,uniquelocal");
  });
});
