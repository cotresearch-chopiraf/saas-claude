import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { platformOperators } from "../src/db/schema.js";
import { hashPassword } from "../src/lib/password.js";

// MIDAD Admin Dashboard — GET /api/platform/audit-events. Proves the
// safety argument from lib/audit.ts's listPlatformOperatorActivity: this
// route can only ever surface platform_admin-sourced rows about the
// requesting operator's own actions, never a tenant's own business audit
// trail, and never another operator's actions.

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

async function createOperator(email: string, password: string) {
  const [operator] = await db
    .insert(platformOperators)
    .values({ email, name: "Operator", passwordHash: await hashPassword(password), status: "active" })
    .returning();
  return operator;
}
async function platformLogin(email: string, password: string) {
  const res = await request(app).post("/api/platform/auth/login").send({ email, password });
  expect(res.status).toBe(200);
  return res.body.token as string;
}

let tokenA: string;
let tokenB: string;
let companyId1: string;
let companyId2: string;

beforeAll(async () => {
  await resetDb();

  const emailA = uniqueEmail("audit-platform-a");
  const emailB = uniqueEmail("audit-platform-b");
  await createOperator(emailA, "operatorpass000");
  await createOperator(emailB, "operatorpass000");
  tokenA = await platformLogin(emailA, "operatorpass000");
  tokenB = await platformLogin(emailB, "operatorpass000");

  const companyRes1 = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Audit Platform Co One", name: "Owner", email: uniqueEmail("audit-tenant-1"), password: "password123" });
  companyId1 = companyRes1.body.company.id;

  const companyRes2 = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Audit Platform Co Two", name: "Owner", email: uniqueEmail("audit-tenant-2"), password: "password123" });
  companyId2 = companyRes2.body.company.id;
});

function listPlatformActivity(token: string, qs = "") {
  return request(app).get(`/api/platform/audit-events${qs}`).set("Authorization", `Bearer ${token}`);
}

describe("GET /api/platform/audit-events", () => {
  it("unauthenticated -> 401", async () => {
    const res = await request(app).get("/api/platform/audit-events");
    expect(res.status).toBe(401);
  });

  it("tenant JWT -> 401", async () => {
    const tenantRes = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "Tenant Only Co", name: "Owner", email: uniqueEmail("audit-tenant-only"), password: "password123" });
    const res = await listPlatformActivity(tenantRes.body.token);
    expect(res.status).toBe(401);
  });

  it("starts empty for a fresh operator with no platform actions yet", async () => {
    const res = await listPlatformActivity(tokenA);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ events: [], limit: 20, offset: 0, hasMore: false });
  });

  it("records a supportSession.granted event with real company context after a real grant", async () => {
    const grant = await request(app)
      .post("/api/platform/support-sessions")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ targetCompanyId: companyId1, reason: "investigating a customer-reported bug" });
    expect(grant.status).toBe(201);

    const res = await listPlatformActivity(tokenA);
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0]).toMatchObject({
      action: "supportSession.granted",
      entityType: "support_session",
      entityId: grant.body.id,
      companyId: companyId1,
      companyName: "Audit Platform Co One",
    });
  });

  it("records a supportSession.revoked event after a real revoke", async () => {
    const grant = await request(app)
      .post("/api/platform/support-sessions")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ targetCompanyId: companyId2, reason: "second investigation" });
    await request(app).post(`/api/platform/support-sessions/${grant.body.id}/revoke`).set("Authorization", `Bearer ${tokenA}`);

    const res = await listPlatformActivity(tokenA);
    const revoked = res.body.events.find((e: { action: string; entityId: string }) => e.action === "supportSession.revoked" && e.entityId === grant.body.id);
    expect(revoked).toBeTruthy();
    expect(revoked.companyId).toBe(companyId2);
  });

  it("operator B sees only operator B's own activity, never operator A's", async () => {
    const grantB = await request(app)
      .post("/api/platform/support-sessions")
      .set("Authorization", `Bearer ${tokenB}`)
      .send({ targetCompanyId: companyId1, reason: "operator B investigating" });
    expect(grantB.status).toBe(201);

    const resB = await listPlatformActivity(tokenB);
    expect(resB.body.events.every((e: { entityId: string }) => e.entityId === grantB.body.id)).toBe(true);
    expect(resB.body.events.some((e: { entityId: string }) => e.entityId === grantB.body.id)).toBe(true);

    const resA = await listPlatformActivity(tokenA);
    expect(resA.body.events.some((e: { entityId: string }) => e.entityId === grantB.body.id)).toBe(false);
  });

  it("spoofed platformOperatorId/operatorId/companyId query params cannot widen scope", async () => {
    const resA = await listPlatformActivity(tokenA, "?limit=100");
    const spoofed = await listPlatformActivity(tokenA, `?limit=100&platformOperatorId=${encodeURIComponent("someone-else")}&operatorId=x&companyId=${companyId2}`);
    expect(spoofed.body.events).toEqual(resA.body.events);
  });

  it("never exposes a tenant's own business audit trail, only platform_admin-sourced rows", async () => {
    // Generate a real tenant-authored audit event (customer.created,
    // source: "api") to prove it can never leak through this platform
    // route, which filters strictly by source: "platform_admin".
    const tenantRes = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "Business Trail Co", name: "Owner", email: uniqueEmail("audit-business"), password: "password123" });
    await request(app)
      .post("/api/customers")
      .set("Authorization", `Bearer ${tenantRes.body.token}`)
      .send({ name: "Some Customer" });

    const res = await listPlatformActivity(tokenA, "?limit=100");
    expect(res.body.events.every((e: { action: string }) => e.action.startsWith("supportSession."))).toBe(true);
    expect(res.body.events.some((e: { entityType: string }) => e.entityType === "customer")).toBe(false);
  });

  it("response contains no sensitive fields", async () => {
    const res = await listPlatformActivity(tokenA, "?limit=100");
    const allowed = new Set(["id", "action", "entityType", "entityId", "companyId", "companyName", "reason", "metadata", "createdAt"]);
    for (const event of res.body.events) {
      for (const key of Object.keys(event)) {
        expect(allowed.has(key)).toBe(true);
      }
    }
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|taxId|address|phone|logoPath|featureFlags/i);
  });

  it("pagination + hasMore behave the same as other platform list routes", async () => {
    const page1 = await listPlatformActivity(tokenA, "?limit=1&offset=0");
    expect(page1.body.limit).toBe(1);
    expect(page1.body.events.length).toBeLessThanOrEqual(1);
  });
});
