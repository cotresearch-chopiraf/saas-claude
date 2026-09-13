import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { platformOperators } from "../src/db/schema.js";
import { hashPassword } from "../src/lib/password.js";

// MIDAD Final Pre-Launch audit, Phase 9 (foundation) — platform operator
// sessions. Until now a platform JWT was fully stateless (7 days, no
// revocation lever short of deactivating the whole account); this closes
// that gap the same way userSessions already does for tenant users, and
// is the prerequisite Ownership Transfer's "Revoke Previous Owner
// Sessions" step depends on.

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

async function createOperator() {
  const email = uniqueEmail("pos-operator");
  await db.insert(platformOperators).values({ email, name: "Operator", passwordHash: await hashPassword("operatorpass123") });
  return email;
}

beforeEach(resetDb);

describe("platform operator sessions", () => {
  it("login issues a token tied to a real session row, and /me-equivalent (organizations list) works", async () => {
    const email = await createOperator();
    const login = await request(app).post("/api/platform/auth/login").send({ email, password: "operatorpass123" });
    expect(login.status).toBe(200);
    expect(login.body.token).toBeTruthy();

    const res = await request(app).get("/api/platform/organizations").set("Authorization", `Bearer ${login.body.token}`);
    expect(res.status).toBe(200);
  });

  it("logout revokes the current session, blocking the same token on the next request", async () => {
    const email = await createOperator();
    const login = await request(app).post("/api/platform/auth/login").send({ email, password: "operatorpass123" });
    const token = login.body.token as string;

    const logout = await request(app).post("/api/platform/auth/logout").set("Authorization", `Bearer ${token}`);
    expect(logout.status).toBe(200);

    const blocked = await request(app).get("/api/platform/organizations").set("Authorization", `Bearer ${token}`);
    expect(blocked.status).toBe(401);
  });

  it("logging out one session does not affect a second, independently issued session for the same operator", async () => {
    const email = await createOperator();
    const loginA = await request(app).post("/api/platform/auth/login").send({ email, password: "operatorpass123" });
    const loginB = await request(app).post("/api/platform/auth/login").send({ email, password: "operatorpass123" });

    await request(app).post("/api/platform/auth/logout").set("Authorization", `Bearer ${loginA.body.token}`);

    expect((await request(app).get("/api/platform/organizations").set("Authorization", `Bearer ${loginA.body.token}`)).status).toBe(401);
    expect((await request(app).get("/api/platform/organizations").set("Authorization", `Bearer ${loginB.body.token}`)).status).toBe(200);
  });

  it("logout requires authentication", async () => {
    const res = await request(app).post("/api/platform/auth/logout");
    expect(res.status).toBe(401);
  });
});
