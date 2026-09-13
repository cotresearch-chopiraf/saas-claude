import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { eq, and } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { platformOperators, auditEvents, users } from "../src/db/schema.js";
import { hashPassword } from "../src/lib/password.js";

// Same real-code-path-except-the-outbound-email approach as
// authorization.test.ts — this file needs a second (non-owner) tenant
// user to exercise deactivate/reactivate/revoke-sessions on someone other
// than the sole owner, and accept-invite is the only way to create one.
vi.mock("../src/lib/mailer.js", () => ({ sendMail: vi.fn() }));
import { sendMail } from "../src/lib/mailer.js";

function extractToken(mailBody: string): string {
  const match = mailBody.match(/token=([a-f0-9]{64})/);
  if (!match) throw new Error(`no token found in mail body: ${mailBody}`);
  return match[1];
}

// P0 hardening (MIDAD Final Pre-Launch, SaaS & Sale-Readiness Audit,
// Phase 5) — Platform User Management: per-organization, per-user
// visibility and support-driven status/session control. Reuses the exact
// "active"/"deactivated" userStatusEnum semantics routes/company.ts's
// tenant-owner-driven PATCH /members/:id already established, and the
// same "no company left with zero active owners" invariant.

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

async function registerCompany(name: string) {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ companyName: name, name: "Owner", email: uniqueEmail("pu-owner"), password: "password123" });
  expect(res.status).toBe(201);
  return { token: res.body.token as string, companyId: res.body.company.id as string, ownerId: res.body.user.id as string };
}

let operatorToken: string;

async function resetAndRecreateOperator() {
  await resetDb();
  const email = uniqueEmail("pu-operator");
  await db.insert(platformOperators).values({ email, name: "Operator", passwordHash: await hashPassword("operatorpass123") });
  const login = await request(app).post("/api/platform/auth/login").send({ email, password: "operatorpass123" });
  expect(login.status).toBe(200);
  operatorToken = login.body.token;
}

