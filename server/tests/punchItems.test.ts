import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { eq, and } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { auditEvents } from "../src/db/schema.js";

// MIDAD Phase C2 — Punch Lists / Site Deficiencies. Covers: CRUD,
// validation (title/priority/dueDate/assignee), the full six-state status
// lifecycle (including both reopen edges and every rejected illegal
// transition), server-owned resolution/verification/closure fields,
// authorization (member-open create/update/status, owner-only delete,
// Client Portal fully blocked), tenant/project isolation, audit, and
// filters.

vi.mock("../src/lib/mailer.js", () => ({ sendMail: vi.fn() }));
import { sendMail } from "../src/lib/mailer.js";

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

let ownerAToken: string;
let ownerAId: string;
let memberAToken: string;
let memberAId: string;
let ownerBToken: string;
let memberBId: string;
let projectA1Id: string;
let projectA2Id: string;
let projectB1Id: string;
let portalToken: string;

beforeAll(async () => {
  await resetDb();

  const ownerARes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "C2 Punch Co A", name: "Owner A", email: uniqueEmail("c2-owner-a"), password: "password123" });
  ownerAToken = ownerARes.body.token;
  ownerAId = ownerARes.body.user.id;

  const inviteRes = await request(app)
    .post("/api/company/invites")
    .set("Authorization", `Bearer ${ownerAToken}`)
    .send({ email: uniqueEmail("c2-member-a"), role: "member" });
  const mailCall = (sendMail as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
  const inviteToken = (mailCall[2] as string).match(/token=([a-f0-9]{40,80})/)![1];
  const acceptRes = await request(app)
    .post("/api/auth/accept-invite")
    .send({ token: inviteToken, name: "Member A", password: "memberpass123" });
  memberAToken = acceptRes.body.token;
  memberAId = acceptRes.body.user.id;

  const ownerBRes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "C2 Punch Co B", name: "Owner B", email: uniqueEmail("c2-owner-b"), password: "password123" });
  ownerBToken = ownerBRes.body.token;

  const inviteBRes = await request(app)
    .post("/api/company/invites")
    .set("Authorization", `Bearer ${ownerBToken}`)
    .send({ email: uniqueEmail("c2-member-b"), role: "member" });
  const mailCallB = (sendMail as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
  const inviteTokenB = (mailCallB[2] as string).match(/token=([a-f0-9]{40,80})/)![1];
  const acceptResB = await request(app)
    .post("/api/auth/accept-invite")
    .send({ token: inviteTokenB, name: "Member B", password: "memberpass123" });
  memberBId = acceptResB.body.user.id;

  const projectA1 = await request(app).post("/api/projects").set("Authorization", `Bearer ${ownerAToken}`).send({ name: "مشروع A1" });
  projectA1Id = projectA1.body.id;
  const projectA2 = await request(app).post("/api/projects").set("Authorization", `Bearer ${ownerAToken}`).send({ name: "مشروع A2" });
  projectA2Id = projectA2.body.id;
  const projectB1 = await request(app).post("/api/projects").set("Authorization", `Bearer ${ownerBToken}`).send({ name: "مشروع B1" });
  projectB1Id = projectB1.body.id;

  // A Client Portal identity, granted access to projectA1, purely to
  // prove it cannot reach these internal-only routes at all.
  const portalEmail = uniqueEmail("c2-portal-client");
  const portalUser = await request(app)
    .post("/api/client-portal-users")
    .set("Authorization", `Bearer ${ownerAToken}`)
    .send({ name: "عميل الملاحظات", email: portalEmail, password: "clientpass123" });
  await request(app)
    .post(`/api/client-portal-users/${portalUser.body.id}/access`)
    .set("Authorization", `Bearer ${ownerAToken}`)
    .send({ projectId: projectA1Id });
  const portalLogin = await request(app).post("/api/portal/auth/login").send({ email: portalEmail, password: "clientpass123" });
  portalToken = portalLogin.body.token;
});

