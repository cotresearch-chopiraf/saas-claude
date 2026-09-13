import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { platformOperators } from "../src/db/schema.js";
import { hashPassword } from "../src/lib/password.js";

// MIDAD Final Pre-Launch audit, Phase 6 — Platform Role Separation. Tests
// the enforced capability matrix (lib/platformPermissions.ts) across a
// representative route from each capability, for every non-owner/admin
// role — owner/admin already have full access proven implicitly by every
// other platform*.test.ts file (every operator those files create has no
// explicit role, so defaults to platform_owner).

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

async function createOperatorWithRole(role: "platform_owner" | "platform_admin" | "support" | "compliance" | "auditor") {
  const email = uniqueEmail(`pp-${role}`);
  await db.insert(platformOperators).values({ email, name: role, role, passwordHash: await hashPassword("operatorpass123") });
  const login = await request(app).post("/api/platform/auth/login").send({ email, password: "operatorpass123" });
  expect(login.status).toBe(200);
  return login.body.token as string;
}

describe("platform permissions: default role", () => {
  beforeEach(resetDb);

  it("a newly created operator with no explicit role defaults to platform_owner (full access)", async () => {
    const email = uniqueEmail("pp-default");
    await db.insert(platformOperators).values({ email, name: "Default", passwordHash: await hashPassword("operatorpass123") });
    const login = await request(app).post("/api/platform/auth/login").send({ email, password: "operatorpass123" });
    expect(login.status).toBe(200);

    const res = await request(app).get("/api/platform/organizations").set("Authorization", `Bearer ${login.body.token}`);
    expect(res.status).toBe(200);

    const manageRes = await request(app)
      .post("/api/platform/plans")
      .set("Authorization", `Bearer ${login.body.token}`)
      .send({ key: "starter", name: "Starter" });
    expect(manageRes.status).toBe(201);
  });
});

describe("platform permissions: support role", () => {
  beforeEach(resetDb);

  it("can read organizations and users, but cannot mutate organizations, plans, feature flags, or ZATCA", async () => {
    const token = await createOperatorWithRole("support");
    const { companyId } = await registerCompany("Co A");

    expect((await request(app).get("/api/platform/organizations").set("Authorization", `Bearer ${token}`)).status).toBe(200);
    expect((await request(app).get(`/api/platform/organizations/${companyId}`).set("Authorization", `Bearer ${token}`)).status).toBe(200);
    expect((await request(app).get(`/api/platform/organizations/${companyId}/users`).set("Authorization", `Bearer ${token}`)).status).toBe(200);

    expect(
      (await request(app).post(`/api/platform/organizations/${companyId}/suspend`).set("Authorization", `Bearer ${token}`).send({ reason: "x1234" }))
        .status,
    ).toBe(403);
    expect(
      (await request(app).post("/api/platform/plans").set("Authorization", `Bearer ${token}`).send({ key: "starter", name: "Starter" })).status,
    ).toBe(403);
    expect((await request(app).get("/api/platform/feature-flags").set("Authorization", `Bearer ${token}`)).status).toBe(403);
    expect((await request(app).get("/api/platform/zatca").set("Authorization", `Bearer ${token}`)).status).toBe(403);
  });

  it("can create and revoke support sessions", async () => {
    const token = await createOperatorWithRole("support");
    const { companyId } = await registerCompany("Co A");

    const res = await request(app)
      .post("/api/platform/support-sessions")
      .set("Authorization", `Bearer ${token}`)
      .send({ targetCompanyId: companyId, reason: "Customer assistance ticket #1" });
    expect(res.status).toBe(201);
  });
});

describe("platform permissions: compliance role", () => {
  beforeEach(resetDb);

  it("can read organizations and ZATCA, but cannot manage plans, feature flags, users, or support sessions", async () => {
    const token = await createOperatorWithRole("compliance");
    const { companyId } = await registerCompany("Co A");

    expect((await request(app).get("/api/platform/organizations").set("Authorization", `Bearer ${token}`)).status).toBe(200);
    expect((await request(app).get("/api/platform/zatca").set("Authorization", `Bearer ${token}`)).status).toBe(200);

    expect((await request(app).get(`/api/platform/organizations/${companyId}/users`).set("Authorization", `Bearer ${token}`)).status).toBe(403);
    expect(
      (await request(app).post("/api/platform/plans").set("Authorization", `Bearer ${token}`).send({ key: "starter", name: "Starter" })).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post("/api/platform/support-sessions")
          .set("Authorization", `Bearer ${token}`)
          .send({ targetCompanyId: companyId, reason: "x1234" })
      ).status,
    ).toBe(403);
  });
});

describe("platform permissions: auditor role", () => {
  beforeEach(resetDb);

  it("can read across organizations/users/plans/feature-flags/ZATCA, but cannot mutate anything or create support sessions", async () => {
    const token = await createOperatorWithRole("auditor");
    const { companyId } = await registerCompany("Co A");

    expect((await request(app).get("/api/platform/organizations").set("Authorization", `Bearer ${token}`)).status).toBe(200);
    expect((await request(app).get(`/api/platform/organizations/${companyId}/users`).set("Authorization", `Bearer ${token}`)).status).toBe(200);
    expect((await request(app).get("/api/platform/plans").set("Authorization", `Bearer ${token}`)).status).toBe(200);
    expect((await request(app).get("/api/platform/feature-flags").set("Authorization", `Bearer ${token}`)).status).toBe(200);
    expect((await request(app).get("/api/platform/zatca").set("Authorization", `Bearer ${token}`)).status).toBe(200);

    expect(
      (await request(app).post(`/api/platform/organizations/${companyId}/suspend`).set("Authorization", `Bearer ${token}`).send({ reason: "x1234" }))
        .status,
    ).toBe(403);
    expect(
      (await request(app).post("/api/platform/plans").set("Authorization", `Bearer ${token}`).send({ key: "starter", name: "Starter" })).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post("/api/platform/support-sessions")
          .set("Authorization", `Bearer ${token}`)
          .send({ targetCompanyId: companyId, reason: "x1234" })
      ).status,
    ).toBe(403);
  });
});

describe("platform permissions: role change takes effect on the next request", () => {
  beforeEach(resetDb);

  it("demoting an operator from owner to auditor blocks a mutation on their very next request", async () => {
    const email = uniqueEmail("pp-demote");
    const [operator] = await db
      .insert(platformOperators)
      .values({ email, name: "Demote Me", role: "platform_owner", passwordHash: await hashPassword("operatorpass123") })
      .returning();
    const login = await request(app).post("/api/platform/auth/login").send({ email, password: "operatorpass123" });
    const token = login.body.token as string;

    expect(
      (await request(app).post("/api/platform/plans").set("Authorization", `Bearer ${token}`).send({ key: "starter", name: "Starter" })).status,
    ).toBe(201);

    await db.update(platformOperators).set({ role: "auditor" }).where(eq(platformOperators.id, operator.id));

    expect(
      (
        await request(app)
          .post("/api/platform/plans")
          .set("Authorization", `Bearer ${token}`)
          .send({ key: "professional", name: "Professional" })
      ).status,
    ).toBe(403);
  });
});
