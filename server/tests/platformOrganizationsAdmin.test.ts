import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { eq, and } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { platformOperators, auditEvents, companies, userSessions, users } from "../src/db/schema.js";
import { hashPassword } from "../src/lib/password.js";

// P0 hardening (MIDAD Final Pre-Launch, SaaS & Sale-Readiness Audit,
// Phase 4) — Platform Admin Control Center: organization detail view,
// suspend, reactivate, and revoke-sessions. Mirrors platformPlans.test.ts's
// auth-boundary/audit-event discipline.

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

async function registerCompany(name: string) {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ companyName: name, name: "Owner", email: uniqueEmail("org-admin-owner"), password: "password123" });
  expect(res.status).toBe(201);
  return { token: res.body.token as string, companyId: res.body.company.id as string };
}

let operatorToken: string;

async function resetAndRecreateOperator() {
  await resetDb();
  const email = uniqueEmail("org-admin-operator");
  await db.insert(platformOperators).values({ email, name: "Operator", passwordHash: await hashPassword("operatorpass123") });
  const login = await request(app).post("/api/platform/auth/login").send({ email, password: "operatorpass123" });
  expect(login.status).toBe(200);
  operatorToken = login.body.token;
}

describe("platform organizations admin: auth boundary", () => {
  beforeEach(resetAndRecreateOperator);

  it("unauthenticated access to every new route is rejected", async () => {
    const { companyId } = await registerCompany("Co A");
    expect((await request(app).get(`/api/platform/organizations/${companyId}`)).status).toBe(401);
    expect((await request(app).post(`/api/platform/organizations/${companyId}/suspend`).send({ reason: "test reason" })).status).toBe(401);
    expect((await request(app).post(`/api/platform/organizations/${companyId}/reactivate`)).status).toBe(401);
    expect((await request(app).post(`/api/platform/organizations/${companyId}/revoke-sessions`).send({ reason: "test reason" })).status).toBe(401);
  });

  it("a tenant JWT is rejected on every new route", async () => {
    const { token, companyId } = await registerCompany("Co A");
    expect((await request(app).get(`/api/platform/organizations/${companyId}`).set("Authorization", `Bearer ${token}`)).status).toBe(401);
    expect(
      (await request(app).post(`/api/platform/organizations/${companyId}/suspend`).set("Authorization", `Bearer ${token}`).send({ reason: "test reason" })).status,
    ).toBe(401);
  });
});

