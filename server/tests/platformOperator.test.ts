import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { platformOperators } from "../src/db/schema.js";
import { hashPassword } from "../src/lib/password.js";

// MIDAD Phase D1 — Platform Operator Foundation. Proves the security
// boundary the Phase D architecture report exists to establish: a genuinely
// separate identity (platform_operators, no companyId, no relation to
// users/companies), a genuinely separate token (lib/platformJwt.ts, never
// verifiable against the tenant secret), and a genuinely separate
// middleware (platformAuth, never touching req.userId/req.companyId).
//
// authRateLimit is shared across BOTH /api/auth/* and /api/platform/auth/*
// (same exported middleware instance — see middleware/rateLimit.ts), so
// this file keeps its total auth-router-touching calls well under 10,
// following the same discipline as userManagement.test.ts.

vi.mock("../src/lib/mailer.js", () => ({ sendMail: vi.fn() }));
import { sendMail } from "../src/lib/mailer.js";

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

async function createOperator(email: string, password: string, status: "active" | "deactivated" = "active") {
  const [operator] = await db
    .insert(platformOperators)
    .values({ email, name: "Operator", passwordHash: await hashPassword(password), status })
    .returning();
  return operator;
}

function platformLogin(email: string, password: string) {
  return request(app).post("/api/platform/auth/login").send({ email, password });
}
function listOrganizations(token: string, qs = "") {
  return request(app).get(`/api/platform/organizations${qs}`).set("Authorization", `Bearer ${token}`);
}

let ownerAToken: string;
let ownerAId: string;
let ownerAEmail: string;
const ownerAPassword = "password123";
let operatorAEmail: string;
let operatorAPassword: string;
let operatorAToken: string;

beforeAll(async () => {
  await resetDb();

  // --- tenant side (1 auth-router call: register) ---
  ownerAEmail = uniqueEmail("plat-owner-a");
  const ownerARes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Platform Test Co A", name: "Owner A", email: ownerAEmail, password: ownerAPassword });
  expect(ownerARes.status).toBe(201);
  ownerAToken = ownerARes.body.token;
  ownerAId = ownerARes.body.user.id;

  // A second company purely so the org-list can prove it spans tenants
  // (Test H) without any of this file's other tests needing to know about it.
  await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Platform Test Co B", name: "Owner B", email: uniqueEmail("plat-owner-b"), password: "password123" });

  // --- platform side ---
  operatorAEmail = uniqueEmail("plat-operator-a");
  operatorAPassword = "operatorpass123";
  await createOperator(operatorAEmail, operatorAPassword);

  const loginRes = await platformLogin(operatorAEmail, operatorAPassword);
  expect(loginRes.status).toBe(200);
  operatorAToken = loginRes.body.token;
});

describe("platform login", () => {
  it("1. an active operator can log in and receives a platform token + safe operator info", async () => {
    // Reuses the beforeAll login response indirectly by re-asserting its shape via a fresh call.
    const email = uniqueEmail("plat-login-ok");
    await createOperator(email, "correctpass1");
    const res = await platformLogin(email, "correctpass1");
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    expect(res.body.operator.email).toBe(email);
    expect(res.body.operator).not.toHaveProperty("passwordHash");
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash/i);
  });

  it("2. an incorrect password is rejected", async () => {
    const res = await platformLogin(operatorAEmail, "totallyWrongPassword");
    expect(res.status).toBe(401);
  });

  it("3. a deactivated operator's login is rejected", async () => {
    const email = uniqueEmail("plat-deactivated");
    await createOperator(email, "correctpass1", "deactivated");
    const res = await platformLogin(email, "correctpass1");
    expect(res.status).toBe(401);
  });

  it("4. a real tenant owner's own real credentials are never valid on the platform login endpoint (separate identity, separate table)", async () => {
    const res = await platformLogin(ownerAEmail, ownerAPassword);
    expect(res.status).toBe(401);
  });
});

