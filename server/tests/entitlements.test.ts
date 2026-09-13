import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { plans, companies } from "../src/db/schema.js";
import { getCompanyLimits, checkLimit, assertWithinLimit, LimitExceededError } from "../src/lib/entitlements.js";

// P0 hardening (MIDAD Final Pre-Launch, SaaS & Sale-Readiness Audit) —
// Plans & Entitlements. Covers the centralized evaluation function
// directly, and the one real endpoint wired to it (company invites'
// maxUsers check) end to end.

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

async function registerCompany(name: string) {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ companyName: name, name: "Owner", email: uniqueEmail("ent-owner"), password: "password123" });
  expect(res.status).toBe(201);
  return { token: res.body.token as string, companyId: res.body.company.id as string };
}

async function createPlan(key: string, overrides: Partial<typeof plans.$inferInsert> = {}) {
  const [plan] = await db
    .insert(plans)
    .values({ key, name: key, limits: { maxUsers: null, maxProjects: null, maxStorageMb: null, maxInvoicesPerMonth: null }, ...overrides })
    .returning();
  return plan;
}

async function assignPlan(companyId: string, planId: string | null) {
  await db.update(companies).set({ planId }).where(eq(companies.id, companyId));
}

describe("entitlements: getCompanyLimits / checkLimit precedence", () => {
  beforeEach(resetDb);

  it("a company with no plan assigned is unlimited", async () => {
    const { companyId } = await registerCompany("Co A");
    const limits = await getCompanyLimits(companyId);
    expect(limits.maxUsers).toBeNull();
    expect(limits.maxProjects).toBeNull();
  });

  it("a company on a plan with a real limit has that limit enforced", async () => {
    const { companyId } = await registerCompany("Co A");
    const plan = await createPlan("starter", { limits: { maxUsers: 3, maxProjects: null, maxStorageMb: null, maxInvoicesPerMonth: null } });
    await assignPlan(companyId, plan.id);

    const limits = await getCompanyLimits(companyId);
    expect(limits.maxUsers).toBe(3);
  });

  it("checkLimit reports allowed=true while under the limit, false once at/over it", async () => {
    const { companyId } = await registerCompany("Co A");
    const plan = await createPlan("starter", { limits: { maxUsers: 3, maxProjects: null, maxStorageMb: null, maxInvoicesPerMonth: null } });
    await assignPlan(companyId, plan.id);

    expect((await checkLimit(companyId, "maxUsers", 2)).allowed).toBe(true);
    expect((await checkLimit(companyId, "maxUsers", 3)).allowed).toBe(false);
    expect((await checkLimit(companyId, "maxUsers", 4)).allowed).toBe(false);
  });

  it("assertWithinLimit throws LimitExceededError once the limit is reached", async () => {
    const { companyId } = await registerCompany("Co A");
    const plan = await createPlan("starter", { limits: { maxUsers: 1, maxProjects: null, maxStorageMb: null, maxInvoicesPerMonth: null } });
    await assignPlan(companyId, plan.id);

    await expect(assertWithinLimit(companyId, "maxUsers", 1)).rejects.toThrow(LimitExceededError);
    await expect(assertWithinLimit(companyId, "maxUsers", 0)).resolves.toBeUndefined();
  });

  it("a company whose assigned plan has been deleted fails OPEN (unlimited), not closed", async () => {
    const { companyId } = await registerCompany("Co A");
    const plan = await createPlan("temp_plan", { limits: { maxUsers: 1, maxProjects: null, maxStorageMb: null, maxInvoicesPerMonth: null } });
    await assignPlan(companyId, plan.id);
    // Delete the plan row directly (bypassing the FK's onDelete: set null
    // by deleting fast enough there's no app-level cleanup — simulates a
    // genuine data inconsistency, not the normal deletion path).
    await db.delete(plans).where(eq(plans.id, plan.id));

    const limits = await getCompanyLimits(companyId);
    expect(limits.maxUsers).toBeNull();
  });

  it("tenant isolation: company A's plan/limit never affects company B's evaluation", async () => {
    const a = await registerCompany("Co A");
    const b = await registerCompany("Co B");
    const plan = await createPlan("starter", { limits: { maxUsers: 1, maxProjects: null, maxStorageMb: null, maxInvoicesPerMonth: null } });
    await assignPlan(a.companyId, plan.id);

    const limitsA = await getCompanyLimits(a.companyId);
    const limitsB = await getCompanyLimits(b.companyId);
    expect(limitsA.maxUsers).toBe(1);
    expect(limitsB.maxUsers).toBeNull();
  });
});

describe("entitlements: maxUsers wired into POST /api/company/invites", () => {
  beforeEach(resetDb);

  it("with no plan assigned, inviting members is unrestricted", async () => {
    const { token } = await registerCompany("Co A");
    const res = await request(app)
      .post("/api/company/invites")
      .set("Authorization", `Bearer ${token}`)
      .send({ email: uniqueEmail("invitee"), role: "member" });
    expect(res.status).toBe(201);
  });

  it("once the active-user count reaches maxUsers, further invites are rejected with 403", async () => {
    const { token, companyId } = await registerCompany("Co A");
    // maxUsers=1 and the owner themselves is already 1 active user.
    const plan = await createPlan("solo", { limits: { maxUsers: 1, maxProjects: null, maxStorageMb: null, maxInvoicesPerMonth: null } });
    await assignPlan(companyId, plan.id);

    const res = await request(app)
      .post("/api/company/invites")
      .set("Authorization", `Bearer ${token}`)
      .send({ email: uniqueEmail("invitee"), role: "member" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBeTruthy();
  });

  it("raising the plan's maxUsers immediately unblocks further invites for the same company", async () => {
    const { token, companyId } = await registerCompany("Co A");
    const plan = await createPlan("solo", { limits: { maxUsers: 1, maxProjects: null, maxStorageMb: null, maxInvoicesPerMonth: null } });
    await assignPlan(companyId, plan.id);

    const blocked = await request(app)
      .post("/api/company/invites")
      .set("Authorization", `Bearer ${token}`)
      .send({ email: uniqueEmail("invitee"), role: "member" });
    expect(blocked.status).toBe(403);

    await db.update(plans).set({ limits: { maxUsers: 5, maxProjects: null, maxStorageMb: null, maxInvoicesPerMonth: null } }).where(eq(plans.id, plan.id));

    const allowed = await request(app)
      .post("/api/company/invites")
      .set("Authorization", `Bearer ${token}`)
      .send({ email: uniqueEmail("invitee"), role: "member" });
    expect(allowed.status).toBe(201);
  });

  it("tenant isolation: company B's invites are unaffected by company A's maxUsers limit", async () => {
    const a = await registerCompany("Co A");
    const b = await registerCompany("Co B");
    const plan = await createPlan("solo", { limits: { maxUsers: 1, maxProjects: null, maxStorageMb: null, maxInvoicesPerMonth: null } });
    await assignPlan(a.companyId, plan.id);

    const aRes = await request(app)
      .post("/api/company/invites")
      .set("Authorization", `Bearer ${a.token}`)
      .send({ email: uniqueEmail("invitee-a"), role: "member" });
    expect(aRes.status).toBe(403);

    const bRes = await request(app)
      .post("/api/company/invites")
      .set("Authorization", `Bearer ${b.token}`)
      .send({ email: uniqueEmail("invitee-b"), role: "member" });
    expect(bRes.status).toBe(201);
  });
});
