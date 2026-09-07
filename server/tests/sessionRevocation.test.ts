import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";

// Defects report item 1.1 — session revocation for regular users. Same
// "row per issued token, revokedAt checked every request" pattern already
// proven for platform support sessions (middleware/requireSupportSession.ts),
// extended to userSessions (schema.ts) + middleware/auth.ts's requireAuth.

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

describe("session revocation", () => {
  beforeAll(async () => {
    await resetDb();
  });

  it("a fresh token works on a protected route", async () => {
    const email = uniqueEmail("session-fresh");
    const res = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "Session Co", name: "Owner", email, password: "password123" });
    expect(res.status).toBe(201);

    const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${res.body.token}`);
    expect(me.status).toBe(200);
  });

  it("POST /auth/logout revokes the token used to call it — the same token is rejected afterward", async () => {
    const email = uniqueEmail("session-logout");
    const registerRes = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "Logout Co", name: "Owner", email, password: "password123" });
    const token = registerRes.body.token as string;

    const logoutRes = await request(app).post("/api/auth/logout").set("Authorization", `Bearer ${token}`);
    expect(logoutRes.status).toBe(200);

    const afterLogout = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
    expect(afterLogout.status).toBe(401);
  });

  it("logging out one device's session does not affect a different device's session for the same user", async () => {
    const email = uniqueEmail("session-multidevice");
    const password = "password123";
    await request(app)
      .post("/api/auth/register")
      .send({ companyName: "Multi Device Co", name: "Owner", email, password });

    const loginA = await request(app).post("/api/auth/login").send({ email, password });
    const loginB = await request(app).post("/api/auth/login").send({ email, password });
    const tokenA = loginA.body.token as string;
    const tokenB = loginB.body.token as string;
    expect(tokenA).not.toBe(tokenB);

    const logoutA = await request(app).post("/api/auth/logout").set("Authorization", `Bearer ${tokenA}`);
    expect(logoutA.status).toBe(200);

    const meA = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${tokenA}`);
    expect(meA.status).toBe(401);

    const meB = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${tokenB}`);
    expect(meB.status).toBe(200);
  });

  it("resetting a password revokes every existing session for that user, not just future logins", async () => {
    const email = uniqueEmail("session-reset");
    const password = "originalPassword123";
    await request(app).post("/api/auth/register").send({ companyName: "Reset Co", name: "Owner", email, password });

    const loginA = await request(app).post("/api/auth/login").send({ email, password });
    const loginB = await request(app).post("/api/auth/login").send({ email, password });
    const tokenA = loginA.body.token as string;
    const tokenB = loginB.body.token as string;

    // Reach directly into the reset-token table via the request-reset route
    // is out of scope here — this test exercises reset-password's own
    // session-revocation side effect via its documented DB-level contract:
    // insert a valid, unused token row and consume it exactly like the
    // route itself would from a real emailed link.
    const { db } = await import("../src/db/client.js");
    const { passwordResetTokens, users } = await import("../src/db/schema.js");
    const { hashToken, generateToken } = await import("../src/lib/tokens.js");
    const { eq } = await import("drizzle-orm");

    const user = await db.query.users.findFirst({ where: eq(users.email, email) });
    const rawToken = generateToken();
    await db.insert(passwordResetTokens).values({
      userId: user!.id,
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const resetRes = await request(app)
      .post("/api/auth/reset-password")
      .send({ token: rawToken, newPassword: "brandNewPassword456" });
    expect(resetRes.status).toBe(200);

    const meA = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${tokenA}`);
    const meB = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${tokenB}`);
    expect(meA.status).toBe(401);
    expect(meB.status).toBe(401);
  });

  it("logout is idempotent — calling it twice with the same token never 500s", async () => {
    const email = uniqueEmail("session-idempotent");
    const registerRes = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "Idempotent Co", name: "Owner", email, password: "password123" });
    const token = registerRes.body.token as string;

    const first = await request(app).post("/api/auth/logout").set("Authorization", `Bearer ${token}`);
    expect(first.status).toBe(200);

    // The token's own session is now revoked, so requireAuth itself rejects
    // the second call before the logout handler ever runs again — that is
    // the correct, safe outcome (401, never a 500), not a redundant revoke.
    const second = await request(app).post("/api/auth/logout").set("Authorization", `Bearer ${token}`);
    expect(second.status).toBe(401);
  });
});
