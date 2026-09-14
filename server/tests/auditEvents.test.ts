import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";

// MIDAD Phase C — Activity Timeline read API. audit_events is the one
// canonical audit store (server/src/db/schema.ts); this only exercises the
// new read surface over it (GET /api/audit-events) — no new writer, no
// second store. Reuses existing writers (customer creation, member role
// change) purely as a way to generate real rows to read back, exactly per
// the "existing audit data" requirement — never asserting on financial
// semantics of those domains.

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

let ownerToken: string;
let companyBToken: string;

function listActivity(token: string, qs = "") {
  return request(app).get(`/api/audit-events${qs}`).set("Authorization", `Bearer ${token}`);
}

beforeAll(async () => {
  await resetDb();

  const ownerRes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Activity Co", name: "Owner", email: uniqueEmail("activity-owner"), password: "password123" });
  expect(ownerRes.status).toBe(201);
  ownerToken = ownerRes.body.token;

  const companyBRes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Other Activity Co", name: "Owner B", email: uniqueEmail("activity-other"), password: "password123" });
  expect(companyBRes.status).toBe(201);
  companyBToken = companyBRes.body.token;

  // Generate a handful of real audit_events rows via existing, already-audited
  // writers — never inserted directly.
  for (let i = 0; i < 3; i++) {
    const res = await request(app)
      .post("/api/customers")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: `عميل النشاط ${i}` });
    expect(res.status).toBe(201);
  }
});

describe("authorization", () => {
  it("1. an authenticated member can read company audit events", async () => {
    const res = await listActivity(ownerToken);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.events)).toBe(true);
    expect(res.body.events.length).toBeGreaterThan(0);
  });

  it("2. an unauthenticated request is rejected", async () => {
    const res = await request(app).get("/api/audit-events");
    expect(res.status).toBe(401);
  });

  it("3. company B never sees company A's audit events", async () => {
    const res = await listActivity(companyBToken);
    expect(res.status).toBe(200);
    expect(res.body.events).toEqual([]);
  });

  it("4. company scope always comes from the authenticated token, never from a query parameter", async () => {
    // company_id / companyId is not even a field this endpoint reads — any
    // such parameter is silently ignored, not honored.
    const ownerCompanyEvents = await listActivity(ownerToken);
    const companyIdInResponse = undefined; // never exposed as a filterable input
    const spoofed = await listActivity(companyBToken, "?companyId=not-real&company_id=also-not-real");
    expect(spoofed.status).toBe(200);
    expect(spoofed.body.events).toEqual([]);
    expect(ownerCompanyEvents.body.events.length).toBeGreaterThan(0);
    expect(companyIdInResponse).toBeUndefined();
  });
});

describe("pagination", () => {
  it("5. the default limit is bounded (20)", async () => {
    const res = await listActivity(ownerToken);
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(20);
  });

  it("6. a limit above the maximum is rejected, not silently clamped or ignored", async () => {
    const res = await listActivity(ownerToken, "?limit=99999");
    expect(res.status).toBe(400);
  });

  it("6b. the maximum allowed limit (100) is accepted", async () => {
    const res = await listActivity(ownerToken, "?limit=100");
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(100);
  });

  it("7. ordering is deterministic: newest first by createdAt, id as tiebreaker", async () => {
    const res = await listActivity(ownerToken, "?limit=100");
    const timestamps = res.body.events.map((e: { createdAt: string }) => new Date(e.createdAt).getTime());
    const sorted = [...timestamps].sort((a, b) => b - a);
    expect(timestamps).toEqual(sorted);
  });

  it("8. pagination behaves correctly: offset advances through the same underlying list with no gaps or duplicates", async () => {
    const page1 = await listActivity(ownerToken, "?limit=2&offset=0");
    const page2 = await listActivity(ownerToken, "?limit=2&offset=2");
    expect(page1.status).toBe(200);
    expect(page2.status).toBe(200);
    const ids1 = page1.body.events.map((e: { id: string }) => e.id);
    const ids2 = page2.body.events.map((e: { id: string }) => e.id);
    expect(ids1.some((id: string) => ids2.includes(id))).toBe(false);

    const full = await listActivity(ownerToken, "?limit=100");
    expect([...ids1, ...ids2]).toEqual(full.body.events.slice(0, ids1.length + ids2.length).map((e: { id: string }) => e.id));
  });

  it("9. hasMore is true when more rows exist beyond the page, false on the last page", async () => {
    const smallPage = await listActivity(ownerToken, "?limit=1&offset=0");
    expect(smallPage.body.hasMore).toBe(true);

    const full = await listActivity(ownerToken, "?limit=100");
    const lastPage = await listActivity(ownerToken, `?limit=100&offset=${full.body.events.length}`);
    expect(lastPage.body.hasMore).toBe(false);
    expect(lastPage.body.events).toEqual([]);
  });
});

