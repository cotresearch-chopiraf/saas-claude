import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { eq, and, isNull } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { auditEvents, clientPortalSessions, clientPortalUsers, clientProjectAccess } from "../src/db/schema.js";

// MIDAD Phase B1 — Client Portal Identity & Project Access Foundation.
// Covers: identity lifecycle (create/login/wrong-password/disabled/
// logout/session-revocation), explicit project access grants (grant/
// allowed/revoke/denied/duplicate-blocked), tenant isolation (same-company
// unauthorized project, cross-company, reverse direction, direct ID
// manipulation), admin-side RBAC (clientPortal.manage), audit events, data
// leakage (no passwordHash, no internal/financial fields anywhere in a
// portal response), and concurrent grant creation.

vi.mock("../src/lib/mailer.js", () => ({ sendMail: vi.fn() }));
import { sendMail } from "../src/lib/mailer.js";

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

let ownerAToken: string;
let memberAToken: string;
let ownerBToken: string;
let projectA1Id: string;
let projectA2Id: string;
let projectB1Id: string;

beforeAll(async () => {
  await resetDb();

  const ownerARes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Portal Co A", name: "Owner A", email: uniqueEmail("portal-owner-a"), password: "password123" });
  ownerAToken = ownerARes.body.token;

  const inviteRes = await request(app)
    .post("/api/company/invites")
    .set("Authorization", `Bearer ${ownerAToken}`)
    .send({ email: uniqueEmail("portal-member-a"), role: "member" });
  const mailCall = (sendMail as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
  const inviteToken = (mailCall[2] as string).match(/token=([a-f0-9]{40,80})/)![1];
  const acceptRes = await request(app)
    .post("/api/auth/accept-invite")
    .send({ token: inviteToken, name: "Member A", password: "memberpass123" });
  memberAToken = acceptRes.body.token;

  const ownerBRes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Portal Co B", name: "Owner B", email: uniqueEmail("portal-owner-b"), password: "password123" });
  ownerBToken = ownerBRes.body.token;

  const projectA1 = await request(app).post("/api/projects").set("Authorization", `Bearer ${ownerAToken}`).send({ name: "مشروع A1" });
  projectA1Id = projectA1.body.id;
  const projectA2 = await request(app).post("/api/projects").set("Authorization", `Bearer ${ownerAToken}`).send({ name: "مشروع A2" });
  projectA2Id = projectA2.body.id;
  const projectB1 = await request(app).post("/api/projects").set("Authorization", `Bearer ${ownerBToken}`).send({ name: "مشروع B1" });
  projectB1Id = projectB1.body.id;
});

function createPortalUser(body: Record<string, unknown>, token = ownerAToken) {
  return request(app).post("/api/client-portal-users").set("Authorization", `Bearer ${token}`).send(body);
}
function listPortalUsers(token = ownerAToken) {
  return request(app).get("/api/client-portal-users").set("Authorization", `Bearer ${token}`);
}
function patchPortalUserStatus(id: string, status: string, token = ownerAToken) {
  return request(app).patch(`/api/client-portal-users/${id}`).set("Authorization", `Bearer ${token}`).send({ status });
}
function grantAccess(id: string, projectId: string, token = ownerAToken) {
  return request(app).post(`/api/client-portal-users/${id}/access`).set("Authorization", `Bearer ${token}`).send({ projectId });
}
function revokeAccess(id: string, projectId: string, token = ownerAToken) {
  return request(app).post(`/api/client-portal-users/${id}/access/${projectId}/revoke`).set("Authorization", `Bearer ${token}`);
}
function portalLogin(email: string, password: string) {
  return request(app).post("/api/portal/auth/login").send({ email, password });
}
function portalLogout(token: string) {
  return request(app).post("/api/portal/auth/logout").set("Authorization", `Bearer ${token}`);
}
function listPortalProjects(token: string) {
  return request(app).get("/api/portal/projects").set("Authorization", `Bearer ${token}`);
}
function getPortalProject(id: string, token: string) {
  return request(app).get(`/api/portal/projects/${id}`).set("Authorization", `Bearer ${token}`);
}

async function createAndLoginPortalUser(name: string, opts: { token?: string } = {}): Promise<{ id: string; email: string; password: string; portalToken: string }> {
  const email = uniqueEmail("portal-client");
  const password = "clientpass123";
  const created = await createPortalUser({ name, email, password }, opts.token);
  expect(created.status).toBe(201);
  const login = await portalLogin(email, password);
  expect(login.status).toBe(200);
  return { id: created.body.id, email, password, portalToken: login.body.token };
}

describe("Client Portal — identity lifecycle", () => {
  it("1. an owner can create a client portal user; response never includes passwordHash", async () => {
    const res = await createPortalUser({ name: "أحمد العميل", email: uniqueEmail("id1"), password: "password123" });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe("أحمد العميل");
    expect(res.body).not.toHaveProperty("passwordHash");
  });

  it("2. login with correct credentials succeeds and returns a usable token", async () => {
    const { portalToken } = await createAndLoginPortalUser("عميل تسجيل الدخول");
    expect(portalToken).toBeTruthy();
    const res = await listPortalProjects(portalToken);
    expect(res.status).toBe(200);
  });

  it("3. login with the wrong password is rejected (401), account still usable afterward with the right one", async () => {
    const email = uniqueEmail("id3");
    await createPortalUser({ name: "عميل كلمة مرور", email, password: "correctpass123" });
    const wrong = await portalLogin(email, "wrongpass123");
    expect(wrong.status).toBe(401);
    const right = await portalLogin(email, "correctpass123");
    expect(right.status).toBe(200);
  });

  it("4. login with a nonexistent email is rejected (401), same shape as wrong password (no enumeration)", async () => {
    const res = await portalLogin(uniqueEmail("nonexistent"), "whatever123");
    expect(res.status).toBe(401);
  });

  it("5. a disabled client cannot log in even with the correct password", async () => {
    const email = uniqueEmail("id5");
    const created = await createPortalUser({ name: "عميل معطّل", email, password: "password123" });
    await patchPortalUserStatus(created.body.id, "deactivated");
    const res = await portalLogin(email, "password123");
    expect(res.status).toBe(401);
  });

  it("6. a disabled client's EXISTING session immediately stops working, even though the token itself hasn't expired", async () => {
    const { id, portalToken } = await createAndLoginPortalUser("عميل جلسة نشطة");
    expect((await listPortalProjects(portalToken)).status).toBe(200);
    await patchPortalUserStatus(id, "deactivated");
    const res = await listPortalProjects(portalToken);
    expect(res.status).toBe(401);
  });

  it("7. logout revokes the session; the same token is rejected on the next request", async () => {
    const { portalToken } = await createAndLoginPortalUser("عميل تسجيل خروج");
    expect((await listPortalProjects(portalToken)).status).toBe(200);
    const logoutRes = await portalLogout(portalToken);
    expect(logoutRes.status).toBe(200);
    const after = await listPortalProjects(portalToken);
    expect(after.status).toBe(401);
  });

  it("8. directly revoking a session row in the DB immediately invalidates that token, without waiting for expiry", async () => {
    const { portalToken } = await createAndLoginPortalUser("عميل جلسة ملغاة يدوياً");
    expect((await listPortalProjects(portalToken)).status).toBe(200);
    await db.update(clientPortalSessions).set({ revokedAt: new Date() }).where(isNull(clientPortalSessions.revokedAt));
    const res = await listPortalProjects(portalToken);
    expect(res.status).toBe(401);
  });

  it("9. an unauthenticated request to any portal route is rejected", async () => {
    expect((await request(app).get("/api/portal/projects")).status).toBe(401);
    expect((await request(app).post("/api/portal/auth/logout")).status).toBe(401);
  });
});

describe("Client Portal — project access grants", () => {
  it("10. granting project access succeeds and the project becomes visible", async () => {
    const { id, portalToken } = await createAndLoginPortalUser("عميل منح صلاحية");
    const grant = await grantAccess(id, projectA1Id);
    expect(grant.status).toBe(201);

    const list = await listPortalProjects(portalToken);
    expect(list.body.some((p: { id: string }) => p.id === projectA1Id)).toBe(true);

    const detail = await getPortalProject(projectA1Id, portalToken);
    expect(detail.status).toBe(200);
    expect(detail.body.name).toBe("مشروع A1");
  });

  it("11. revoking project access removes visibility immediately", async () => {
    const { id, portalToken } = await createAndLoginPortalUser("عميل إلغاء صلاحية");
    await grantAccess(id, projectA1Id);
    expect((await getPortalProject(projectA1Id, portalToken)).status).toBe(200);

    const revoke = await revokeAccess(id, projectA1Id);
    expect(revoke.status).toBe(200);

    const after = await getPortalProject(projectA1Id, portalToken);
    expect(after.status).toBe(404);
    const list = await listPortalProjects(portalToken);
    expect(list.body.some((p: { id: string }) => p.id === projectA1Id)).toBe(false);
  });

  it("12. revoking an access grant that doesn't exist (or is already revoked) returns a controlled 409, not a silent success", async () => {
    const { id } = await createAndLoginPortalUser("عميل بلا صلاحية");
    const res = await revokeAccess(id, projectA1Id);
    expect(res.status).toBe(409);
  });

  it("13. a duplicate ACTIVE grant for the same (client, project) is rejected", async () => {
    const { id } = await createAndLoginPortalUser("عميل صلاحية مكررة");
    const first = await grantAccess(id, projectA2Id);
    expect(first.status).toBe(201);
    const second = await grantAccess(id, projectA2Id);
    expect(second.status).toBe(409);
  });

  it("14. after revoking, a fresh grant for the same (client, project) can be created again", async () => {
    const { id, portalToken } = await createAndLoginPortalUser("عميل إعادة منح");
    await grantAccess(id, projectA1Id);
    await revokeAccess(id, projectA1Id);
    const regrant = await grantAccess(id, projectA1Id);
    expect(regrant.status).toBe(201);
    expect((await getPortalProject(projectA1Id, portalToken)).status).toBe(200);
  });

  it("15. granting access to a nonexistent project returns 404", async () => {
    const { id } = await createAndLoginPortalUser("عميل مشروع غير موجود");
    const res = await grantAccess(id, "00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });
});

describe("Client Portal — tenant isolation", () => {
  it("16. a client can access a project they were explicitly granted", async () => {
    const { id, portalToken } = await createAndLoginPortalUser("عميل معزول 1");
    await grantAccess(id, projectA1Id);
    expect((await getPortalProject(projectA1Id, portalToken)).status).toBe(200);
  });

  it("17. a client CANNOT access a same-company project they were never granted", async () => {
    const { id, portalToken } = await createAndLoginPortalUser("عميل معزول 2");
    await grantAccess(id, projectA1Id);
    const res = await getPortalProject(projectA2Id, portalToken);
    expect(res.status).toBe(404);
    const list = await listPortalProjects(portalToken);
    expect(list.body.some((p: { id: string }) => p.id === projectA2Id)).toBe(false);
  });

  it("18. a client CANNOT access another company's project, even with a direct project ID", async () => {
    const { id, portalToken } = await createAndLoginPortalUser("عميل معزول 3");
    await grantAccess(id, projectA1Id);
    const res = await getPortalProject(projectB1Id, portalToken);
    expect(res.status).toBe(404);
  });

  it("19. reverse direction: a client of company B cannot access company A's project", async () => {
    const clientB = await createAndLoginPortalUser("عميل شركة ب", { token: ownerBToken });
    await grantAccess(clientB.id, projectB1Id, ownerBToken);
    const res = await getPortalProject(projectA1Id, clientB.portalToken);
    expect(res.status).toBe(404);
    expect((await getPortalProject(projectB1Id, clientB.portalToken)).status).toBe(200);
  });

  it("20. an admin cannot grant access to a project outside their own company", async () => {
    const { id } = await createAndLoginPortalUser("عميل منح خاطئ");
    const res = await grantAccess(id, projectB1Id, ownerAToken);
    expect(res.status).toBe(404);
  });

  it("21. an admin cannot manage a client portal user belonging to a different company", async () => {
    const clientB = await createAndLoginPortalUser("عميل إدارة عبر الشركات", { token: ownerBToken });
    expect((await patchPortalUserStatus(clientB.id, "deactivated", ownerAToken)).status).toBe(404);
    expect((await grantAccess(clientB.id, projectA1Id, ownerAToken)).status).toBe(404);
  });
});

describe("Client Portal — admin-side authorization (RBAC)", () => {
  it("22. a member (no clientPortal.manage) cannot create a client portal user — 403", async () => {
    const res = await createPortalUser({ name: "عميل ممنوع", email: uniqueEmail("rbac1"), password: "password123" }, memberAToken);
    expect(res.status).toBe(403);
  });

  it("23. a member cannot grant or revoke project access — 403", async () => {
    const { id } = await createAndLoginPortalUser("عميل صلاحيات RBAC");
    expect((await grantAccess(id, projectA1Id, memberAToken)).status).toBe(403);
    await grantAccess(id, projectA1Id, ownerAToken);
    expect((await revokeAccess(id, projectA1Id, memberAToken)).status).toBe(403);
  });

  it("24. a member CAN still list client portal users (read is member-open, matching every other master-data domain)", async () => {
    const res = await listPortalUsers(memberAToken);
    expect(res.status).toBe(200);
  });

  it("25. an owner succeeds where a member is blocked", async () => {
    const res = await createPortalUser({ name: "عميل صلاحيات", email: uniqueEmail("rbac2"), password: "password123" }, ownerAToken);
    expect(res.status).toBe(201);
  });
});

describe("Client Portal — audit events", () => {
  it("26. creating a client portal user records client_portal.user_created", async () => {
    const created = await createPortalUser({ name: "عميل تدقيق إنشاء", email: uniqueEmail("audit1"), password: "password123" });
    const events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, created.body.id) });
    expect(events.map((e) => e.action)).toContain("client_portal.user_created");
  });

  it("27. a successful login records client_portal.login", async () => {
    const { id } = await createAndLoginPortalUser("عميل تدقيق تسجيل دخول");
    const events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, id) });
    expect(events.map((e) => e.action)).toContain("client_portal.login");
  });

  it("28. a failed login (wrong password) records client_portal.login_failed", async () => {
    const email = uniqueEmail("audit2");
    const created = await createPortalUser({ name: "عميل فشل", email, password: "correctpass123" });
    await portalLogin(email, "wrongpass123");
    const events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, created.body.id) });
    expect(events.map((e) => e.action)).toContain("client_portal.login_failed");
  });

  it("28b. a login attempt against a disabled account also records client_portal.login_failed", async () => {
    const email = uniqueEmail("audit2b");
    const created = await createPortalUser({ name: "عميل فشل معطّل", email, password: "correctpass123" });
    await patchPortalUserStatus(created.body.id, "deactivated");
    await portalLogin(email, "correctpass123");
    const events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, created.body.id) });
    expect(events.map((e) => e.action)).toContain("client_portal.login_failed");
  });

  it("29. logout records client_portal.logout", async () => {
    const { id, portalToken } = await createAndLoginPortalUser("عميل تدقيق خروج");
    await portalLogout(portalToken);
    const events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, id) });
    expect(events.map((e) => e.action)).toContain("client_portal.logout");
  });

  it("30. granting and revoking access record client_portal.access_granted / client_portal.access_revoked", async () => {
    const { id } = await createAndLoginPortalUser("عميل تدقيق صلاحية");
    const grant = await grantAccess(id, projectA1Id);
    const revoke = await revokeAccess(id, projectA1Id);

    const grantEvents = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, grant.body.id) });
    expect(grantEvents.map((e) => e.action)).toContain("client_portal.access_granted");

    const revokeEvents = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, revoke.body.id) });
    expect(revokeEvents.map((e) => e.action)).toContain("client_portal.access_revoked");
  });

  it("31. disabling a client portal user records client_portal.user_disabled", async () => {
    const { id } = await createAndLoginPortalUser("عميل تدقيق تعطيل");
    await patchPortalUserStatus(id, "deactivated");
    const events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, id) });
    expect(events.map((e) => e.action)).toContain("client_portal.user_disabled");
  });

  it("32. audit metadata never contains a password, token, or secret", async () => {
    const { id } = await createAndLoginPortalUser("عميل تدقيق أمان");
    await grantAccess(id, projectA1Id);
    await revokeAccess(id, projectA1Id);
    await patchPortalUserStatus(id, "deactivated");

    const events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, id) });
    const dump = JSON.stringify(events);
    expect(dump).not.toMatch(/password|passwordHash|"token"|secret/i);
  });
});

