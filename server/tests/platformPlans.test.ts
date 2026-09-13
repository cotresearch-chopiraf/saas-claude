import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { eq, and } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { platformOperators, auditEvents, companies } from "../src/db/schema.js";
import { hashPassword } from "../src/lib/password.js";

// P0 hardening (MIDAD Final Pre-Launch, SaaS & Sale-Readiness Audit) —
// platform-admin CRUD over the plan registry and per-company plan
// assignment, mirroring platformFeatureFlags.test.ts's auth-boundary
// discipline.

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

async function registerCompany(name: string) {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ companyName: name, name: "Owner", email: uniqueEmail("pp-owner"), password: "password123" });
  expect(res.status).toBe(201);
  return { token: res.body.token as string, companyId: res.body.company.id as string };
}

let operatorToken: string;

async function resetAndRecreateOperator() {
  await resetDb();
  const email = uniqueEmail("pp-operator");
  await db.insert(platformOperators).values({ email, name: "Operator", passwordHash: await hashPassword("operatorpass123") });
  const login = await request(app).post("/api/platform/auth/login").send({ email, password: "operatorpass123" });
  expect(login.status).toBe(200);
  operatorToken = login.body.token;
}

describe("platform plans: auth boundary", () => {
  beforeEach(resetAndRecreateOperator);

  it("unauthenticated access is rejected", async () => {
    const res = await request(app).get("/api/platform/plans");
    expect(res.status).toBe(401);
  });

  it("a tenant JWT is rejected", async () => {
    const { token } = await registerCompany("Co A");
    const res = await request(app).get("/api/platform/plans").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
  });
});

describe("platform plans: registry CRUD", () => {
  beforeEach(resetAndRecreateOperator);

  it("creates a plan with no price/billing field in the response (none exists)", async () => {
    const res = await request(app)
      .post("/api/platform/plans")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ key: "starter", name: "Starter", limits: { maxUsers: 5, maxProjects: 10 } });
    expect(res.status).toBe(201);
    expect(res.body.key).toBe("starter");
    expect(res.body.limits).toEqual({ maxUsers: 5, maxProjects: 10, maxStorageMb: null, maxInvoicesPerMonth: null });
    expect(res.body.price).toBeUndefined();
  });

  it("rejects a duplicate plan key", async () => {
    await request(app).post("/api/platform/plans").set("Authorization", `Bearer ${operatorToken}`).send({ key: "starter", name: "Starter" });
    const dup = await request(app).post("/api/platform/plans").set("Authorization", `Bearer ${operatorToken}`).send({ key: "starter", name: "Starter 2" });
    expect(dup.status).toBe(409);
  });

  it("PATCH updates limits by merging, not replacing the whole object", async () => {
    await request(app)
      .post("/api/platform/plans")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ key: "starter", name: "Starter", limits: { maxUsers: 5 } });

    const patchRes = await request(app)
      .patch("/api/platform/plans/starter")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ limits: { maxProjects: 20 } });
    expect(patchRes.status).toBe(200);
    // maxUsers survives the merge; maxProjects is newly set.
    expect(patchRes.body.limits.maxUsers).toBe(5);
    expect(patchRes.body.limits.maxProjects).toBe(20);
  });

  it("PATCH on an unknown plan key returns 404", async () => {
    const res = await request(app)
      .patch("/api/platform/plans/nonexistent_plan_xyz")
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ isActive: false });
    expect(res.status).toBe(404);
  });
});

describe("platform plans: company assignment", () => {
  beforeEach(resetAndRecreateOperator);

  it("assigns a plan to a company and it's reflected in the companies row", async () => {
    await request(app).post("/api/platform/plans").set("Authorization", `Bearer ${operatorToken}`).send({ key: "starter", name: "Starter" });
    const { companyId } = await registerCompany("Co A");

    const res = await request(app)
      .put(`/api/platform/plans/assignments/${companyId}`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ planKey: "starter" });
    expect(res.status).toBe(200);
    expect(res.body.planId).toBeTruthy();

    const company = await db.query.companies.findFirst({ where: eq(companies.id, companyId) });
    expect(company!.planId).toBe(res.body.planId);
  });

  it("assigning planKey: null clears the company's plan", async () => {
    await request(app).post("/api/platform/plans").set("Authorization", `Bearer ${operatorToken}`).send({ key: "starter", name: "Starter" });
    const { companyId } = await registerCompany("Co A");
    await request(app)
      .put(`/api/platform/plans/assignments/${companyId}`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ planKey: "starter" });

    const clearRes = await request(app)
      .put(`/api/platform/plans/assignments/${companyId}`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ planKey: null });
    expect(clearRes.status).toBe(200);
    expect(clearRes.body.planId).toBeNull();
  });

  it("assigning an unknown plan key returns 404", async () => {
    const { companyId } = await registerCompany("Co A");
    const res = await request(app)
      .put(`/api/platform/plans/assignments/${companyId}`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ planKey: "nonexistent_plan_xyz" });
    expect(res.status).toBe(404);
  });

  it("assigning to a nonexistent company returns 404", async () => {
    await request(app).post("/api/platform/plans").set("Authorization", `Bearer ${operatorToken}`).send({ key: "starter", name: "Starter" });
    const res = await request(app)
      .put(`/api/platform/plans/assignments/00000000-0000-0000-0000-000000000000`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ planKey: "starter" });
    expect(res.status).toBe(404);
  });

  it("records an audit_events row scoped to the target company on assignment", async () => {
    await request(app).post("/api/platform/plans").set("Authorization", `Bearer ${operatorToken}`).send({ key: "starter", name: "Starter" });
    const { companyId } = await registerCompany("Co A");

    await request(app)
      .put(`/api/platform/plans/assignments/${companyId}`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ planKey: "starter" });

    const events = await db.query.auditEvents.findMany({
      where: and(eq(auditEvents.companyId, companyId), eq(auditEvents.action, "plan.assigned")),
    });
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe("platform_admin");
  });
});