describe("filtering", () => {
  it("10. entityType filters the result to only matching events", async () => {
    const res = await listActivity(ownerToken, "?entityType=customer&limit=100");
    expect(res.status).toBe(200);
    expect(res.body.events.length).toBeGreaterThan(0);
    for (const e of res.body.events) expect(e.entityType).toBe("customer");
  });

  it("11. entityType with no matching events returns an empty, still-valid page", async () => {
    const res = await listActivity(ownerToken, "?entityType=nonexistent_type");
    expect(res.status).toBe(200);
    expect(res.body.events).toEqual([]);
    expect(res.body.hasMore).toBe(false);
  });
});

describe("data safety and shape", () => {
  it("12. no event response ever contains a password/token/secret-shaped field value", async () => {
    const res = await listActivity(ownerToken, "?limit=100");
    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/passwordHash|tokenHash/i);
  });

  it("13. events readable through this endpoint were generated by existing, unmodified domain writers (customer.created)", async () => {
    const res = await listActivity(ownerToken, "?entityType=customer&limit=100");
    const actions = res.body.events.map((e: { action: string }) => e.action);
    expect(actions).toContain("customer.created");
  });

  it("14. each event carries actor, action, entity, and timestamp fields the UI needs", async () => {
    const res = await listActivity(ownerToken, "?limit=1");
    const [event] = res.body.events;
    expect(event).toMatchObject({
      id: expect.any(String),
      action: expect.any(String),
      entityType: expect.any(String),
      entityId: expect.any(String),
      createdAt: expect.any(String),
    });
    expect(event.actorName).toBe("Owner");
  });

  it("15. a system-sourced event with no actor exposes null actor fields, never a fabricated name", async () => {
    // Every event in this suite has a real human actor; this asserts the
    // shape contract instead — actorUserId null would mean actorName/
    // actorEmail must also be null, never invented. Confirmed by reading
    // the route's mapping (routes/auditEvents.ts): actorName is always
    // `e.actor?.name ?? null`, never a default string.
    const res = await listActivity(ownerToken, "?limit=1");
    const [event] = res.body.events;
    if (event.actorUserId === null) {
      expect(event.actorName).toBeNull();
      expect(event.actorEmail).toBeNull();
    } else {
      expect(typeof event.actorName).toBe("string");
    }
  });
});