describe("Client Portal — data leakage", () => {
  it("33. the client portal user list response never includes passwordHash", async () => {
    const res = await listPortalUsers();
    expect(res.status).toBe(200);
    for (const row of res.body) {
      expect(row).not.toHaveProperty("passwordHash");
    }
  });

  it("34. a portal project response contains ONLY minimal safe fields — no budget/payroll/internal data of any kind", async () => {
    const { id, portalToken } = await createAndLoginPortalUser("عميل تسريب بيانات");
    await grantAccess(id, projectA1Id);
    const res = await getPortalProject(projectA1Id, portalToken);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["id", "name", "startDate", "status"].sort());
  });

  it("35. the portal project list response contains only minimal safe fields per row", async () => {
    const { id, portalToken } = await createAndLoginPortalUser("عميل تسريب قائمة");
    await grantAccess(id, projectA1Id);
    const res = await listPortalProjects(portalToken);
    expect(res.status).toBe(200);
    for (const row of res.body) {
      expect(Object.keys(row).sort()).toEqual(["id", "name", "startDate", "status"].sort());
    }
  });
});

describe("Client Portal — concurrency", () => {
  it("36. concurrent attempts to grant the same (client, project) access result in exactly one active grant", async () => {
    const { id } = await createAndLoginPortalUser("عميل تزامن");
    const results = await Promise.all(Array.from({ length: 5 }, () => grantAccess(id, projectA1Id)));
    const succeeded = results.filter((r) => r.status === 201);
    expect(succeeded.length).toBe(1);

    const activeGrants = await db.query.clientProjectAccess.findMany({
      where: and(
        eq(clientProjectAccess.clientPortalUserId, id),
        eq(clientProjectAccess.projectId, projectA1Id),
        isNull(clientProjectAccess.revokedAt),
      ),
    });
    expect(activeGrants).toHaveLength(1);
  });

  it("37. the DB-level partial unique index rejects a second active grant row for the same pair even if attempted directly", async () => {
    const { id } = await createAndLoginPortalUser("عميل قيد قاعدة بيانات");
    const first = await grantAccess(id, projectA1Id);
    expect(first.status).toBe(201);

    await expect(
      db.insert(clientProjectAccess).values({
        companyId: (await db.query.clientPortalUsers.findFirst({ where: eq(clientPortalUsers.id, id) }))!.companyId,
        clientPortalUserId: id,
        projectId: projectA1Id,
        grantedBy: (await db.query.clientProjectAccess.findFirst({ where: eq(clientProjectAccess.clientPortalUserId, id) }))!.grantedBy,
      }),
    ).rejects.toThrow();
  });
});