describe("platform organizations admin: detail view allowlist", () => {
  beforeEach(resetAndRecreateOperator);

  it("returns only aggregate/allowlisted fields, never PII or a user list", async () => {
    const { companyId } = await registerCompany("Riyadh Construction Co");
    const res = await request(app).get(`/api/platform/organizations/${companyId}`).set("Authorization", `Bearer ${operatorToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: companyId,
      name: "Riyadh Construction Co",
      status: "active",
      plan: null,
      entitlements: { maxUsers: null, maxProjects: null, maxStorageMb: null, maxInvoicesPerMonth: null },
      usage: { userCount: 1, projectCount: 0 },
      zatca: { egsUnitCount: 0, byStatus: {} },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/taxId|address|phone|logoPath|featureFlags|passwordHash|email/i);
  });

  it("a nonexistent company returns 404", async () => {
    const res = await request(app)
      .get(`/api/platform/organizations/00000000-0000-0000-0000-000000000000`)
      .set("Authorization", `Bearer ${operatorToken}`);
    expect(res.status).toBe(404);
  });

  it("entitlements reflect an actually-assigned plan, via the same evaluation lib/entitlements.ts uses everywhere else", async () => {
    const { companyId } = await registerCompany("Co A");
    await request(app)
      .post("/api/platform/plans")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ key: "starter", name: "Starter", limits: { maxUsers: 5 } });
    await request(app)
      .put(`/api/platform/plans/assignments/${companyId}`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ planKey: "starter" });

    const res = await request(app).get(`/api/platform/organizations/${companyId}`).set("Authorization", `Bearer ${operatorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.plan).toEqual({ key: "starter", name: "Starter" });
    expect(res.body.entitlements.maxUsers).toBe(5);
  });
});

describe("platform organizations admin: suspend / reactivate", () => {
  beforeEach(resetAndRecreateOperator);

  it("suspend requires a reason", async () => {
    const { companyId } = await registerCompany("Co A");
    const res = await request(app)
      .post(`/api/platform/organizations/${companyId}/suspend`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("suspend blocks the company's users on their very next request and revokes active sessions", async () => {
    const { token, companyId } = await registerCompany("Co A");

    // Sanity: token works before suspension.
    expect((await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`)).status).toBe(200);

    const suspendRes = await request(app)
      .post(`/api/platform/organizations/${companyId}/suspend`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ reason: "Unpaid invoice" });
    expect(suspendRes.status).toBe(200);
    expect(suspendRes.body).toMatchObject({ id: companyId, status: "suspended", revokedSessionCount: 1 });

    const company = await db.query.companies.findFirst({ where: eq(companies.id, companyId) });
    expect(company!.status).toBe("suspended");

    const blockedRes = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
    expect(blockedRes.status).toBe(401);

    const companyUsers = await db.query.users.findMany({ where: eq(users.companyId, companyId) });
    for (const u of companyUsers) {
      const rows = await db.query.userSessions.findMany({ where: eq(userSessions.userId, u.id) });
      expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
    }
  });

  it("suspending an already-suspended company returns 409", async () => {
    const { companyId } = await registerCompany("Co A");
    await request(app).post(`/api/platform/organizations/${companyId}/suspend`).set("Authorization", `Bearer ${operatorToken}`).send({ reason: "test reason" });
    const res = await request(app)
      .post(`/api/platform/organizations/${companyId}/suspend`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ reason: "another reason" });
    expect(res.status).toBe(409);
  });

  it("reactivate restores access on the next request", async () => {
    const { token, companyId } = await registerCompany("Co A");
    await request(app).post(`/api/platform/organizations/${companyId}/suspend`).set("Authorization", `Bearer ${operatorToken}`).send({ reason: "test reason" });
    expect((await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`)).status).toBe(401);

    const reactivateRes = await request(app)
      .post(`/api/platform/organizations/${companyId}/reactivate`)
      .set("Authorization", `Bearer ${operatorToken}`);
    expect(reactivateRes.status).toBe(200);
    expect(reactivateRes.body).toMatchObject({ id: companyId, status: "active" });

    // The old (pre-suspend) session was revoked, not un-revoked, so the
    // *same* token is still rejected — reactivation restores the
    // organization, it does not resurrect an already-revoked session. A
    // fresh login is required, which is the correct security posture.
    expect((await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`)).status).toBe(401);

    const login = await request(app).post("/api/auth/login").send({ email: (await db.query.users.findFirst({ where: eq(users.companyId, companyId) }))!.email, password: "password123" });
    expect(login.status).toBe(200);
    expect((await request(app).get("/api/auth/me").set("Authorization", `Bearer ${login.body.token}`)).status).toBe(200);
  });

  it("reactivating an already-active company returns 409", async () => {
    const { companyId } = await registerCompany("Co A");
    const res = await request(app).post(`/api/platform/organizations/${companyId}/reactivate`).set("Authorization", `Bearer ${operatorToken}`);
    expect(res.status).toBe(409);
  });

  it("suspend records an audit_events row with reason and platformOperatorId", async () => {
    const { companyId } = await registerCompany("Co A");
    await request(app)
      .post(`/api/platform/organizations/${companyId}/suspend`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ reason: "Unpaid invoice" });

    const events = await db.query.auditEvents.findMany({
      where: and(eq(auditEvents.companyId, companyId), eq(auditEvents.action, "organization.suspended")),
    });
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe("platform_admin");
    expect(events[0].reason).toBe("Unpaid invoice");
  });

  it("tenant isolation: suspending company A never affects company B", async () => {
    const a = await registerCompany("Co A");
    const b = await registerCompany("Co B");
    await request(app).post(`/api/platform/organizations/${a.companyId}/suspend`).set("Authorization", `Bearer ${operatorToken}`).send({ reason: "test reason" });

    expect((await request(app).get("/api/auth/me").set("Authorization", `Bearer ${a.token}`)).status).toBe(401);
    expect((await request(app).get("/api/auth/me").set("Authorization", `Bearer ${b.token}`)).status).toBe(200);
  });
});

describe("platform organizations admin: revoke-sessions (without suspending)", () => {
  beforeEach(resetAndRecreateOperator);

  it("requires a reason", async () => {
    const { companyId } = await registerCompany("Co A");
    const res = await request(app).post(`/api/platform/organizations/${companyId}/revoke-sessions`).set("Authorization", `Bearer ${operatorToken}`).send({});
    expect(res.status).toBe(400);
  });

  it("revokes active sessions without suspending the company", async () => {
    const { token, companyId } = await registerCompany("Co A");
    const res = await request(app)
      .post(`/api/platform/organizations/${companyId}/revoke-sessions`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ reason: "Suspected compromised account" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: companyId, revokedSessionCount: 1 });

    // Session is dead...
    expect((await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`)).status).toBe(401);
    // ...but the company itself is still active, so a fresh login works.
    const company = await db.query.companies.findFirst({ where: eq(companies.id, companyId) });
    expect(company!.status).toBe("active");
  });

  it("records an audit_events row scoped to the target company", async () => {
    const { companyId } = await registerCompany("Co A");
    await request(app)
      .post(`/api/platform/organizations/${companyId}/revoke-sessions`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ reason: "Suspected compromised account" });

    const events = await db.query.auditEvents.findMany({
      where: and(eq(auditEvents.companyId, companyId), eq(auditEvents.action, "organization.sessions_revoked")),
    });
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe("platform_admin");
  });
});