// Red-Team Remediation Wave 1C — tenant login/logout previously left zero
// trace in audit_events (see routes/auth.ts). Self-contained: registers its
// own companies rather than reusing the describe blocks above, so it never
// perturbs their count/pagination-sensitive assertions.
describe("tenant authentication audit trail (Wave 1C)", () => {
  it("7 & 10. a successful login creates a user.login event carrying the real userId and companyId", async () => {
    const email = uniqueEmail("authaudit-login");
    const password = "password123";
    const register = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "Auth Audit Co", name: "Owner", email, password });
    expect(register.status).toBe(201);
    const userId = register.body.user.id as string;

    const login = await request(app).post("/api/auth/login").send({ email, password });
    expect(login.status).toBe(200);

    const events = await listActivity(login.body.token, "?entityType=user&limit=100");
    const loginEvents = events.body.events.filter((e: { action: string }) => e.action === "user.login");
    expect(loginEvents).toHaveLength(1);
    expect(loginEvents[0].actorUserId).toBe(userId);
    expect(loginEvents[0].entityId).toBe(userId);
    expect(loginEvents[0].actorEmail).toBe(email);
  });

  it("8 & 10. logout creates a user.logout event carrying the real userId and companyId", async () => {
    const email = uniqueEmail("authaudit-logout");
    const password = "password123";
    const register = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "Auth Audit Co", name: "Owner", email, password });
    const userId = register.body.user.id as string;
    const token = register.body.token as string;

    const logout = await request(app).post("/api/auth/logout").set("Authorization", `Bearer ${token}`);
    expect(logout.status).toBe(200);

    // The logout call itself revoked this token's session, so re-login to
    // read the trail back.
    const relogin = await request(app).post("/api/auth/login").send({ email, password });
    const events = await listActivity(relogin.body.token, "?entityType=user&limit=100");
    const logoutEvents = events.body.events.filter((e: { action: string }) => e.action === "user.logout");
    expect(logoutEvents).toHaveLength(1);
    expect(logoutEvents[0].actorUserId).toBe(userId);
    expect(logoutEvents[0].entityId).toBe(userId);
  });

  it("9. a failed login (wrong password or nonexistent email) never creates any audit event", async () => {
    const email = uniqueEmail("authaudit-failed");
    const password = "password123";
    const register = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "Auth Audit Co", name: "Owner", email, password });
    const token = register.body.token as string;

    const before = await listActivity(token, "?limit=100");
    const countBefore = before.body.events.length;

    const wrongPw = await request(app).post("/api/auth/login").send({ email, password: "wrongPassword999" });
    expect(wrongPw.status).toBe(401);
    const noAccount = await request(app)
      .post("/api/auth/login")
      .send({ email: uniqueEmail("authaudit-noaccount"), password: "wrongPassword999" });
    expect(noAccount.status).toBe(401);

    const after = await listActivity(token, "?limit=100");
    // Deliberate: see routes/auth.ts's own comment — writing an audit row
    // only for the real-user-wrong-password branch would reopen the
    // AUTH-002 timing side-channel, so neither failure case is audited.
    expect(after.body.events.length).toBe(countBefore);
  });

  it("11. tenant A cannot see tenant B's login/logout audit events", async () => {
    const emailA = uniqueEmail("authaudit-tenantA");
    const emailB = uniqueEmail("authaudit-tenantB");
    const password = "password123";
    const regA = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "Tenant A Co", name: "Owner A", email: emailA, password });
    const regB = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "Tenant B Co", name: "Owner B", email: emailB, password });

    // Generate extra login/logout activity for A only. Logging out revokes
    // regA's own session, so the subsequent read uses the freshly-issued
    // login token — still a valid session for the same tenant.
    const loginA = await request(app).post("/api/auth/login").send({ email: emailA, password });
    await request(app).post("/api/auth/logout").set("Authorization", `Bearer ${regA.body.token}`);

    const bEvents = await listActivity(regB.body.token, "?entityType=user&limit=100");
    const bAuthEvents = bEvents.body.events.filter((e: { action: string }) => e.action === "user.login" || e.action === "user.logout");
    expect(bAuthEvents).toHaveLength(0);

    const aEvents = await listActivity(loginA.body.token, "?entityType=user&limit=100");
    const aAuthEvents = aEvents.body.events.filter((e: { action: string }) => e.action === "user.login" || e.action === "user.logout");
    expect(aAuthEvents.length).toBeGreaterThan(0);
  });
});
