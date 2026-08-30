import { describe, it, expect } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";

// MIDAD Phase B — kept in its own file deliberately: exhausting
// authRateLimit (10 req/15min/IP, shared across every /api/auth/* route) is
// the only way to observe a real 429, and doing that in a file shared with
// other tests would starve their own register/login/accept-invite calls.
// Vitest gives each test file its own module registry (fileParallelism is
// off but isolate is on), so this file's rate-limit state never leaks into
// or out of any other test file.

const app = buildApp();

describe("RATE_LIMITED error code", () => {
  it("20. repeated auth attempts eventually receive 429 with a machine-readable RATE_LIMITED code", async () => {
    await resetDb();
    let last: request.Response | null = null;
    for (let i = 0; i < 15; i++) {
      last = await request(app).post("/api/auth/login").send({ email: "nobody@test.com", password: "wrong" });
      if (last.status === 429) break;
    }
    expect(last!.status).toBe(429);
    expect(last!.body.code).toBe("RATE_LIMITED");
    expect(last!.body.requestId).toBeTruthy();
  });
});