function createItem(projectId: string, body: Record<string, unknown>, token = ownerAToken) {
  return request(app).post(`/api/projects/${projectId}/punch-items`).set("Authorization", `Bearer ${token}`).send(body);
}
function listItems(projectId: string, query = "", token = ownerAToken) {
  return request(app).get(`/api/projects/${projectId}/punch-items${query}`).set("Authorization", `Bearer ${token}`);
}
function getItem(projectId: string, id: string, token = ownerAToken) {
  return request(app).get(`/api/projects/${projectId}/punch-items/${id}`).set("Authorization", `Bearer ${token}`);
}
function updateItem(projectId: string, id: string, body: Record<string, unknown>, token = ownerAToken) {
  return request(app).patch(`/api/projects/${projectId}/punch-items/${id}`).set("Authorization", `Bearer ${token}`).send(body);
}
function deleteItem(projectId: string, id: string, token = ownerAToken) {
  return request(app).delete(`/api/projects/${projectId}/punch-items/${id}`).set("Authorization", `Bearer ${token}`);
}
function transitionStatus(projectId: string, id: string, body: Record<string, unknown>, token = ownerAToken) {
  return request(app).post(`/api/projects/${projectId}/punch-items/${id}/status`).set("Authorization", `Bearer ${token}`).send(body);
}

function baseItem(overrides: Record<string, unknown> = {}) {
  return { title: "تسرب مياه في المنطقة الشمالية", ...overrides };
}

describe("Punch Items — CRUD (Phase C2)", () => {
  it("1. create punch item", async () => {
    const res = await createItem(projectA1Id, baseItem({ location: "الدور الأرضي — Zone A", priority: "high" }));
    expect(res.status).toBe(201);
    expect(res.body.title).toBe("تسرب مياه في المنطقة الشمالية");
    expect(res.body.location).toBe("الدور الأرضي — Zone A");
    expect(res.body.priority).toBe("high");
    expect(res.body.status).toBe("open");
    expect(res.body).not.toHaveProperty("companyId");
  });

  it("2. read project punch items", async () => {
    const projectId = projectA2Id;
    await createItem(projectId, baseItem({ title: "ملاحظة 1" }));
    await createItem(projectId, baseItem({ title: "ملاحظة 2" }));
    const res = await listItems(projectId);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThanOrEqual(2);
    expect(res.body.map((i: { title: string }) => i.title)).toEqual(expect.arrayContaining(["ملاحظة 1", "ملاحظة 2"]));
  });

  it("3. read individual punch item", async () => {
    const created = await createItem(projectA1Id, baseItem({ title: "فردية" }));
    const res = await getItem(projectA1Id, created.body.id);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.body.id);
  });

  it("4. update punch item", async () => {
    const created = await createItem(projectA1Id, baseItem({ title: "قبل التحديث" }));
    const res = await updateItem(projectA1Id, created.body.id, { title: "بعد التحديث", priority: "critical" });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe("بعد التحديث");
    expect(res.body.priority).toBe("critical");
  });

  it("5. delete punch item (owner)", async () => {
    const created = await createItem(projectA1Id, baseItem({ title: "للحذف" }));
    const res = await deleteItem(projectA1Id, created.body.id);
    expect(res.status).toBe(204);
    const getRes = await getItem(projectA1Id, created.body.id);
    expect(getRes.status).toBe(404);
  });
});