describe("platform token revocation (mirrors Phase A's requireAuth precedent)", () => {
  it("5. an active operator's token is accepted on the next request; deactivating them rejects that SAME still-valid token immediately", async () => {
    const email = uniqueEmail("plat-revoke");
    const operator = await createOperator(email, "correctpass1");
    const login = await platformLogin(email, "correctpass1");
    expect(login.status).toBe(200);
    const token = login.body.token as string;

    const before = await listOrganizations(token);
    expect(before.status).toBe(200);

    await db.update(platformOperators).set({ status: "deactivated" }).where(eq(platformOperators.id, operator.id));

    const after = await listOrganizations(token);
    expect(after.status).toBe(401);
  });

  it("6. deactivating one platform operator does not affect an unrelated tenant user's session", async () => {
    const res = await request(app).get("/api/customers").set("Authorization", `Bearer ${ownerAToken}`);
    expect(res.status).toBe(200);
  });

  it("7. deactivating a tenant user does not affect an unrelated platform operator's session", async () => {
    const memberEmail = uniqueEmail("plat-tenant-member");
    const inviteRes = await request(app)
      .post("/api/company/invites")
      .set("Authorization", `Bearer ${ownerAToken}`)
      .send({ email: memberEmail, role: "member" });
    expect(inviteRes.status).toBe(201);
    const mailCall = (sendMail as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    const inviteToken = (mailCall[2] as string).match(/token=([a-f0-9]{40,80})/)![1];
    const acceptRes = await request(app)
      .post("/api/auth/accept-invite")
      .send({ token: inviteToken, name: "Member", password: "memberpass123" });
    expect(acceptRes.status).toBe(201);
    const memberId = acceptRes.body.user.id as string;

    const deactivateRes = await request(app)
      .patch(`/api/company/members/${memberId}`)
      .set("Authorization", `Bearer ${ownerAToken}`)
      .send({ status: "deactivated" });
    expect(deactivateRes.status).toBe(200);

    const res = await listOrganizations(operatorAToken);
    expect(res.status).toBe(200);
  });
});

describe("scope isolation: COMPANY_SCOPE and PLATFORM_SCOPE are structurally separate", () => {
  it("8. Test A — a tenant JWT is rejected by a platform route", async () => {
    const res = await listOrganizations(ownerAToken);
    expect(res.status).toBe(401);
  });

  it("9. Test B — a platform JWT is accepted by a platform route", async () => {
    const res = await listOrganizations(operatorAToken);
    expect(res.status).toBe(200);
  });

  it("10. Test F/G mirror — a platform JWT is rejected by a company-scoped tenant route (no leaked tenant context either direction)", async () => {
    const res = await request(app).get("/api/customers").set("Authorization", `Bearer ${operatorAToken}`);
    expect(res.status).toBe(401);
  });

  it("11. Test C — injecting companyId/userId/role into the request body/query alongside a tenant JWT cannot grant platform authority", async () => {
    const res = await request(app)
      .get("/api/platform/organizations")
      .query({ companyId: "not-real", userId: "not-real", role: "platform_operator" })
      .set("Authorization", `Bearer ${ownerAToken}`);
    expect(res.status).toBe(401);
  });

  it("12. an unauthenticated request to a platform route is rejected", async () => {
    const res = await request(app).get("/api/platform/organizations");
    expect(res.status).toBe(401);
  });

  it("13. existing tenant-to-tenant isolation is unaffected by the existence of platform infrastructure", async () => {
    const res = await request(app).get("/api/customers").set("Authorization", `Bearer ${ownerAToken}`);
    expect(res.status).toBe(200);
  });
});

describe("platform organization list", () => {
  it("14. Test H — returns organizations spanning more than one tenant", async () => {
    const res = await listOrganizations(operatorAToken, "?limit=100");
    expect(res.status).toBe(200);
    const names = res.body.organizations.map((o: { name: string }) => o.name);
    expect(names).toContain("Platform Test Co A");
    expect(names).toContain("Platform Test Co B");
  });

  it("15. the default limit is bounded (20) and deterministic ordering holds", async () => {
    const res = await listOrganizations(operatorAToken);
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(20);
    const timestamps = res.body.organizations.map((o: { createdAt: string }) => new Date(o.createdAt).getTime());
    expect(timestamps).toEqual([...timestamps].sort((a, b) => b - a));
  });

  it("16. a limit above the maximum is rejected, not silently clamped", async () => {
    const res = await listOrganizations(operatorAToken, "?limit=99999");
    expect(res.status).toBe(400);
  });

  it("17. pagination behaves correctly and hasMore reflects whether more rows exist", async () => {
    const page1 = await listOrganizations(operatorAToken, "?limit=1&offset=0");
    expect(page1.status).toBe(200);
    expect(page1.body.hasMore).toBe(true);
    const page2 = await listOrganizations(operatorAToken, "?limit=1&offset=1");
    expect(page1.body.organizations[0].id).not.toBe(page2.body.organizations[0]?.id);
  });

  it("18. no sensitive or unrelated company fields are exposed — exactly id/name/createdAt", async () => {
    const res = await listOrganizations(operatorAToken, "?limit=1");
    const [org] = res.body.organizations;
    expect(Object.keys(org).sort()).toEqual(["createdAt", "id", "name"]);
    expect(JSON.stringify(res.body)).not.toMatch(/taxId|address|phone|logoPath|featureFlags|passwordHash/i);
  });
});
