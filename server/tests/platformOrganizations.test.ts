import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { platformOperators } from "../src/db/schema.js";
import { hashPassword } from "../src/lib/password.js";

// MIDAD — Platform Organization Search. Extends the existing, already-
// authorized GET /api/platform/organizations (Phase D1) with an optional
// `search` query param — case-insensitive partial match on companies.name.
// No new endpoint, no new permission, no schema change; the existing
// three-field response allowlist (id/name/createdAt), pagination contract,
// and platformAuth boundary are all unchanged by this slice — this file
// exists to prove exactly that, alongside the new filtering behavior.

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

async function registerCompany(name: string) {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ companyName: name, name: "Owner", email: uniqueEmail("org-search"), password: "password123" });
  expect(res.status).toBe(201);
  return { token: res.body.token as string, companyId: res.body.company.id as string };
}

async function createOperator(email: string, password: string) {
  const [operator] = await db
    .insert(platformOperators)
    .values({ email, name: "Operator", passwordHash: await hashPassword(password) })
    .returning();
  return operator;
}

function listOrganizations(token: string, qs = "") {
  return request(app).get(`/api/platform/organizations${qs}`).set("Authorization", `Bearer ${token}`);
}

let operatorToken: string;
let ownerToken: string;
let riyadhAlphaId: string;
let jeddahBetaId: string;
let riyadhGammaId: string;

beforeAll(async () => {
  await resetDb();

  const alpha = await registerCompany("Riyadh Construction Alpha");
  riyadhAlphaId = alpha.companyId;
  ownerToken = alpha.token;

  const beta = await registerCompany("Jeddah Builders Beta");
  jeddahBetaId = beta.companyId;

  const gamma = await registerCompany("Riyadh Logistics Gamma");
  riyadhGammaId = gamma.companyId;

  const operatorEmail = uniqueEmail("org-search-operator");
  await createOperator(operatorEmail, "operatorpass123");
  const login = await request(app).post("/api/platform/auth/login").send({ email: operatorEmail, password: "operatorpass123" });
  expect(login.status).toBe(200);
  operatorToken = login.body.token;
});

describe("organization search", () => {
  it("1. omitting search preserves the existing unfiltered behavior", async () => {
    const res = await listOrganizations(operatorToken, "?limit=100");
    expect(res.status).toBe(200);
    const ids = res.body.organizations.map((o: { id: string }) => o.id);
    expect(ids).toEqual(expect.arrayContaining([riyadhAlphaId, jeddahBetaId, riyadhGammaId]));
  });

  it("2. a partial name match returns only matching organizations", async () => {
    const res = await listOrganizations(operatorToken, "?search=Riyadh&limit=100");
    expect(res.status).toBe(200);
    const ids = res.body.organizations.map((o: { id: string }) => o.id);
    expect(ids).toEqual(expect.arrayContaining([riyadhAlphaId, riyadhGammaId]));
    expect(ids).not.toContain(jeddahBetaId);
  });

  it("3. search is case-insensitive", async () => {
    const lower = await listOrganizations(operatorToken, "?search=riyadh&limit=100");
    const upper = await listOrganizations(operatorToken, "?search=RIYADH&limit=100");
    const idsLower = lower.body.organizations.map((o: { id: string }) => o.id).sort();
    const idsUpper = upper.body.organizations.map((o: { id: string }) => o.id).sort();
    expect(idsLower).toEqual(idsUpper);
    expect(idsLower).toEqual(expect.arrayContaining([riyadhAlphaId, riyadhGammaId]));
  });

  it("4. a non-matching search returns an empty, still-valid page", async () => {
    const res = await listOrganizations(operatorToken, "?search=NoSuchCompanyNameXYZ");
    expect(res.status).toBe(200);
    expect(res.body.organizations).toEqual([]);
    expect(res.body.hasMore).toBe(false);
  });

  it("5. search combined with pagination works correctly", async () => {
    const page1 = await listOrganizations(operatorToken, "?search=Riyadh&limit=1&offset=0");
    expect(page1.status).toBe(200);
    expect(page1.body.organizations).toHaveLength(1);
    expect(page1.body.hasMore).toBe(true);

    const page2 = await listOrganizations(operatorToken, "?search=Riyadh&limit=1&offset=1");
    expect(page2.body.organizations).toHaveLength(1);
    expect(page2.body.hasMore).toBe(false);

    expect(page1.body.organizations[0].id).not.toBe(page2.body.organizations[0].id);
  });

  it("6. search never widens the response field allowlist", async () => {
    const res = await listOrganizations(operatorToken, "?search=Riyadh&limit=1");
    const [org] = res.body.organizations;
    expect(Object.keys(org).sort()).toEqual(["createdAt", "id", "name"]);
    expect(JSON.stringify(res.body)).not.toMatch(/taxId|address|phone|logoPath|featureFlags|passwordHash/i);
  });

  it("7. whitespace-only search is treated as no search, not a meaningless filter", async () => {
    const res = await listOrganizations(operatorToken, "?search=%20%20%20&limit=100");
    expect(res.status).toBe(200);
    const ids = res.body.organizations.map((o: { id: string }) => o.id);
    expect(ids).toEqual(expect.arrayContaining([riyadhAlphaId, jeddahBetaId, riyadhGammaId]));
  });

  it("8. platform authentication remains enforced with search present", async () => {
    const unauth = await request(app).get("/api/platform/organizations?search=Riyadh");
    expect(unauth.status).toBe(401);

    const tenantJwtRejected = await listOrganizations(ownerToken, "?search=Riyadh");
    expect(tenantJwtRejected.status).toBe(401);
  });

  it("9. existing pagination behavior without search is unchanged", async () => {
    const res = await listOrganizations(operatorToken, "?limit=2&offset=0");
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(2);
    expect(res.body.offset).toBe(0);
    expect(res.body.organizations.length).toBeLessThanOrEqual(2);
  });
});
