import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { platformOperators, supportSessions, auditEvents } from "../src/db/schema.js";
import { hashPassword } from "../src/lib/password.js";

// MIDAD Phase D2 — Platform Admin / Support Access. Proves the security
// boundary the Phase D2 architecture gate exists to establish: a support
// session is a server-authoritative, time-limited, revocable grant to read
// exactly ONE tenant's data, structurally unable to widen its own scope,
// structurally unable to grant any tenant-route access, and fully
// attributable to the platform operator who created it — all through the
// SAME canonical audit_events table (no second audit store).

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
async function platformLogin(email: string, password: string) {
  const res = await request(app).post("/api/platform/auth/login").send({ email, password });
  expect(res.status).toBe(200);
  return res.body.token as string;
}
function createSession(token: string, targetCompanyId: string, reason = "investigating a customer-reported bug") {
  return request(app)
    .post("/api/platform/support-sessions")
    .set("Authorization", `Bearer ${token}`)
    .send({ targetCompanyId, reason });
}
function revokeSession(token: string, sessionId: string) {
  return request(app).post(`/api/platform/support-sessions/${sessionId}/revoke`).set("Authorization", `Bearer ${token}`);
}
function readActivity(token: string, sessionId: string, qs = "") {
  return request(app)
    .get(`/api/platform/support-sessions/${sessionId}/activity${qs}`)
    .set("Authorization", `Bearer ${token}`);
}
function listSessions(token: string, qs = "") {
  return request(app).get(`/api/platform/support-sessions${qs}`).set("Authorization", `Bearer ${token}`);
}

let ownerAToken: string;
let companyAId: string;
let ownerBToken: string;
let companyBId: string;
let operatorAToken: string;
let operatorAEmail: string;
let operatorAPassword: string;
let operatorBToken: string;

beforeAll(async () => {
  await resetDb();

  const ownerARes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Support Test Co A", name: "Owner A", email: uniqueEmail("support-owner-a"), password: "password123" });
  expect(ownerARes.status).toBe(201);
  ownerAToken = ownerARes.body.token;
  companyAId = ownerARes.body.company.id;

  const ownerBRes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Support Test Co B", name: "Owner B", email: uniqueEmail("support-owner-b"), password: "password123" });
  expect(ownerBRes.status).toBe(201);
  ownerBToken = ownerBRes.body.token;
  companyBId = ownerBRes.body.company.id;

  // Real audit_events rows in each company, via existing unmodified writers.
  const custA = await request(app).post("/api/customers").set("Authorization", `Bearer ${ownerAToken}`).send({ name: "عميل شركة أ" });
  expect(custA.status).toBe(201);
  const custB = await request(app).post("/api/customers").set("Authorization", `Bearer ${ownerBToken}`).send({ name: "عميل شركة ب" });
  expect(custB.status).toBe(201);

  operatorAEmail = uniqueEmail("support-operator-a");
  operatorAPassword = "operatorpass123";
  await createOperator(operatorAEmail, operatorAPassword);
  operatorAToken = await platformLogin(operatorAEmail, operatorAPassword);

  const operatorBEmail = uniqueEmail("support-operator-b");
  await createOperator(operatorBEmail, "operatorpass456");
  operatorBToken = await platformLogin(operatorBEmail, "operatorpass456");
});

describe("granting a support session", () => {
  it("1. a platform operator can grant a session scoped to exactly one real company", async () => {
    const res = await createSession(operatorAToken, companyAId);
    expect(res.status).toBe(201);
    expect(res.body.targetCompanyId).toBe(companyAId);
    expect(res.body.expiresAt).toBeTruthy();
  });

  it("2. granting a session for a nonexistent company is rejected", async () => {
    const res = await createSession(operatorAToken, "00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });

  it("3. a session requires a stated reason", async () => {
    const res = await request(app)
      .post("/api/platform/support-sessions")
      .set("Authorization", `Bearer ${operatorAToken}`)
      .send({ targetCompanyId: companyAId, reason: "x" });
    expect(res.status).toBe(400);
  });

  it("4. a tenant JWT cannot grant a support session", async () => {
    const res = await createSession(ownerAToken, companyAId);
    expect(res.status).toBe(401);
  });

  it("5. granting a session writes a supportSession.granted audit event attributable to the operator, not a fabricated tenant actor", async () => {
    const created = await createSession(operatorAToken, companyAId);
    const events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, created.body.id) });
    const granted = events.find((e) => e.action === "supportSession.granted");
    expect(granted).toBeTruthy();
    expect(granted!.companyId).toBe(companyAId);
    expect(granted!.actorUserId).toBeNull();
    expect((granted!.metadata as { platformOperatorId: string }).platformOperatorId).toBeTruthy();
    expect(granted!.source).toBe("platform_admin");
  });
});

