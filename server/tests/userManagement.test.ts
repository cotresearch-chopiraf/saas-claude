import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { auditEvents } from "../src/db/schema.js";

// MIDAD Phase A — User Account Completeness. Exercises PATCH /api/company/members/:id
// (role change / deactivate / reactivate), the last-active-owner safety invariant, and
// — the central architectural change of this phase — proves that requireAuth itself now
// rejects a deactivated user's still-valid, unexpired JWT on their very next request.
//
// authRateLimit (10 req/15min/IP) covers every /api/auth/* route including accept-invite,
// so — same discipline as every other test file in this suite — account creation is kept
// to a small, deliberately reused pool built once in beforeAll instead of one account per
// test. Tests that only ever read or get rejected (403/404/409) safely share an account
// without entangling each other; tests that mutate an account's role/status are ordered so
// each one's precondition is the previous one's known postcondition.

vi.mock("../src/lib/mailer.js", () => ({ sendMail: vi.fn() }));
import { sendMail } from "../src/lib/mailer.js";

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

async function inviteAndAccept(ownerToken: string, role: "owner" | "member", prefix: string) {
  const email = uniqueEmail(prefix);
  const inviteRes = await request(app)
    .post("/api/company/invites")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ email, role });
  expect(inviteRes.status).toBe(201);
  const mailCall = (sendMail as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
  const inviteToken = (mailCall[2] as string).match(/token=([a-f0-9]{40,80})/)![1];
  const acceptRes = await request(app)
    .post("/api/auth/accept-invite")
    .send({ token: inviteToken, name: prefix, password: "memberpass123" });
  expect(acceptRes.status).toBe(201);
  return { token: acceptRes.body.token as string, userId: acceptRes.body.user.id as string };
}

function listMembers(token: string) {
  return request(app).get("/api/company/members").set("Authorization", `Bearer ${token}`);
}
function patchMember(id: string, body: Record<string, unknown>, token: string) {
  return request(app).patch(`/api/company/members/${id}`).set("Authorization", `Bearer ${token}`).send(body);
}

let ownerToken: string;
let ownerId: string;
let companyBToken: string;

// Reused pool, all in the same (owner's) company:
let memberAId: string; // round-tripped: member -> owner -> member (role-change + audit)
let memberBToken: string;
let memberBId: string; // deactivate -> reactivate -> deactivate lifecycle (status-change + enforcement)
let memberCToken: string;
let memberCId: string; // never mutated — reused for RBAC/tenant-isolation negative checks

let soloOwnerToken: string;
let soloOwnerId: string; // sole owner of its own company — last-active-owner guard target

let secondOwnerId: string; // twoOwnerCo — deactivatable because another active owner remains
let twoOwnerPrimaryToken: string;

beforeAll(async () => {
  await resetDb();

  const ownerRes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "User Mgmt Test Co", name: "Owner", email: uniqueEmail("um-owner"), password: "password123" });
  expect(ownerRes.status).toBe(201);
  ownerToken = ownerRes.body.token;
  ownerId = ownerRes.body.user.id;

  const companyBRes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Other Co", name: "Owner B", email: uniqueEmail("um-other"), password: "password123" });
  expect(companyBRes.status).toBe(201);
  companyBToken = companyBRes.body.token;

  ({ userId: memberAId } = await inviteAndAccept(ownerToken, "member", "um-a"));
  ({ token: memberBToken, userId: memberBId } = await inviteAndAccept(ownerToken, "member", "um-b"));
  ({ token: memberCToken, userId: memberCId } = await inviteAndAccept(ownerToken, "member", "um-c"));

  const soloRes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Solo Owner Co", name: "Solo Owner", email: uniqueEmail("um-solo"), password: "password123" });
  expect(soloRes.status).toBe(201);
  soloOwnerToken = soloRes.body.token;
  soloOwnerId = soloRes.body.user.id;

  const twoOwnerRes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Two Owner Co", name: "Owner X", email: uniqueEmail("um-two"), password: "password123" });
  expect(twoOwnerRes.status).toBe(201);
  twoOwnerPrimaryToken = twoOwnerRes.body.token;
  ({ userId: secondOwnerId } = await inviteAndAccept(twoOwnerPrimaryToken, "owner", "um-two2"));
});

