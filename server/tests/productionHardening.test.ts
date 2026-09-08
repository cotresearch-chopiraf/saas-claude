import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { buildCorsOptions, CorsConfigError } from "../src/lib/corsOrigins.js";

// MIDAD production launch hardening: CORS_ORIGIN restriction (opt-in via
// env, never a hardcoded domain) and safe Helmet defaults (no CSP — this
// server serves no HTML). No auth/register calls in this file at all —
// every assertion here works against the unauthenticated /api/health
// endpoint, so this file can never contend with the shared authRateLimit
// budget the way a heavier integration-test file could.

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

  it("does not set a Content-Security-Policy header (deliberately disabled — this server serves no HTML)", async () => {
    const app = buildApp();
    const res = await request(app).get("/api/health");
    expect(res.headers["content-security-policy"]).toBeUndefined();
  });
});