describe("reading tenant data through a support session", () => {
  it("6. an active session for company A returns only company A's real activity events", async () => {
    const session = await createSession(operatorAToken, companyAId);
    const res = await readActivity(operatorAToken, session.body.id);
    expect(res.status).toBe(200);
    expect(res.body.events.length).toBeGreaterThan(0);
    expect(res.body.events.some((e: { action: string }) => e.action === "customer.created")).toBe(true);
  });

  it("7. Test: a session for company A cannot return company B's data, even by supplying company B's id as a query param", async () => {
    const session = await createSession(operatorAToken, companyAId);
    const res = await readActivity(operatorAToken, session.body.id, `?companyId=${companyBId}`);
    expect(res.status).toBe(200);
    // Every event's entityId must trace back to something created under
    // company A's own token, never company B's — proven structurally by
    // re-deriving from the same real audit_events rows the setup created.
    const companyBEvents = await db.query.auditEvents.findMany({ where: eq(auditEvents.companyId, companyBId) });
    const leaked = res.body.events.some((e: { id: string }) => companyBEvents.some((b) => b.id === e.id));
    expect(leaked).toBe(false);
  });

  it("8. a platform operator without any support session cannot read tenant data", async () => {
    const res = await readActivity(operatorAToken, "00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });

  it("9. one operator cannot use another operator's support session", async () => {
    const session = await createSession(operatorAToken, companyAId);
    const res = await readActivity(operatorBToken, session.body.id);
    expect(res.status).toBe(404);
  });

  it("10. an expired support session is rejected", async () => {
    const session = await createSession(operatorAToken, companyAId);
    await db.update(supportSessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(supportSessions.id, session.body.id));
    const res = await readActivity(operatorAToken, session.body.id);
    expect(res.status).toBe(403);
  });
});

describe("revocation", () => {
  it("11. an operator can revoke their own session, and it is immediately unusable", async () => {
    const session = await createSession(operatorAToken, companyAId);
    const revoke = await revokeSession(operatorAToken, session.body.id);
    expect(revoke.status).toBe(200);

    const res = await readActivity(operatorAToken, session.body.id);
    expect(res.status).toBe(403);
  });

  it("12. revoking an already-revoked session is rejected, not silently repeated", async () => {
    const session = await createSession(operatorAToken, companyAId);
    const first = await revokeSession(operatorAToken, session.body.id);
    expect(first.status).toBe(200);
    const second = await revokeSession(operatorAToken, session.body.id);
    expect(second.status).toBe(409);
  });

  it("13. a different operator cannot revoke another operator's session", async () => {
    const session = await createSession(operatorAToken, companyAId);
    const res = await revokeSession(operatorBToken, session.body.id);
    expect(res.status).toBe(404);
  });

  it("14. revocation writes a supportSession.revoked audit event", async () => {
    const session = await createSession(operatorAToken, companyAId);
    await revokeSession(operatorAToken, session.body.id);
    const events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, session.body.id) });
    expect(events.some((e) => e.action === "supportSession.revoked")).toBe(true);
  });

  it("15. concurrent revoke attempts on the same session never double-apply: exactly one 200, exactly one supportSession.revoked event", async () => {
    const session = await createSession(operatorAToken, companyAId);
    const [r1, r2] = await Promise.all([revokeSession(operatorAToken, session.body.id), revokeSession(operatorAToken, session.body.id)]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);

    const events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, session.body.id) });
    expect(events.filter((e) => e.action === "supportSession.revoked")).toHaveLength(1);
  });
});

describe("scope isolation: a support session grants no tenant-route access", () => {
  it("16. a platform JWT cannot access a tenant route, even while holding an active support session", async () => {
    await createSession(operatorAToken, companyAId);
    const res = await request(app).get("/api/customers").set("Authorization", `Bearer ${operatorAToken}`);
    expect(res.status).toBe(401);
  });

  it("17. a support session cannot be used to mutate tenant data (no mutation route exists; a tenant write route rejects the platform JWT outright)", async () => {
    await createSession(operatorAToken, companyAId);
    const res = await request(app)
      .post("/api/customers")
      .set("Authorization", `Bearer ${operatorAToken}`)
      .send({ name: "should never be created" });
    expect(res.status).toBe(401);
  });

  it("18. an unauthenticated request to any support-session route is rejected", async () => {
    const res = await request(app).get(`/api/platform/support-sessions/00000000-0000-0000-0000-000000000000/activity`);
    expect(res.status).toBe(401);
  });
});

describe("operator deactivation revokes access immediately", () => {
  it("19. a deactivated operator's active support session becomes unreachable on the very next request", async () => {
    const email = uniqueEmail("support-operator-revoke");
    const operator = await createOperator(email, "operatorpass789");
    const token = await platformLogin(email, "operatorpass789");
    const session = await createSession(token, companyAId);

    const before = await readActivity(token, session.body.id);
    expect(before.status).toBe(200);

    await db.update(platformOperators).set({ status: "deactivated" }).where(eq(platformOperators.id, operator.id));

    const after = await readActivity(token, session.body.id);
    expect(after.status).toBe(401);
  });

  it("20. tenant users remain completely unaffected by all of the above", async () => {
    const res = await request(app).get("/api/customers").set("Authorization", `Bearer ${ownerAToken}`);
    expect(res.status).toBe(200);
  });
});