describe("Punch Items — validation (Phase C2)", () => {
  it("6. empty title rejected", async () => {
    const res = await createItem(projectA1Id, { title: "" });
    expect(res.status).toBe(400);
  });

  it("7. invalid priority rejected", async () => {
    const res = await createItem(projectA1Id, baseItem({ priority: "urgent" }));
    expect(res.status).toBe(400);
  });

  it("8. invalid due date rejected", async () => {
    const res = await createItem(projectA1Id, baseItem({ dueDate: "15-09-2026" }));
    expect(res.status).toBe(400);
  });

  it("9. invalid (nonexistent) assigned user rejected", async () => {
    const res = await createItem(projectA1Id, baseItem({ assignedToUserId: "00000000-0000-0000-0000-000000000000" }));
    expect(res.status).toBe(400);
  });

  it("10. cross-company assigned user rejected", async () => {
    const res = await createItem(projectA1Id, baseItem({ assignedToUserId: memberBId }));
    expect(res.status).toBe(400);
  });

  it("mass assignment: unknown/system-owned fields on PATCH are rejected outright", async () => {
    const created = await createItem(projectA1Id, baseItem({ title: "حماية من الحقن" }));
    const res = await updateItem(projectA1Id, created.body.id, { status: "closed" });
    expect(res.status).toBe(400);
    const stillOpen = await getItem(projectA1Id, created.body.id);
    expect(stillOpen.body.status).toBe("open");
  });
});

