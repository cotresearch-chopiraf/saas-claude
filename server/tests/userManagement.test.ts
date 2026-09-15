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

// Red-Team Remediation Wave 1E (W1E-001) — the last-active-owner invariant
// (test 11/12 above) was previously enforced by a plain read taken BEFORE
// the transaction opened, with an unconditional UPDATE inside it. Two
// owners in a 2-owner company could each demote the OTHER at the same
// time: both requests' pre-transaction reads see the other owner as still
// active, both pass, and both commit, leaving zero active owners (an
// unrecoverable state through this API). This test proves the fix (a FOR
// UPDATE-locked re-check of the whole active-owner set inside the
// transaction) actually closes that race under genuine concurrent
// execution — each request authenticates as its OWN owner and targets the
// other, so neither request's own permission check is entangled with the
// other's outcome (unlike a self-demotion scenario, where the loser's
// requirePermission re-check could itself flip to 403 depending on
// commit-order timing — this design keeps the assertion deterministic).
describe("User Account Completeness (Phase A): last-owner concurrency (Wave 1E fix)", () => {
  it("two owners concurrently demoting each other: exactly one succeeds, at least one owner remains, no partial state", async () => {
    const ownerRes = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "Race Co", name: "Owner Race A", email: uniqueEmail("um-race-a"), password: "password123" });
    expect(ownerRes.status).toBe(201);
    const ownerAToken = ownerRes.body.token as string;
    const ownerAId = ownerRes.body.user.id as string;

    const { token: ownerBToken, userId: ownerBId } = await inviteAndAccept(ownerAToken, "owner", "um-race-b");

    // A demotes B (authenticated as A) and B demotes A (authenticated as
    // B) — fired concurrently via Promise.all, not sequentially.
    const [aDemotesB, bDemotesA] = await Promise.all([
      patchMember(ownerBId, { role: "member" }, ownerAToken),
      patchMember(ownerAId, { role: "member" }, ownerBToken),
    ]);

    // Exactly one of the two competing requests succeeds. The loser's
    // status code depends on exactly when its own requirePermission check
    // runs relative to the winner's commit: if the winner has already
    // committed by then, the loser (whose own role the winner just
    // changed) is rejected at the permission gate itself (403) rather than
    // reaching the invariant check (409) — both are correct "did not
    // silently succeed" outcomes for this same underlying race; only the
    // "exactly one success, and the company still has an owner" invariant
    // below is what this test is actually proving.
    const statuses = [aDemotesB.status, bDemotesA.status];
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409 || s === 403)).toHaveLength(1);

    const members = await listMembers(ownerAToken);
    expect(members.status).toBe(200);
    const activeOwners = members.body.filter((m: { role: string; status: string }) => m.role === "owner" && m.status === "active");
    // At least one active owner remains — never zero.
    expect(activeOwners.length).toBeGreaterThanOrEqual(1);

    // No partially-applied state: the winning demotion actually took
    // effect (exactly one of A/B is now "member"), and the loser is
    // completely unchanged from its pre-race state (still "owner") — never
    // left in some intermediate state by the rolled-back transaction.
    const aRow = members.body.find((m: { id: string }) => m.id === ownerAId);
    const bRow = members.body.find((m: { id: string }) => m.id === ownerBId);
    const roles = [aRow.role, bRow.role].sort();
    expect(roles).toEqual(["member", "owner"]);
  });
});

// 18-phase internal remediation, Phase 9 — company settings/logo/invite
// management previously had zero audit trail, unlike the PATCH
// /members/:id route above (already covered by "user.roleChanged"/
// "user.statusChanged" events elsewhere in this file). Own company/owner
// so these don't interact with the deliberately-ordered owner tests above.
describe("Company settings/logo/invite audit logging (18-phase internal remediation)", () => {
  it("PATCH /settings records a company.settingsUpdated audit event with before/after values", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "Audit Settings Co", name: "Owner", email: uniqueEmail("audit-settings-owner"), password: "password123" });
    const token = res.body.token as string;
    const companyId = res.body.company.id as string;

    const patchRes = await request(app)
      .patch("/api/company/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Audit Settings Co Renamed", defaultTaxRatePercent: 15 });
    expect(patchRes.status).toBe(200);

    const events = await db.query.auditEvents.findMany({
      where: eq(auditEvents.entityId, companyId),
    });
    const settingsEvent = events.find((e) => e.action === "company.settingsUpdated");
    expect(settingsEvent).toBeDefined();
    expect(settingsEvent!.entityType).toBe("company");
    expect((settingsEvent!.afterValue as { name: string }).name).toBe("Audit Settings Co Renamed");
  });

  it("POST /logo records a company.logoUpdated audit event", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "Audit Logo Co", name: "Owner", email: uniqueEmail("audit-logo-owner"), password: "password123" });
    const token = res.body.token as string;
    const companyId = res.body.company.id as string;

    const onePixelPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const uploadRes = await request(app)
      .post("/api/company/logo")
      .set("Authorization", `Bearer ${token}`)
      .attach("logo", onePixelPng, { filename: "logo.png", contentType: "image/png" });
    expect(uploadRes.status).toBe(200);

    const events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, companyId) });
    expect(events.some((e) => e.action === "company.logoUpdated")).toBe(true);
  });

  it("POST /invites and DELETE /invites/:id each record their own audit event", async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "Audit Invite Co", name: "Owner", email: uniqueEmail("audit-invite-owner"), password: "password123" });
    const token = res.body.token as string;

    const inviteEmail = uniqueEmail("audit-invitee");
    const inviteRes = await request(app)
      .post("/api/company/invites")
      .set("Authorization", `Bearer ${token}`)
      .send({ email: inviteEmail, role: "member" });
    expect(inviteRes.status).toBe(201);
    const inviteId = inviteRes.body.id as string;

    const createdEvents = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, inviteId) });
    const createdEvent = createdEvents.find((e) => e.action === "company.memberInvited");
    expect(createdEvent).toBeDefined();
    expect((createdEvent!.afterValue as { email: string }).email).toBe(inviteEmail);

    const deleteRes = await request(app).delete(`/api/company/invites/${inviteId}`).set("Authorization", `Bearer ${token}`);
    expect(deleteRes.status).toBe(204);

    const afterDeleteEvents = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, inviteId) });
    expect(afterDeleteEvents.some((e) => e.action === "company.inviteRevoked")).toBe(true);
  });
});
