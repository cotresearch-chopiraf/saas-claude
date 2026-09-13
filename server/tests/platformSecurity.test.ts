import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { platformOperators } from "../src/db/schema.js";
import { hashPassword } from "../src/lib/password.js";

// MIDAD Final Pre-Launch audit, Phase 7 — Security Center. Read-only,
// gated by the "security.read" capability (owner/admin/auditor, not
// support/compliance — see platformPermissions.test.ts for the general
// role-boundary matrix; this file focuses on this Center's own data
// shape and cross-scope visibility).

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

async function registerCompany(name: string) {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ companyName: name, name: "Owner", email: uniqueEmail("sec-owner"), password: "password123" });
  expect(res.status).toBe(201);
  return { token: res.body.token as string, companyId: res.body.company.id as string };
}

let operatorToken: string;
let operatorId: string;

async function resetAndRecreateOperator() {
  await resetDb();
  const email = uniqueEmail("sec-operator");
  const [operator] = await db
    .insert(platformOperators)
    .values({ email, name: "Operator", passwordHash: await hashPassword("operatorpass123") })
    .returning();
  operatorId = operator.id;
  const login = await request(app).post("/api/platform/auth/login").send({ email, password: "operatorpass123" });
  expect(login.status).toBe(200);
  operatorToken = login.body.token;
}

describe("platform security: auth boundary", () => {
  beforeEach(resetAndRecreateOperator);

  it("unauthenticated and tenant-JWT access are rejected on every route", async () => {
    const { token } = await registerCompany("Co A");
    expect((await request(app).get("/api/platform/security/overview")).status).toBe(401);
    expect((await request(app).get("/api/platform/security/overview").set("Authorization", `Bearer ${token}`)).status).toBe(401);
    expect((await request(app).get("/api/platform/security/admin-sessions")).status).toBe(401);
    expect((await request(app).get("/api/platform/security/sensitive-actions")).status).toBe(401);
  });
});

describe("platform security: overview", () => {
  beforeEach(resetAndRecreateOperator);

  it("never exposes secrets and honestly lists what is not available", async () => {
    const res = await request(app).get("/api/platform/security/overview").set("Authorization", `Bearer ${operatorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.adminSessions).toMatchObject({ total: 0, active: 0, expired: 0, revoked: 0 });
    expect(res.body.tenantSessions.activeCount).toBe(0);
    expect(res.body.notAvailable).toEqual(
      expect.arrayContaining(["failedLoginEvents", "rateLimitHitEvents", "automatedSuspiciousActivityDetection"]),
    );
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|secretRef|token/i);
  });

  it("reflects a real active tenant session and its age", async () => {
    await registerCompany("Co A");
    const res = await request(app).get("/api/platform/security/overview").set("Authorization", `Bearer ${operatorToken}`);
    expect(res.body.tenantSessions.activeCount).toBe(1);
    expect(res.body.tenantSessions.oldestActiveSessionAgeSeconds).toBeGreaterThanOrEqual(0);
  });
});

describe("platform security: admin-sessions (global, cross-operator)", () => {
  beforeEach(resetAndRecreateOperator);

  it("shows a support session created by a DIFFERENT operator than the viewer", async () => {
    const { companyId } = await registerCompany("Co A");

    const otherEmail = uniqueEmail("sec-other-operator");
    await db.insert(platformOperators).values({ email: otherEmail, name: "Other Operator", passwordHash: await hashPassword("operatorpass123") });
    const otherLogin = await request(app).post("/api/platform/auth/login").send({ email: otherEmail, password: "operatorpass123" });
    const otherToken = otherLogin.body.token as string;

    const created = await request(app)
      .post("/api/platform/support-sessions")
      .set("Authorization", `Bearer ${otherToken}`)
      .send({ targetCompanyId: companyId, reason: "Customer assistance ticket #1" });
    expect(created.status).toBe(201);

    // This operator's OWN self-scoped list would show nothing (different
    // operator created it) — the global security view shows it anyway.
    const ownList = await request(app).get("/api/platform/support-sessions").set("Authorization", `Bearer ${operatorToken}`);
    expect(ownList.body.sessions).toHaveLength(0);

    const securityView = await request(app).get("/api/platform/security/admin-sessions").set("Authorization", `Bearer ${operatorToken}`);
    expect(securityView.status).toBe(200);
    expect(securityView.body.sessions).toHaveLength(1);
    expect(securityView.body.sessions[0]).toMatchObject({
      targetCompanyId: companyId,
      targetCompanyName: "Co A",
      status: "active",
      platformOperatorName: "Other Operator",
    });
    expect(securityView.body.sessions[0].ageSeconds).toBeGreaterThanOrEqual(0);
  });
});

describe("platform security: sensitive-actions (global, cross-company)", () => {
  beforeEach(resetAndRecreateOperator);

  it("shows platform_admin actions across every company, with operator/company names resolved", async () => {
    const { companyId } = await registerCompany("Co A");

    await request(app)
      .post(`/api/platform/organizations/${companyId}/suspend`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ reason: "Unpaid invoice" });

    const res = await request(app).get("/api/platform/security/sensitive-actions").set("Authorization", `Bearer ${operatorToken}`);
    expect(res.status).toBe(200);
    const suspendEvent = res.body.events.find((e: { action: string }) => e.action === "organization.suspended");
    expect(suspendEvent).toMatchObject({
      companyId,
      companyName: "Co A",
      platformOperatorId: operatorId,
      reason: "Unpaid invoice",
    });
    expect(suspendEvent.platformOperatorName).toBeTruthy();
  });
});