async function inviteAndAcceptMember(ownerToken: string) {
  const email = uniqueEmail("pu-member");
  const invite = await request(app).post("/api/company/invites").set("Authorization", `Bearer ${ownerToken}`).send({ email, role: "member" });
  expect(invite.status).toBe(201);

  const mailCall = (sendMail as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
  const inviteToken = extractToken(mailCall[2] as string);

  const accept = await request(app).post("/api/auth/accept-invite").send({ token: inviteToken, name: "Member", password: "password123" });
  expect(accept.status).toBe(201);
  return { token: accept.body.token as string, userId: accept.body.user.id as string, email };
}

describe("platform users: auth boundary", () => {
  beforeEach(resetAndRecreateOperator);

  it("unauthenticated and tenant-JWT access are both rejected on every route", async () => {
    const { token, companyId, ownerId } = await registerCompany("Co A");
    expect((await request(app).get(`/api/platform/organizations/${companyId}/users`)).status).toBe(401);
    expect((await request(app).get(`/api/platform/organizations/${companyId}/users`).set("Authorization", `Bearer ${token}`)).status).toBe(401);
    expect(
      (
        await request(app)
          .patch(`/api/platform/organizations/${companyId}/users/${ownerId}/status`)
          .set("Authorization", `Bearer ${token}`)
          .send({ status: "deactivated", reason: "x" })
      ).status,
    ).toBe(401);
  });
});

describe("platform users: list / detail visibility", () => {
  beforeEach(resetAndRecreateOperator);

  it("lists every user in the organization with role/status/email", async () => {
    const { companyId, ownerId } = await registerCompany("Co A");
    const res = await request(app).get(`/api/platform/organizations/${companyId}/users`).set("Authorization", `Bearer ${operatorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(1);
    expect(res.body.users[0]).toMatchObject({ id: ownerId, role: "owner", status: "active" });
  });

  it("detail view includes activeSessionCount", async () => {
    const { companyId, ownerId } = await registerCompany("Co A");
    const res = await request(app).get(`/api/platform/organizations/${companyId}/users/${ownerId}`).set("Authorization", `Bearer ${operatorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.activeSessionCount).toBe(1);
  });

  it("a nonexistent organization or user returns 404", async () => {
    const { companyId } = await registerCompany("Co A");
    expect((await request(app).get(`/api/platform/organizations/00000000-0000-0000-0000-000000000000/users`).set("Authorization", `Bearer ${operatorToken}`)).status).toBe(404);
    expect(
      (await request(app).get(`/api/platform/organizations/${companyId}/users/00000000-0000-0000-0000-000000000000`).set("Authorization", `Bearer ${operatorToken}`)).status,
    ).toBe(404);
  });

  it("tenant isolation: company A's user list never includes company B's users", async () => {
    const a = await registerCompany("Co A");
    const b = await registerCompany("Co B");
    const res = await request(app).get(`/api/platform/organizations/${a.companyId}/users`).set("Authorization", `Bearer ${operatorToken}`);
    const ids = res.body.users.map((u: { id: string }) => u.id);
    expect(ids).toContain(a.ownerId);
    expect(ids).not.toContain(b.ownerId);
  });
});

describe("platform users: status change", () => {
  beforeEach(resetAndRecreateOperator);

  it("deactivating a member requires a reason", async () => {
    const { token: ownerToken, companyId } = await registerCompany("Co A");
    const member = await inviteAndAcceptMember(ownerToken);
    const res = await request(app)
      .patch(`/api/platform/organizations/${companyId}/users/${member.userId}/status`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ status: "deactivated" });
    expect(res.status).toBe(400);
  });

  it("deactivates a member and blocks them on their next request", async () => {
    const { token: ownerToken, companyId } = await registerCompany("Co A");
    const member = await inviteAndAcceptMember(ownerToken);

    expect((await request(app).get("/api/auth/me").set("Authorization", `Bearer ${member.token}`)).status).toBe(200);

    const res = await request(app)
      .patch(`/api/platform/organizations/${companyId}/users/${member.userId}/status`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ status: "deactivated", reason: "Support ticket #123" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: member.userId, status: "deactivated" });

    expect((await request(app).get("/api/auth/me").set("Authorization", `Bearer ${member.token}`)).status).toBe(401);
  });

  it("reactivating does not require a reason", async () => {
    const { token: ownerToken, companyId } = await registerCompany("Co A");
    const member = await inviteAndAcceptMember(ownerToken);
    await request(app)
      .patch(`/api/platform/organizations/${companyId}/users/${member.userId}/status`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ status: "deactivated", reason: "x1234" });

    const res = await request(app)
      .patch(`/api/platform/organizations/${companyId}/users/${member.userId}/status`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ status: "active" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("active");
  });

  it("setting the same status returns 409 (no-op)", async () => {
    const { companyId, ownerId } = await registerCompany("Co A");
    const res = await request(app)
      .patch(`/api/platform/organizations/${companyId}/users/${ownerId}/status`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ status: "active" });
    expect(res.status).toBe(409);
  });

  it("cannot deactivate the last active owner, even via the platform admin surface", async () => {
    const { companyId, ownerId } = await registerCompany("Co A");
    const res = await request(app)
      .patch(`/api/platform/organizations/${companyId}/users/${ownerId}/status`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ status: "deactivated", reason: "Testing invariant" });
    expect(res.status).toBe(409);

    const user = await db.query.users.findFirst({ where: eq(users.id, ownerId) });
    expect(user!.status).toBe("active");
  });

  it("deactivating one of two active owners is allowed", async () => {
    const { token: ownerToken, companyId, ownerId } = await registerCompany("Co A");
    const secondOwner = await inviteAndAcceptMember(ownerToken);
    // Promote the invited member to owner via the existing tenant route.
    await request(app).patch(`/api/company/members/${secondOwner.userId}`).set("Authorization", `Bearer ${ownerToken}`).send({ role: "owner" });

    const res = await request(app)
      .patch(`/api/platform/organizations/${companyId}/users/${ownerId}/status`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ status: "deactivated", reason: "Testing invariant with a second owner present" });
    expect(res.status).toBe(200);
  });

  it("records an audit_events row with reason and platformOperatorId", async () => {
    const { token: ownerToken, companyId } = await registerCompany("Co A");
    const member = await inviteAndAcceptMember(ownerToken);
    await request(app)
      .patch(`/api/platform/organizations/${companyId}/users/${member.userId}/status`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ status: "deactivated", reason: "Support ticket #123" });

    const events = await db.query.auditEvents.findMany({
      where: and(eq(auditEvents.companyId, companyId), eq(auditEvents.action, "user.statusChanged")),
    });
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe("platform_admin");
    expect(events[0].reason).toBe("Support ticket #123");
    expect(events[0].entityId).toBe(member.userId);
  });
});

describe("platform users: revoke-sessions", () => {
  beforeEach(resetAndRecreateOperator);

  it("requires a reason", async () => {
    const { companyId, ownerId } = await registerCompany("Co A");
    const res = await request(app)
      .post(`/api/platform/organizations/${companyId}/users/${ownerId}/revoke-sessions`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("revokes only the target user's sessions, not the whole organization's", async () => {
    const { token: ownerToken, companyId } = await registerCompany("Co A");
    const member = await inviteAndAcceptMember(ownerToken);

    const res = await request(app)
      .post(`/api/platform/organizations/${companyId}/users/${member.userId}/revoke-sessions`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ reason: "Suspected compromised account" });
    expect(res.status).toBe(200);
    expect(res.body.revokedSessionCount).toBe(1);

    expect((await request(app).get("/api/auth/me").set("Authorization", `Bearer ${member.token}`)).status).toBe(401);
    expect((await request(app).get("/api/auth/me").set("Authorization", `Bearer ${ownerToken}`)).status).toBe(200);
  });

  it("records an audit_events row scoped to the target user", async () => {
    const { companyId, ownerId } = await registerCompany("Co A");
    await request(app)
      .post(`/api/platform/organizations/${companyId}/users/${ownerId}/revoke-sessions`)
      .set("Authorization", `Bearer ${operatorToken}`)
      .send({ reason: "Suspected compromised account" });

    const events = await db.query.auditEvents.findMany({
      where: and(eq(auditEvents.companyId, companyId), eq(auditEvents.action, "user.sessionsRevoked")),
    });
    expect(events).toHaveLength(1);
    expect(events[0].entityId).toBe(ownerId);
  });
});
