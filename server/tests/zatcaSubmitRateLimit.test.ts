import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { ZATCA_SUBMIT_RATE_LIMIT_MAX } from "../src/middleware/rateLimit.js";

// Defects report item 1.2 — POST /submissions/:id/submit is the one ZATCA
// route with a real external cost/quota; it previously had no rate limit
// at all. Kept in its own file for the same reason
// observabilityRateLimit.test.ts is: exhausting a shared-per-file limiter
// would starve every other test in whatever file it ran alongside.
//
// Loops past ZATCA_SUBMIT_RATE_LIMIT_MAX (raised only in the test
// environment — see rateLimit.ts's limitFor()) rather than a hardcoded
// guess. Targets a nonexistent submission id deliberately — the limiter
// runs as middleware before the route handler, so it counts every request
// regardless of the handler's own 404, which keeps this test fast.

const app = buildApp();
let ownerToken: string;

describe("ZATCA submit rate limit", () => {
  beforeAll(async () => {
    await resetDb();
    const res = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "Rate Limit Co", name: "Owner", email: "zatca-ratelimit@test.com", password: "password123" });
    ownerToken = res.body.token;
  });

  it("repeated submit attempts for the same company eventually receive 429, keyed per company not global", async () => {
    let last: request.Response | null = null;
    for (let i = 0; i < ZATCA_SUBMIT_RATE_LIMIT_MAX + 5; i++) {
      last = await request(app)
        .post("/api/zatca/submissions/00000000-0000-0000-0000-000000000000/submit")
        .set("Authorization", `Bearer ${ownerToken}`);
      if (last.status === 429) break;
    }
    expect(last!.status).toBe(429);
  });
});