describe("User Account Completeness (Phase A)", () => {
  it("1. GET /members includes status for every member", async () => {
    const res = await listMembers(ownerToken);
    expect(res.status).toBe(200);
    expect(res.body.find((m: { id: string }) => m.id === ownerId).status).toBe("active");
    expect(res.body.find((m: { id: string }) => m.id === memberAId).status).toBe("active");
  });

  it("2. an owner can change a member's role to owner", async () => {
    const res = await patchMember(memberAId, { role: "owner" }, ownerToken);
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("owner");
  });

  it("3. an owner can change that member's role back to member (another active owner remains)", async () => {
    const res = await patchMember(memberAId, { role: "member" }, ownerToken);
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("member");
  });

  it("4. role change is audited with before/after values for both directions", async () => {
    const events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, memberAId) });
    const roleEvents = events.filter((e) => e.action === "user.roleChanged");
    expect(roleEvents.some((e) => JSON.stringify(e.beforeValue) === '{"role":"member"}' && JSON.stringify(e.afterValue) === '{"role":"owner"}')).toBe(true);
    expect(roleEvents.some((e) => JSON.stringify(e.beforeValue) === '{"role":"owner"}' && JSON.stringify(e.afterValue) === '{"role":"member"}')).toBe(true);
  });

  it("5. an owner can deactivate a member", async () => {
    const res = await patchMember(memberBId, { status: "deactivated" }, ownerToken);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("deactivated");
  });

  it("6. a deactivated member's existing, still-valid JWT is rejected with 401 on their very next request", async () => {
    const res = await request(app).get("/api/company/members").set("Authorization", `Bearer ${memberBToken}`);
    expect(res.status).toBe(401);
  });

  it("7. deactivating one member does not affect another member's session in the same company", async () => {
    const bystanderRes = await request(app).get("/api/company/members").set("Authorization", `Bearer ${memberCToken}`);
    expect(bystanderRes.status).toBe(200);
    const ownerRes = await request(app).get("/api/company/members").set("Authorization", `Bearer ${ownerToken}`);
    expect(ownerRes.status).toBe(200);
  });

  it("8. an owner can reactivate a deactivated member", async () => {
    const res = await patchMember(memberBId, { status: "active" }, ownerToken);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("active");
  });

  it("9. reactivation restores access for the SAME still-valid JWT (no re-login required)", async () => {
    const res = await request(app).get("/api/company/members").set("Authorization", `Bearer ${memberBToken}`);
    expect(res.status).toBe(200);
  });

  it("10. status change is audited with before/after values for both directions", async () => {
    const events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, memberBId) });
    const statusEvents = events.filter((e) => e.action === "user.statusChanged");
    expect(statusEvents.some((e) => JSON.stringify(e.beforeValue) === '{"status":"active"}' && JSON.stringify(e.afterValue) === '{"status":"deactivated"}')).toBe(true);
    expect(statusEvents.some((e) => JSON.stringify(e.beforeValue) === '{"status":"deactivated"}' && JSON.stringify(e.afterValue) === '{"status":"active"}')).toBe(true);
  });

  it("11. last-active-owner guard: cannot demote the sole active owner to member", async () => {
    const res = await patchMember(soloOwnerId, { role: "member" }, soloOwnerToken);
    expect(res.status).toBe(409);
  });

  it("12. last-active-owner guard: cannot deactivate the sole active owner", async () => {
    const res = await patchMember(soloOwnerId, { status: "deactivated" }, soloOwnerToken);
    expect(res.status).toBe(409);
  });

  it("13. the sole owner's account was never actually changed by the rejected attempts", async () => {
    const res = await listMembers(soloOwnerToken);
    const self = res.body.find((m: { id: string }) => m.id === soloOwnerId);
    expect(self.role).toBe("owner");
    expect(self.status).toBe("active");
  });

  it("14. last-active-owner guard does NOT block deactivating an owner when another active owner remains", async () => {
    const res = await patchMember(secondOwnerId, { status: "deactivated" }, twoOwnerPrimaryToken);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("deactivated");
  });

  it("15. a member cannot change anyone's role or status (owner-only)", async () => {
    const res = await patchMember(memberAId, { role: "owner" }, memberCToken);
    expect(res.status).toBe(403);
  });

  it("16. a member cannot escalate their own role via direct API call", async () => {
    const res = await patchMember(memberCId, { role: "owner" }, memberCToken);
    expect(res.status).toBe(403);
  });

  it("17. tenant isolation: a foreign company cannot PATCH this company's member", async () => {
    const res = await patchMember(memberCId, { role: "owner" }, companyBToken);
    expect(res.status).toBe(404);
  });

  it("18. a nonexistent member id returns 404", async () => {
    const res = await patchMember("00000000-0000-0000-0000-000000000000", { role: "owner" }, ownerToken);
    expect(res.status).toBe(404);
  });

  it("19. PATCH with no fields returns the member unchanged (no-op)", async () => {
    const res = await patchMember(memberCId, {}, ownerToken);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("active");
    expect(res.body.role).toBe("member");
  });

  it("20. an invalid role/status value is rejected with 400", async () => {
    const res = await patchMember(memberCId, { role: "superadmin" }, ownerToken);
    expect(res.status).toBe(400);
  });

  it("21. registration still issues an owner account normally (no regression from the requireAuth/status change)", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "Regression Co", name: "Reg Owner", email: uniqueEmail("um-reg"), password: "password123" });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBeUndefined(); // register's response shape is unchanged — no role/status leak into it
    const meRes = await request(app).get("/api/company/members").set("Authorization", `Bearer ${res.body.token}`);
    expect(meRes.status).toBe(200);
    expect(meRes.body[0].role).toBe("owner");
    expect(meRes.body[0].status).toBe("active");
  });
});
