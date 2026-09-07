import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { PUBLIC_DOCUMENT_RATE_LIMIT_MAX } from "../src/middleware/rateLimit.js";

// Defects report item 1.2 — the public, unauthenticated quote/invoice view
// routes (no login, just a random publicToken) previously had no rate
// limit of any kind. Kept in its own file for the same reason
// observabilityRateLimit.test.ts is: exhausting a shared-per-file limiter
// would starve every other test in whatever file it ran alongside.
//
// Loops past PUBLIC_DOCUMENT_RATE_LIMIT_MAX (raised only in the test
// environment — see rateLimit.ts's limitFor()) rather than a hardcoded
// guess, so this proves the real 429 path regardless of environment.

const app = buildApp();

describe("public document rate limit", () => {
  it("repeated requests to a public quote link eventually receive 429", async () => {
    await resetDb();
    let last: request.Response | null = null;
    for (let i = 0; i < PUBLIC_DOCUMENT_RATE_LIMIT_MAX + 5; i++) {
      last = await request(app).get("/api/public/quotes/nonexistent-token-value");
      if (last.status === 429) break;
    }
    expect(last!.status).toBe(429);
  });

  it("repeated requests to a public invoice link eventually receive 429", async () => {
    await resetDb();
    let last: request.Response | null = null;
    for (let i = 0; i < PUBLIC_DOCUMENT_RATE_LIMIT_MAX + 5; i++) {
      last = await request(app).get("/api/public/invoices/nonexistent-token-value");
      if (last.status === 429) break;
    }
    expect(last!.status).toBe(429);
  });
});