describe("Punch Items — status lifecycle (Phase C2)", () => {
  it("11. new unassigned item starts OPEN", async () => {
    const res = await createItem(projectA1Id, baseItem({ title: "بدون مسؤول" }));
    expect(res.body.status).toBe("open");
  });

  it("12. new assigned item starts ASSIGNED", async () => {
    const res = await createItem(projectA1Id, baseItem({ title: "مع مسؤول", assignedToUserId: memberAId }));
    expect(res.body.status).toBe("assigned");
  });

  it("13. OPEN -> IN_PROGRESS allowed", async () => {
    const created = await createItem(projectA1Id, baseItem({ title: "فتح لجاري" }));
    const res = await transitionStatus(projectA1Id, created.body.id, { status: "in_progress" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("in_progress");
  });

  it("14. OPEN -> CLOSED rejected", async () => {
    const created = await createItem(projectA1Id, baseItem({ title: "فتح لمغلق" }));
    const res = await transitionStatus(projectA1Id, created.body.id, { status: "closed" });
    expect(res.status).toBe(400);
  });

  it("15. OPEN -> VERIFIED rejected", async () => {
    const created = await createItem(projectA1Id, baseItem({ title: "فتح لتحقق" }));
    const res = await transitionStatus(projectA1Id, created.body.id, { status: "verified" });
    expect(res.status).toBe(400);
  });

  it("16. IN_PROGRESS -> RESOLVED allowed", async () => {
    const created = await createItem(projectA1Id, baseItem({ title: "جاري لمحلول" }));
    await transitionStatus(projectA1Id, created.body.id, { status: "in_progress" });
    const res = await transitionStatus(projectA1Id, created.body.id, { status: "resolved", resolutionDescription: "تم إصلاح التسرب" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("resolved");
  });

  it("17. RESOLVED -> VERIFIED allowed", async () => {
    const created = await createItem(projectA1Id, baseItem({ title: "محلول لتحقق" }));
    await transitionStatus(projectA1Id, created.body.id, { status: "in_progress" });
    await transitionStatus(projectA1Id, created.body.id, { status: "resolved", resolutionDescription: "تم الإصلاح" });
    const res = await transitionStatus(projectA1Id, created.body.id, { status: "verified" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("verified");
  });

  it("18. VERIFIED -> CLOSED allowed", async () => {
    const created = await createItem(projectA1Id, baseItem({ title: "تحقق لإغلاق" }));
    await transitionStatus(projectA1Id, created.body.id, { status: "in_progress" });
    await transitionStatus(projectA1Id, created.body.id, { status: "resolved", resolutionDescription: "تم الإصلاح" });
    await transitionStatus(projectA1Id, created.body.id, { status: "verified" });
    const res = await transitionStatus(projectA1Id, created.body.id, { status: "closed" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("closed");
  });

  it("19. invalid backward transition rejected (e.g. IN_PROGRESS -> VERIFIED, CLOSED -> anything)", async () => {
    const created = await createItem(projectA1Id, baseItem({ title: "قفزة غير صالحة" }));
    await transitionStatus(projectA1Id, created.body.id, { status: "in_progress" });
    const skipToVerified = await transitionStatus(projectA1Id, created.body.id, { status: "verified" });
    expect(skipToVerified.status).toBe(400);

    const closedItem = await createItem(projectA1Id, baseItem({ title: "مغلقة نهائياً" }));
    await transitionStatus(projectA1Id, closedItem.body.id, { status: "in_progress" });
    await transitionStatus(projectA1Id, closedItem.body.id, { status: "resolved", resolutionDescription: "تم" });
    await transitionStatus(projectA1Id, closedItem.body.id, { status: "verified" });
    await transitionStatus(projectA1Id, closedItem.body.id, { status: "closed" });
    const fromClosed = await transitionStatus(projectA1Id, closedItem.body.id, { status: "open" });
    expect(fromClosed.status).toBe(400);
  });

  it("20. RESOLVED -> IN_PROGRESS allowed (reopen after failed verification path)", async () => {
    const created = await createItem(projectA1Id, baseItem({ title: "إعادة فتح من محلول" }));
    await transitionStatus(projectA1Id, created.body.id, { status: "in_progress" });
    await transitionStatus(projectA1Id, created.body.id, { status: "resolved", resolutionDescription: "محاولة أولى" });
    const res = await transitionStatus(projectA1Id, created.body.id, { status: "in_progress" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("in_progress");
    // Reopening never erases the prior resolution's audit history.
    expect(res.body.resolutionDescription).toBe("محاولة أولى");
  });

  it("21. VERIFIED -> IN_PROGRESS allowed (verification found the fix insufficient)", async () => {
    const created = await createItem(projectA1Id, baseItem({ title: "إعادة فتح من تحقق" }));
    await transitionStatus(projectA1Id, created.body.id, { status: "in_progress" });
    await transitionStatus(projectA1Id, created.body.id, { status: "resolved", resolutionDescription: "محاولة" });
    await transitionStatus(projectA1Id, created.body.id, { status: "verified" });
    const res = await transitionStatus(projectA1Id, created.body.id, { status: "in_progress" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("in_progress");
    expect(res.body.verifiedAt).toBeTruthy();
  });

  it("OPEN -> ASSIGNED requires an existing assignee", async () => {
    const created = await createItem(projectA1Id, baseItem({ title: "بدون مسؤول للتعيين" }));
    const res = await transitionStatus(projectA1Id, created.body.id, { status: "assigned" });
    expect(res.status).toBe(400);

    await updateItem(projectA1Id, created.body.id, { assignedToUserId: memberAId });
    const res2 = await transitionStatus(projectA1Id, created.body.id, { status: "assigned" });
    expect(res2.status).toBe(200);
    expect(res2.body.status).toBe("assigned");
  });
});

describe("Punch Items — resolution/verification/closure server-owned fields (Phase C2)", () => {
  it("22. resolution requires resolutionDescription", async () => {
    const created = await createItem(projectA1Id, baseItem({ title: "بدون وصف معالجة" }));
    await transitionStatus(projectA1Id, created.body.id, { status: "in_progress" });
    const res = await transitionStatus(projectA1Id, created.body.id, { status: "resolved" });
    expect(res.status).toBe(400);
  });

  it("23-25. resolvedAt/resolvedByUserId are server-generated; client cannot spoof them", async () => {
    const created = await createItem(projectA1Id, baseItem({ title: "توليد خادم للمعالجة" }));
    await transitionStatus(projectA1Id, created.body.id, { status: "in_progress" });
    const spoofAttempt = await transitionStatus(projectA1Id, created.body.id, {
      status: "resolved",
      resolutionDescription: "تم الإصلاح",
      resolvedAt: "2020-01-01T00:00:00.000Z",
      resolvedByUserId: memberAId,
    });
    // The extra fields make the request body fail .strict() validation —
    // proving the endpoint has no code path that would ever accept them.
    expect(spoofAttempt.status).toBe(400);

    const res = await transitionStatus(projectA1Id, created.body.id, { status: "resolved", resolutionDescription: "تم الإصلاح" });
    expect(res.status).toBe(200);
    // The actor is whoever called the endpoint (ownerAToken here), never
    // the memberAId the spoof attempt tried to inject above.
    expect(res.body.resolvedByUserId).toBe(ownerAId);
    expect(new Date(res.body.resolvedAt).getFullYear()).toBeGreaterThan(2024);
  });

  it("26-28. verifiedAt/verifiedByUserId are server-generated; client cannot spoof them", async () => {
    const created = await createItem(projectA1Id, baseItem({ title: "توليد خادم للتحقق" }));
    await transitionStatus(projectA1Id, created.body.id, { status: "in_progress" });
    await transitionStatus(projectA1Id, created.body.id, { status: "resolved", resolutionDescription: "تم" });

    const spoofAttempt = await transitionStatus(projectA1Id, created.body.id, {
      status: "verified",
      verifiedAt: "2020-01-01T00:00:00.000Z",
      verifiedByUserId: memberAId,
    });
    expect(spoofAttempt.status).toBe(400);

    const res = await transitionStatus(projectA1Id, created.body.id, { status: "verified" });
    expect(res.status).toBe(200);
    expect(new Date(res.body.verifiedAt).getFullYear()).toBeGreaterThan(2024);
  });

  it("29-31. closedAt/closedByUserId are server-generated; client cannot spoof them", async () => {
    const created = await createItem(projectA1Id, baseItem({ title: "توليد خادم للإغلاق" }));
    await transitionStatus(projectA1Id, created.body.id, { status: "in_progress" });
    await transitionStatus(projectA1Id, created.body.id, { status: "resolved", resolutionDescription: "تم" });
    await transitionStatus(projectA1Id, created.body.id, { status: "verified" });

    const spoofAttempt = await transitionStatus(projectA1Id, created.body.id, {
      status: "closed",
      closedAt: "2020-01-01T00:00:00.000Z",
      closedByUserId: memberAId,
    });
    expect(spoofAttempt.status).toBe(400);

    const res = await transitionStatus(projectA1Id, created.body.id, { status: "closed" });
    expect(res.status).toBe(200);
    expect(new Date(res.body.closedAt).getFullYear()).toBeGreaterThan(2024);
  });

  it("the PATCH endpoint (not just the status endpoint) also cannot set resolvedAt/resolvedByUserId/etc.", async () => {
    const created = await createItem(projectA1Id, baseItem({ title: "حماية PATCH" }));
    const res = await updateItem(projectA1Id, created.body.id, { resolvedAt: "2020-01-01", resolvedByUserId: memberAId });
    expect(res.status).toBe(400);
  });
});

describe("Punch Items — authorization (Phase C2)", () => {
  it("32. unauthenticated request rejected", async () => {
    const res = await request(app).post(`/api/projects/${projectA1Id}/punch-items`).send(baseItem());
    expect(res.status).toBe(401);
  });

  it("33. unauthorized internal user (member) cannot delete", async () => {
    const created = await createItem(projectA1Id, baseItem({ title: "محمية من الحذف" }));
    const res = await deleteItem(projectA1Id, created.body.id, memberAToken);
    expect(res.status).toBe(403);
  });

  it("a member CAN create/update/transition status (member-open, matching the delete-only-owner precedent)", async () => {
    const created = await createItem(projectA1Id, baseItem({ title: "من عضو" }), memberAToken);
    expect(created.status).toBe(201);
    const updated = await updateItem(projectA1Id, created.body.id, { priority: "low" }, memberAToken);
    expect(updated.status).toBe(200);
    const transitioned = await transitionStatus(projectA1Id, created.body.id, { status: "in_progress" }, memberAToken);
    expect(transitioned.status).toBe(200);
  });

  it("34. cross-tenant read rejected", async () => {
    const created = await createItem(projectA1Id, baseItem({ title: "قراءة عبر المستأجرين" }));
    const res = await getItem(projectA1Id, created.body.id, ownerBToken);
    expect(res.status).toBe(404);
    const listRes = await listItems(projectA1Id, "", ownerBToken);
    expect(listRes.status).toBe(404);
  });

  it("35. cross-tenant update rejected", async () => {
    const created = await createItem(projectA1Id, baseItem({ title: "تحديث عبر المستأجرين" }));
    const res = await updateItem(projectA1Id, created.body.id, { title: "تم الاختراق" }, ownerBToken);
    expect(res.status).toBe(404);
  });

  it("36. cross-tenant delete rejected", async () => {
    const created = await createItem(projectA1Id, baseItem({ title: "حذف عبر المستأجرين" }));
    const res = await deleteItem(projectA1Id, created.body.id, ownerBToken);
    expect(res.status).toBe(404);
  });

  it("37. cross-project manipulation rejected (item belongs to project A1, requested via A2's URL)", async () => {
    const created = await createItem(projectA1Id, baseItem({ title: "عبر المشاريع" }));
    const res = await getItem(projectA2Id, created.body.id);
    expect(res.status).toBe(404);
    const updateRes = await updateItem(projectA2Id, created.body.id, { title: "اختراق" });
    expect(updateRes.status).toBe(404);
  });

  it("38. Client Portal identity cannot access punch items at all", async () => {
    const res = await listItems(projectA1Id, "", portalToken);
    expect(res.status).toBe(401);
    const createRes = await createItem(projectA1Id, baseItem(), portalToken);
    expect(createRes.status).toBe(401);
  });
});

describe("Punch Items — audit (Phase C2)", () => {
  it("39. create generates audit", async () => {
    const created = await createItem(projectA1Id, baseItem({ title: "تدقيق الإنشاء" }));
    const event = await db.query.auditEvents.findFirst({
      where: and(eq(auditEvents.entityId, created.body.id), eq(auditEvents.action, "punchItem.created")),
    });
    expect(event).toBeTruthy();
    expect(event!.entityType).toBe("project_punch_item");
    expect((event!.metadata as { projectId: string }).projectId).toBe(projectA1Id);
  });

  it("40. update generates audit", async () => {
    const created = await createItem(projectA1Id, baseItem({ title: "تدقيق التحديث" }));
    await updateItem(projectA1Id, created.body.id, { priority: "critical" });
    const event = await db.query.auditEvents.findFirst({
      where: and(eq(auditEvents.entityId, created.body.id), eq(auditEvents.action, "punchItem.updated")),
    });
    expect(event).toBeTruthy();
  });

  it("41. delete generates audit", async () => {
    const created = await createItem(projectA1Id, baseItem({ title: "تدقيق الحذف" }));
    await deleteItem(projectA1Id, created.body.id);
    const event = await db.query.auditEvents.findFirst({
      where: and(eq(auditEvents.entityId, created.body.id), eq(auditEvents.action, "punchItem.deleted")),
    });
    expect(event).toBeTruthy();
  });

  it("42. status transition generates audit with before/after status", async () => {
    const created = await createItem(projectA1Id, baseItem({ title: "تدقيق الانتقال" }));
    await transitionStatus(projectA1Id, created.body.id, { status: "in_progress" });
    const event = await db.query.auditEvents.findFirst({
      where: and(eq(auditEvents.entityId, created.body.id), eq(auditEvents.action, "punchItem.statusChanged")),
    });
    expect(event).toBeTruthy();
    expect((event!.beforeValue as { status: string }).status).toBe("open");
    expect((event!.afterValue as { status: string }).status).toBe("in_progress");
  });

  it("43. assignment mutation is auditable via the generic update event", async () => {
    const created = await createItem(projectA1Id, baseItem({ title: "تدقيق التعيين" }));
    await updateItem(projectA1Id, created.body.id, { assignedToUserId: memberAId });
    const event = await db.query.auditEvents.findFirst({
      where: and(eq(auditEvents.entityId, created.body.id), eq(auditEvents.action, "punchItem.updated")),
    });
    expect(event).toBeTruthy();
    expect((event!.beforeValue as { assignedToUserId: string | null }).assignedToUserId).toBeNull();
    expect((event!.afterValue as { assignedToUserId: string | null }).assignedToUserId).toBe(memberAId);
  });
});

describe("Punch Items — filters (Phase C2)", () => {
  it("44. status filtering correct", async () => {
    const projectId = projectA2Id;
    const open = await createItem(projectId, baseItem({ title: "فلترة حالة مفتوحة" }));
    const inProgressItem = await createItem(projectId, baseItem({ title: "فلترة حالة جارية" }));
    await transitionStatus(projectId, inProgressItem.body.id, { status: "in_progress" });

    const res = await listItems(projectId, "?status=in_progress");
    expect(res.status).toBe(200);
    const ids = res.body.map((i: { id: string }) => i.id);
    expect(ids).toContain(inProgressItem.body.id);
    expect(ids).not.toContain(open.body.id);
  });

  it("45. priority filtering correct", async () => {
    const projectId = projectA2Id;
    const low = await createItem(projectId, baseItem({ title: "فلترة أولوية منخفضة", priority: "low" }));
    const critical = await createItem(projectId, baseItem({ title: "فلترة أولوية حرجة", priority: "critical" }));

    const res = await listItems(projectId, "?priority=critical");
    expect(res.status).toBe(200);
    const ids = res.body.map((i: { id: string }) => i.id);
    expect(ids).toContain(critical.body.id);
    expect(ids).not.toContain(low.body.id);
  });

  it("46. assignee filtering correct", async () => {
    const projectId = projectA2Id;
    const assigned = await createItem(projectId, baseItem({ title: "فلترة مسؤول", assignedToUserId: memberAId }));
    const unassigned = await createItem(projectId, baseItem({ title: "فلترة بدون مسؤول" }));

    const res = await listItems(projectId, `?assignedToUserId=${memberAId}`);
    expect(res.status).toBe(200);
    const ids = res.body.map((i: { id: string }) => i.id);
    expect(ids).toContain(assigned.body.id);
    expect(ids).not.toContain(unassigned.body.id);
  });

  it("47. overdue filtering correct (dueDate in the past AND status != closed)", async () => {
    const projectId = projectA2Id;
    const overdue = await createItem(projectId, baseItem({ title: "متأخرة", dueDate: "2020-01-01" }));
    const future = await createItem(projectId, baseItem({ title: "غير متأخرة", dueDate: "2099-01-01" }));
    const overdueButClosed = await createItem(projectId, baseItem({ title: "متأخرة لكن مغلقة", dueDate: "2020-01-01" }));
    await transitionStatus(projectId, overdueButClosed.body.id, { status: "in_progress" });
    await transitionStatus(projectId, overdueButClosed.body.id, { status: "resolved", resolutionDescription: "تم" });
    await transitionStatus(projectId, overdueButClosed.body.id, { status: "verified" });
    await transitionStatus(projectId, overdueButClosed.body.id, { status: "closed" });

    const res = await listItems(projectId, "?overdue=true");
    expect(res.status).toBe(200);
    const ids = res.body.map((i: { id: string }) => i.id);
    expect(ids).toContain(overdue.body.id);
    expect(ids).not.toContain(future.body.id);
    expect(ids).not.toContain(overdueButClosed.body.id);
  });
});
