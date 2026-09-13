import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { featureFlags, companyFeatureFlagOverrides } from "../src/db/schema.js";
import { isFeatureEnabled, requireFeatureFlag } from "../src/lib/featureFlags.js";

// P0 hardening (MIDAD Final Pre-Launch, SaaS & Sale-Readiness Audit) —
// Feature Flags foundation. Covers the precedence rules directly
// (isFeatureEnabled) and the tenant-facing read endpoint end to end.

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

async function registerCompany(name: string) {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ companyName: name, name: "Owner", email: uniqueEmail("ff-owner"), password: "password123" });
  expect(res.status).toBe(201);
  return { token: res.body.token as string, companyId: res.body.company.id as string };
}

async function createFlag(key: string, overrides: Partial<typeof featureFlags.$inferInsert> = {}) {
  const [flag] = await db
    .insert(featureFlags)
    .values({ key, description: "test flag", globalEnabled: false, defaultEnabledForOrgs: false, ...overrides })
    .returning();
  return flag;
}

describe("feature flags: precedence (isFeatureEnabled)", () => {
  beforeEach(resetDb);

  it("an unknown flag key returns false (fail closed)", async () => {
    const { companyId } = await registerCompany("Co A");
    expect(await isFeatureEnabled(companyId, "nonexistent_flag_xyz")).toBe(false);
  });

  it("a globally-disabled flag is disabled for every company, no matter what", async () => {
    const { companyId } = await registerCompany("Co A");
    await createFlag("beta_reports", { globalEnabled: false, defaultEnabledForOrgs: true });
    expect(await isFeatureEnabled(companyId, "beta_reports")).toBe(false);
  });

  it("a globally-enabled flag with defaultEnabledForOrgs=true is enabled by default (no override needed)", async () => {
    const { companyId } = await registerCompany("Co A");
    await createFlag("beta_reports", { globalEnabled: true, defaultEnabledForOrgs: true });
    expect(await isFeatureEnabled(companyId, "beta_reports")).toBe(true);
  });

  it("a globally-enabled flag with defaultEnabledForOrgs=false is disabled by default (opt-in only)", async () => {
    const { companyId } = await registerCompany("Co A");
    await createFlag("beta_reports", { globalEnabled: true, defaultEnabledForOrgs: false });
    expect(await isFeatureEnabled(companyId, "beta_reports")).toBe(false);
  });

  it("an explicit per-company override wins over the default (enabled)", async () => {
    const { companyId } = await registerCompany("Co A");
    const flag = await createFlag("beta_reports", { globalEnabled: true, defaultEnabledForOrgs: false });
    await db.insert(companyFeatureFlagOverrides).values({ companyId, flagKey: flag.key, enabled: true });
    expect(await isFeatureEnabled(companyId, "beta_reports")).toBe(true);
  });

  it("an explicit per-company override wins over the default (disabled), even though defaultEnabledForOrgs is true", async () => {
    const { companyId } = await registerCompany("Co A");
    const flag = await createFlag("beta_reports", { globalEnabled: true, defaultEnabledForOrgs: true });
    await db.insert(companyFeatureFlagOverrides).values({ companyId, flagKey: flag.key, enabled: false });
    expect(await isFeatureEnabled(companyId, "beta_reports")).toBe(false);
  });

  it("a per-company override does NOT bypass a global OFF", async () => {
    const { companyId } = await registerCompany("Co A");
    const flag = await createFlag("beta_reports", { globalEnabled: false, defaultEnabledForOrgs: false });
    await db.insert(companyFeatureFlagOverrides).values({ companyId, flagKey: flag.key, enabled: true });
    expect(await isFeatureEnabled(companyId, "beta_reports")).toBe(false);
  });

  it("tenant isolation: company A's override never affects company B's evaluation of the same flag", async () => {
    const a = await registerCompany("Co A");
    const b = await registerCompany("Co B");
    const flag = await createFlag("beta_reports", { globalEnabled: true, defaultEnabledForOrgs: false });
    await db.insert(companyFeatureFlagOverrides).values({ companyId: a.companyId, flagKey: flag.key, enabled: true });

    expect(await isFeatureEnabled(a.companyId, "beta_reports")).toBe(true);
    expect(await isFeatureEnabled(b.companyId, "beta_reports")).toBe(false);
  });

  it("an enabledEnvironments restriction that excludes the current NODE_ENV disables the flag regardless of global/org state", async () => {
    const { companyId } = await registerCompany("Co A");
    await createFlag("beta_reports", {
      globalEnabled: true,
      defaultEnabledForOrgs: true,
      enabledEnvironments: ["production"], // tests run with NODE_ENV=test
    });
    expect(await isFeatureEnabled(companyId, "beta_reports")).toBe(false);
  });

  it("an enabledEnvironments list that includes the current NODE_ENV does not restrict the flag", async () => {
    const { companyId } = await registerCompany("Co A");
    await createFlag("beta_reports", {
      globalEnabled: true,
      defaultEnabledForOrgs: true,
      enabledEnvironments: ["test", "production"],
    });
    expect(await isFeatureEnabled(companyId, "beta_reports")).toBe(true);
  });
});