describe("listing my sessions", () => {
  it("21. an operator's list includes only their own sessions, never another operator's", async () => {
    const mine = await createSession(operatorAToken, companyAId, "operator A's own session");
    const theirs = await createSession(operatorBToken, companyBId, "operator B's own session");

    const resA = await listSessions(operatorAToken, "?limit=100");
    expect(resA.status).toBe(200);
    const idsA = resA.body.sessions.map((s: { id: string }) => s.id);
    expect(idsA).toContain(mine.body.id);
    expect(idsA).not.toContain(theirs.body.id);

    const resB = await listSessions(operatorBToken, "?limit=100");
    const idsB = resB.body.sessions.map((s: { id: string }) => s.id);
    expect(idsB).toContain(theirs.body.id);
    expect(idsB).not.toContain(mine.body.id);
  });

  it("22. unsupported operator-id-shaped query parameters cannot widen scope", async () => {
    const mine = await createSession(operatorAToken, companyAId);
    const theirs = await createSession(operatorBToken, companyBId);

    const res = await listSessions(operatorAToken, `?platformOperatorId=${theirs.body.id}&operatorId=all&companyId=${companyBId}`);
    expect(res.status).toBe(200);
    const ids = res.body.sessions.map((s: { id: string }) => s.id);
    expect(ids).toContain(mine.body.id);
    expect(ids).not.toContain(theirs.body.id);
  });

  it("23. unauthenticated request is rejected", async () => {
    const res = await request(app).get("/api/platform/support-sessions");
    expect(res.status).toBe(401);
  });

  it("24. a tenant JWT is rejected", async () => {
    const res = await listSessions(ownerAToken);
    expect(res.status).toBe(401);
  });

  it("25. an active session is classified correctly", async () => {
    const created = await createSession(operatorAToken, companyAId);
    const res = await listSessions(operatorAToken, "?limit=100");
    const row = res.body.sessions.find((s: { id: string }) => s.id === created.body.id);
    expect(row.status).toBe("active");
    expect(row.revokedAt).toBeNull();
  });

  it("26. an expired session is classified correctly", async () => {
    const created = await createSession(operatorAToken, companyAId);
    await db.update(supportSessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(supportSessions.id, created.body.id));
    const res = await listSessions(operatorAToken, "?limit=100");
    const row = res.body.sessions.find((s: { id: string }) => s.id === created.body.id);
    expect(row.status).toBe("expired");
  });

  it("27. a revoked session is classified correctly", async () => {
    const created = await createSession(operatorAToken, companyAId);
    await revokeSession(operatorAToken, created.body.id);
    const res = await listSessions(operatorAToken, "?limit=100");
    const row = res.body.sessions.find((s: { id: string }) => s.id === created.body.id);
    expect(row.status).toBe("revoked");
    expect(row.revokedAt).toBeTruthy();
  });

  it("28. pagination and hasMore work correctly", async () => {
    await createSession(operatorAToken, companyAId, "session for pagination one");
    await createSession(operatorAToken, companyAId, "session for pagination two");

    const page1 = await listSessions(operatorAToken, "?limit=1&offset=0");
    expect(page1.status).toBe(200);
    expect(page1.body.sessions).toHaveLength(1);
    expect(page1.body.hasMore).toBe(true);

    const full = await listSessions(operatorAToken, "?limit=100");
    const lastPage = await listSessions(operatorAToken, `?limit=100&offset=${full.body.sessions.length}`);
    expect(lastPage.body.sessions).toEqual([]);
    expect(lastPage.body.hasMore).toBe(false);
  });

  it("29. the target organization's real name is returned safely", async () => {
    const created = await createSession(operatorAToken, companyAId);
    const res = await listSessions(operatorAToken, "?limit=100");
    const row = res.body.sessions.find((s: { id: string }) => s.id === created.body.id);
    expect(row.targetCompanyName).toBe("Support Test Co A");
  });

  it("30. the response field allowlist stays minimal — no unrelated company fields leak through", async () => {
    await createSession(operatorAToken, companyAId);
    const res = await listSessions(operatorAToken, "?limit=1");
    const [row] = res.body.sessions;
    expect(Object.keys(row).sort()).toEqual(
      ["createdAt", "expiresAt", "id", "reason", "revokedAt", "status", "targetCompanyId", "targetCompanyName"].sort(),
    );
    expect(JSON.stringify(res.body)).not.toMatch(/taxId|address|phone|logoPath|featureFlags|passwordHash|platformOperatorId/i);
  });

  it("31. an operator with no sessions gets an honest empty list", async () => {
    const email = uniqueEmail("support-operator-empty");
    await createOperator(email, "operatorpass000");
    const token = await platformLogin(email, "operatorpass000");
    const res = await listSessions(token);
    expect(res.status).toBe(200);
    expect(res.body.sessions).toEqual([]);
    expect(res.body.hasMore).toBe(false);
  });
});
