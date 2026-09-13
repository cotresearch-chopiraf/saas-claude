import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { eq, and } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { platformOperators, auditEvents, companyFeatureFlagOverrides } from "../src/db/schema.js";
import { hashPassword } from "../src/lib/password.js";

// P0 hardening (MIDAD Final Pre-Launch, SaaS & Sale-Readiness Audit) —
// platform-admin CRUD over the feature-flag registry and per-company
// overrides, mirroring platformOrganizations.test.ts's auth-boundary
// discipline: never requireAuth, always platformAuth.

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

async function registerCompany(name: string) {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ companyName: name, name: "Owner", email: uniqueEmail("pff-owner"), password: "password123" });
  expect(res.status).toBe(201);
  return { token: res.body.token as string, companyId: res.body.company.id as string };
}

async function createOperator() {
  const email = uniqueEmail("pff-operator");
  await db.insert(platformOperators).values({ email, name: "Operator", passwordHash: await hashPassword("operatorpass123") });
  const login = await request(app).post("/api/platform/auth/login").send({ email, password: "operatorpass123" });
  expect(login.status).toBe(200);
  return login.body.token as string;
}

let operatorToken: string;

async function resetAndRecreateOperator() {
  await resetDb();
  operatorToken = await createOperator();
}

describe("platform feature flags: auth boundary", () => {
  beforeEach(resetAndRecreateOperator);

  it("unauthenticated access to the list route is rejected", async () => {
    const res = await request(app).get("/api/platform/feature-flags");
    expect(res.status).toBe(401);
  });

  it("a tenant JWT (not a platform operator token) is rejected", async () => {
    const { token } = await registerCompany("Co A");
    const res = await request(app).get("/api/platform/feature-flags").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
  });
});

describe("platform feature flags: registry CRUD", () => {
  beforeEach(resetAndRecreateOperator);

  it("creates a flag with the requested defaults and lists it back", async () => {
    const createRes = await request(app)
      .post("/api/platform/feature-flags")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ key: "beta_reports", description: "Beta reporting module", globalEnabled: false, defaultEnabledForOrgs: false });
    expect(createRes.status).toBe(201);
    expect(createRes.body.key).toBe("beta_reports");
    expect(createRes.body.globalEnabled).toBe(false);

    const listRes = await request(app).get("/api/platform/feature-flags").set("Authorization", `Bearer ${operatorToken}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.flags.map((f: { key: string }) => f.key)).toContain("beta_reports");
  });

  it("rejects a duplicate flag key", async () => {
    await request(app)
      .post("/api/platform/feature-flags")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ key: "beta_reports", description: "First" });

    const dup = await request(app)
      .post("/api/platform/feature-flags")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ key: "beta_reports", description: "Second" });
    expect(dup.status).toBe(409);
  });

  it("rejects an invalid key format", async () => {
    const res = await request(app)
      .post("/api/platform/feature-flags")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ key: "Beta Reports!", description: "Bad key" });
    expect(res.status).toBe(400);
  });

  it("PATCH toggles globalEnabled and the change is reflected in a subsequent GET", async () => {
    await request(app)
      .post("/api/platform/feature-flags")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ key: "beta_reports", description: "Beta reporting", globalEnabled: false });

    const patchRes = await request(app)
      .patch("/api/platform/feature-flags/beta_reports")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ globalEnabled: true });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.globalEnabled).toBe(true);

    const listRes = await request(app).get("/api/platform/feature-flags").set("Authorization", `Bearer ${operatorToken}`);
    const flag = listRes.body.flags.find((f: { key: string }) => f.key === "beta_reports");
    expect(flag.globalEnabled).toBe(true);
  });

  it("PATCH on an unknown flag key returns 404", async () => {
    const res = await request(app)
      .patch("/api/platform/feature-flags/nonexistent_flag_xyz")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ globalEnabled: true });
    expect(res.status).toBe(404);
  });
});

describe("platform feature flags: per-company overrides", () => {
  beforeEach(resetAndRecreateOperator);

  it("sets an override, which is immediately reflected in the tenant's effective flag set", async () => {
    await request(app)
      .post("/api/platform/feature-flags")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ key: "beta_reports", description: "Beta reporting", globalEnabled: true, defaultEnabledForOrgs: false });
    const { token, companyId } = await registerCompany("Co A");

    const before = await request(app).get("/api/feature-flags").set("Authorization", `Bearer ${token}`);
    expect(before.body.flags.beta_reports).toBe(false);

    const overrideRes = await request(app)
      .put(`/api/platform/feature-flags/beta_reports/overrides/${companyId}`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ enabled: true });
    expect(overrideRes.status).toBe(200);

    const after = await request(app).get("/api/feature-flags").set("Authorization", `Bearer ${token}`);
    expect(after.body.flags.beta_reports).toBe(true);
  });

  it("tenant isolation: an override for company A never appears as an override for company B", async () => {
    await request(app)
      .post("/api/platform/feature-flags")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ key: "beta_reports", description: "Beta reporting", globalEnabled: true });
    const a = await registerCompany("Co A");
    const b = await registerCompany("Co B");

    await request(app)
      .put(`/api/platform/feature-flags/beta_reports/overrides/${a.companyId}`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ enabled: true });

    const overridesRes = await request(app)
      .get("/api/platform/feature-flags/beta_reports/overrides")
      .set("Authorization", `Bearer ${operatorToken}`);
    const companyIds = overridesRes.body.overrides.map((o: { companyId: string }) => o.companyId);
    expect(companyIds).toContain(a.companyId);
    expect(companyIds).not.toContain(b.companyId);
  });

  it("records an audit_events row scoped to the target company on override set", async () => {
    await request(app)
      .post("/api/platform/feature-flags")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ key: "beta_reports", description: "Beta reporting", globalEnabled: true });
    const { companyId } = await registerCompany("Co A");

    await request(app)
      .put(`/api/platform/feature-flags/beta_reports/overrides/${companyId}`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ enabled: true });

    const events = await db.query.auditEvents.findMany({
      where: and(eq(auditEvents.companyId, companyId), eq(auditEvents.action, "featureFlag.overrideSet")),
    });
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe("platform_admin");
  });

  it("DELETE clears an override, reverting the company to the default", async () => {
    await request(app)
      .post("/api/platform/feature-flags")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ key: "beta_reports", description: "Beta reporting", globalEnabled: true, defaultEnabledForOrgs: false });
    const { token, companyId } = await registerCompany("Co A");

    await request(app)
      .put(`/api/platform/feature-flags/beta_reports/overrides/${companyId}`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ enabled: true });

    const deleteRes = await request(app)
      .delete(`/api/platform/feature-flags/beta_reports/overrides/${companyId}`)
      .set("Authorization", `Bearer ${operatorToken}`);
    expect(deleteRes.status).toBe(204);

    const remaining = await db.query.companyFeatureFlagOverrides.findFirst({
      where: and(eq(companyFeatureFlagOverrides.companyId, companyId), eq(companyFeatureFlagOverrides.flagKey, "beta_reports")),
    });
    expect(remaining).toBeUndefined();

    const after = await request(app).get("/api/feature-flags").set("Authorization", `Bearer ${token}`);
    expect(after.body.flags.beta_reports).toBe(false);
  });

  it("setting an override for a nonexistent company returns 404", async () => {
    await request(app)
      .post("/api/platform/feature-flags")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ key: "beta_reports", description: "Beta reporting", globalEnabled: true });

    const res = await request(app)
      .put(`/api/platform/feature-flags/beta_reports/overrides/00000000-0000-0000-0000-000000000000`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ enabled: true });
    expect(res.status).toBe(404);
  });
});
