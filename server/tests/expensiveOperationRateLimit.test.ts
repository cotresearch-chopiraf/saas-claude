import { describe, it, expect, beforeAll } from "vitest";
import express from "express";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { expensiveOperationRateLimit, EXPENSIVE_OPERATION_RATE_LIMIT_MAX } from "../src/middleware/rateLimit.js";

// 18-phase internal remediation, Phase 3 — audit finding: the
// authenticated invoice/quote PDF routes and the document upload route
// had no rate limiter at all. Two things are proven here:
//
// 1. The limiter itself (isolated, no real DB/PDF work per request, so
//    looping past EXPENSIVE_OPERATION_RATE_LIMIT_MAX is fast) actually
//    returns 429 once exceeded, and is keyed per-company — the same
//    proof shape as publicDocumentRateLimit.test.ts, adapted because
//    looping hundreds of real authenticated PDF-render/upload requests
//    through the full app would be far too slow for a test.
// 2. The real route (one request, not a loop) actually has the limiter
//    mounted — proven via the RateLimit-Limit response header
//    express-rate-limit's standardHeaders:true sets, matching the
//    exported constant.

describe("expensiveOperationRateLimit (isolated): 429 after the limit, keyed per company", () => {
  function buildTestApp() {
    const app = express();
    app.use((req, _res, next) => {
      req.companyId = (req.headers["x-test-company-id"] as string) ?? "unknown";
      next();
    });
    app.get("/probe", expensiveOperationRateLimit, (_req, res) => res.json({ ok: true }));
    return app;
  }

  it("returns 429 once EXPENSIVE_OPERATION_RATE_LIMIT_MAX is exceeded", async () => {
    const app = buildTestApp();
    let last: request.Response | null = null;
    for (let i = 0; i < EXPENSIVE_OPERATION_RATE_LIMIT_MAX + 5; i++) {
      last = await request(app).get("/probe").set("x-test-company-id", "company-rl-1");
      if (last.status === 429) break;
    }
    expect(last!.status).toBe(429);
  });

  it("is keyed per company — a different company has its own untouched budget", async () => {
    const app = buildTestApp();
    for (let i = 0; i < EXPENSIVE_OPERATION_RATE_LIMIT_MAX + 5; i++) {
      const res = await request(app).get("/probe").set("x-test-company-id", "company-rl-a");
      if (res.status === 429) break;
    }
    const otherCompany = await request(app).get("/probe").set("x-test-company-id", "company-rl-b");
    expect(otherCompany.status).toBe(200);
  });
});

describe("expensiveOperationRateLimit is actually mounted on the real routes", () => {
  const app = buildApp();
  let token: string;

  beforeAll(async () => {
    await resetDb();
    const res = await request(app)
      .post("/api/auth/register")
      .send({
        companyName: "RateLimit Wiring Co",
        name: "Owner",
        email: `ratelimit-wiring-${Date.now()}@test.com`,
        password: "password123",
      });
    token = res.body.token;
  });

  it("GET /api/invoices/:id/pdf carries the RateLimit-Limit header matching EXPENSIVE_OPERATION_RATE_LIMIT_MAX", async () => {
    const res = await request(app)
      .get("/api/invoices/00000000-0000-0000-0000-000000000000/pdf")
      .set("Authorization", `Bearer ${token}`);
    expect(res.headers["ratelimit-limit"]).toBe(String(EXPENSIVE_OPERATION_RATE_LIMIT_MAX));
  });

  it("GET /api/quotes/:id/pdf carries the RateLimit-Limit header matching EXPENSIVE_OPERATION_RATE_LIMIT_MAX", async () => {
    const res = await request(app)
      .get("/api/quotes/00000000-0000-0000-0000-000000000000/pdf")
      .set("Authorization", `Bearer ${token}`);
    expect(res.headers["ratelimit-limit"]).toBe(String(EXPENSIVE_OPERATION_RATE_LIMIT_MAX));
  });

  it("POST /api/projects/:projectId/documents carries the RateLimit-Limit header matching EXPENSIVE_OPERATION_RATE_LIMIT_MAX", async () => {
    // A real, owned project — a nonexistent one is rejected by
    // documentsRouter's own project-ownership check BEFORE the route
    // (and its rate limiter) is ever reached, which would prove nothing
    // about the limiter itself.
    const project = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: `RL Wiring Project ${Math.random()}` });
    const projectId = project.body.id as string;

    const res = await request(app)
      .post(`/api/projects/${projectId}/documents`)
      .set("Authorization", `Bearer ${token}`)
      .attach("document", Buffer.from("x"), { filename: "x.png", contentType: "image/png" });
    expect(res.headers["ratelimit-limit"]).toBe(String(EXPENSIVE_OPERATION_RATE_LIMIT_MAX));
  });
});