describe("feature flags: server-side enforcement middleware (requireFeatureFlag)", () => {
  beforeEach(resetDb);

  function buildGatedApp(flagKey: string, companyId: string) {
    const gated = express();
    gated.use((req, _res, next) => {
      (req as unknown as { companyId: string }).companyId = companyId;
      next();
    });
    gated.get("/gated", requireFeatureFlag(flagKey), (_req, res) => res.json({ secret: true }));
    return gated;
  }

  it("returns 404, not the guarded response, when the flag is off — never leaks that the route exists via a 403", async () => {
    const { companyId } = await registerCompany("Co A");
    const res = await request(buildGatedApp("nonexistent_flag_xyz", companyId)).get("/gated");
    expect(res.status).toBe(404);
    expect(res.body.secret).toBeUndefined();
  });

  it("passes through to the real handler once the flag is enabled for that company", async () => {
    const { companyId } = await registerCompany("Co A");
    await createFlag("beta_reports", { globalEnabled: true, defaultEnabledForOrgs: true });
    const res = await request(buildGatedApp("beta_reports", companyId)).get("/gated");
    expect(res.status).toBe(200);
    expect(res.body.secret).toBe(true);
  });
});

describe("GET /api/feature-flags — tenant-facing effective flag set", () => {
  beforeEach(resetDb);

  it("requires authentication (unauthorized access rejected)", async () => {
    const res = await request(app).get("/api/feature-flags");
    expect(res.status).toBe(401);
  });

  it("returns the effective evaluated value for every known flag, not the raw registry", async () => {
    const { token, companyId } = await registerCompany("Co A");
    const flagOn = await createFlag("flag_on", { globalEnabled: true, defaultEnabledForOrgs: true });
    await createFlag("flag_off", { globalEnabled: true, defaultEnabledForOrgs: false });
    await db.insert(companyFeatureFlagOverrides).values({ companyId, flagKey: flagOn.key, enabled: false });

    const res = await request(app).get("/api/feature-flags").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    // Override forces flag_on to false for this company, despite defaultEnabledForOrgs=true.
    expect(res.body.flags.flag_on).toBe(false);
    expect(res.body.flags.flag_off).toBe(false);
  });

  it("tenant isolation: two companies see independently correct effective values", async () => {
    const a = await registerCompany("Co A");
    const b = await registerCompany("Co B");
    const flag = await createFlag("beta_reports", { globalEnabled: true, defaultEnabledForOrgs: false });
    await db.insert(companyFeatureFlagOverrides).values({ companyId: a.companyId, flagKey: flag.key, enabled: true });

    const resA = await request(app).get("/api/feature-flags").set("Authorization", `Bearer ${a.token}`);
    const resB = await request(app).get("/api/feature-flags").set("Authorization", `Bearer ${b.token}`);
    expect(resA.body.flags.beta_reports).toBe(true);
    expect(resB.body.flags.beta_reports).toBe(false);
  });
});
