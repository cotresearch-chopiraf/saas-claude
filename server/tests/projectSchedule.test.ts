import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { eq, and } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { auditEvents, projectTaskDependencies } from "../src/db/schema.js";

// MIDAD Phase C1 — Gantt Scheduling Foundation. Covers: task/milestone CRUD,
// date/progress/hierarchy validation, FS dependency creation with full
// cycle/duplicate/cross-project/cross-tenant rejection, cascading dependency
// cleanup on task delete, authorization (member-open create/update,
// owner-only delete, Client Portal identity fully blocked), tenant
// isolation, audit, and the combined Gantt read shape.

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
let portalToken: string;

beforeAll(async () => {
  await resetDb();

  const ownerARes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "C1 Sched Co A", name: "Owner A", email: uniqueEmail("c1-owner-a"), password: "password123" });
  ownerAToken = ownerARes.body.token;

  const inviteRes = await request(app)
    .post("/api/company/invites")
    .set("Authorization", `Bearer ${ownerAToken}`)
    .send({ email: uniqueEmail("c1-member-a"), role: "member" });
  const mailCall = (sendMail as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
  const inviteToken = (mailCall[2] as string).match(/token=([a-f0-9]{40,80})/)![1];
  const acceptRes = await request(app)
    .post("/api/auth/accept-invite")
    .send({ token: inviteToken, name: "Member A", password: "memberpass123" });
  memberAToken = acceptRes.body.token;

  const ownerBRes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "C1 Sched Co B", name: "Owner B", email: uniqueEmail("c1-owner-b"), password: "password123" });
  ownerBToken = ownerBRes.body.token;

  const projectA1 = await request(app).post("/api/projects").set("Authorization", `Bearer ${ownerAToken}`).send({ name: "مشروع A1" });
  projectA1Id = projectA1.body.id;
  const projectA2 = await request(app).post("/api/projects").set("Authorization", `Bearer ${ownerAToken}`).send({ name: "مشروع A2" });
  projectA2Id = projectA2.body.id;
  const projectB1 = await request(app).post("/api/projects").set("Authorization", `Bearer ${ownerBToken}`).send({ name: "مشروع B1" });
  projectB1Id = projectB1.body.id;

  // A Client Portal identity, granted access to projectA1, purely to prove
  // it cannot mutate scheduling data (test 27) — it authenticates through
  // an entirely different JWT secret than requireAuth accepts.
  const portalEmail = uniqueEmail("c1-portal-client");
  const portalUser = await request(app)
    .post("/api/client-portal-users")
    .set("Authorization", `Bearer ${ownerAToken}`)
    .send({ name: "عميل الجدول الزمني", email: portalEmail, password: "clientpass123" });
  await request(app)
    .post(`/api/client-portal-users/${portalUser.body.id}/access`)
    .set("Authorization", `Bearer ${ownerAToken}`)
    .send({ projectId: projectA1Id });
  const portalLogin = await request(app).post("/api/portal/auth/login").send({ email: portalEmail, password: "clientpass123" });
  portalToken = portalLogin.body.token;
});

function createTask(projectId: string, body: Record<string, unknown>, token = ownerAToken) {
  return request(app).post(`/api/projects/${projectId}/schedule/tasks`).set("Authorization", `Bearer ${token}`).send(body);
}
function updateTask(projectId: string, taskId: string, body: Record<string, unknown>, token = ownerAToken) {
  return request(app).patch(`/api/projects/${projectId}/schedule/tasks/${taskId}`).set("Authorization", `Bearer ${token}`).send(body);
}
function deleteTask(projectId: string, taskId: string, token = ownerAToken) {
  return request(app).delete(`/api/projects/${projectId}/schedule/tasks/${taskId}`).set("Authorization", `Bearer ${token}`);
}
function getSchedule(projectId: string, token = ownerAToken) {
  return request(app).get(`/api/projects/${projectId}/schedule`).set("Authorization", `Bearer ${token}`);
}
function createDependency(projectId: string, body: Record<string, unknown>, token = ownerAToken) {
  return request(app).post(`/api/projects/${projectId}/schedule/dependencies`).set("Authorization", `Bearer ${token}`).send(body);
}
function deleteDependency(projectId: string, dependencyId: string, token = ownerAToken) {
  return request(app).delete(`/api/projects/${projectId}/schedule/dependencies/${dependencyId}`).set("Authorization", `Bearer ${token}`);
}

function baseTask(overrides: Record<string, unknown> = {}) {
  return { name: "الحفر", startDate: "2026-01-01", endDate: "2026-01-10", ...overrides };
}

describe("Project Schedule — tasks (Phase C1)", () => {
  it("1. create task", async () => {
    const res = await createTask(projectA1Id, baseTask());
    expect(res.status).toBe(201);
    expect(res.body.name).toBe("الحفر");
    expect(res.body.taskType).toBe("task");
    expect(res.body.status).toBe("not_started");
    expect(res.body.progressPercent).toBe(0);
    expect(res.body).not.toHaveProperty("companyId");
  });

  it("2. read project tasks via the combined schedule endpoint", async () => {
    const projectId = projectA2Id;
    await createTask(projectId, baseTask({ name: "قراءة 1" }));
    await createTask(projectId, baseTask({ name: "قراءة 2" }));
    const res = await getSchedule(projectId);
    expect(res.status).toBe(200);
    expect(res.body.tasks.length).toBeGreaterThanOrEqual(2);
    expect(res.body.tasks.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(["قراءة 1", "قراءة 2"]));
    expect(res.body.dependencies).toEqual(expect.any(Array));
  });

  it("3. update task", async () => {
    const created = await createTask(projectA1Id, baseTask({ name: "قبل التحديث" }));
    const res = await updateTask(projectA1Id, created.body.id, { name: "بعد التحديث", status: "in_progress", progressPercent: 40 });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("بعد التحديث");
    expect(res.body.status).toBe("in_progress");
    expect(res.body.progressPercent).toBe(40);
  });

  it("4. delete task (owner)", async () => {
    const created = await createTask(projectA1Id, baseTask({ name: "للحذف" }));
    const res = await deleteTask(projectA1Id, created.body.id);
    expect(res.status).toBe(204);
    const schedule = await getSchedule(projectA1Id);
    expect(schedule.body.tasks.find((t: { id: string }) => t.id === created.body.id)).toBeUndefined();
  });

  it("5. create milestone", async () => {
    const res = await createTask(projectA1Id, { name: "معلم التسليم", taskType: "milestone", startDate: "2026-03-01", endDate: "2026-03-01" });
    expect(res.status).toBe(201);
    expect(res.body.taskType).toBe("milestone");
    expect(res.body.startDate).toBe(res.body.endDate);
  });

  it("6. update milestone", async () => {
    const created = await createTask(projectA1Id, { name: "معلم للتحديث", taskType: "milestone", startDate: "2026-03-05", endDate: "2026-03-05" });
    const res = await updateTask(projectA1Id, created.body.id, { startDate: "2026-03-10", endDate: "2026-03-10", status: "completed" });
    expect(res.status).toBe(200);
    expect(res.body.startDate).toBe("2026-03-10");
    expect(res.body.status).toBe("completed");
  });

  it("7. delete milestone", async () => {
    const created = await createTask(projectA1Id, { name: "معلم للحذف", taskType: "milestone", startDate: "2026-03-15", endDate: "2026-03-15" });
    const res = await deleteTask(projectA1Id, created.body.id);
    expect(res.status).toBe(204);
  });
});

describe("Project Schedule — validation (Phase C1)", () => {
  it("8. reject startDate > endDate", async () => {
    const res = await createTask(projectA1Id, baseTask({ startDate: "2026-02-01", endDate: "2026-01-01" }));
    expect(res.status).toBe(400);
  });

  it("9. reject progress < 0", async () => {
    const res = await createTask(projectA1Id, baseTask({ progressPercent: -1 }));
    expect(res.status).toBe(400);
  });

  it("10. reject progress > 100", async () => {
    const res = await createTask(projectA1Id, baseTask({ progressPercent: 101 }));
    expect(res.status).toBe(400);
  });

  it("11. milestone requires same start/end date", async () => {
    const res = await createTask(projectA1Id, { name: "معلم غير صالح", taskType: "milestone", startDate: "2026-04-01", endDate: "2026-04-05" });
    expect(res.status).toBe(400);
  });

  it("12. reject invalid (nonexistent) parent task", async () => {
    const res = await createTask(projectA1Id, baseTask({ parentTaskId: "00000000-0000-0000-0000-000000000000" }));
    expect(res.status).toBe(400);
  });

  it("13. reject parent task from another project", async () => {
    const foreignParent = await createTask(projectA2Id, baseTask({ name: "أب من مشروع آخر" }));
    const res = await createTask(projectA1Id, baseTask({ parentTaskId: foreignParent.body.id }));
    expect(res.status).toBe(400);
  });

  it("hierarchy: a valid parent in the same project is accepted, and a task cannot become its own parent on update", async () => {
    const parent = await createTask(projectA1Id, baseTask({ name: "الأعمال الترابية" }));
    const child = await createTask(projectA1Id, baseTask({ name: "الحفر الفرعي", parentTaskId: parent.body.id }));
    expect(child.status).toBe(201);
    expect(child.body.parentTaskId).toBe(parent.body.id);

    const selfParent = await updateTask(projectA1Id, parent.body.id, { parentTaskId: parent.body.id });
    expect(selfParent.status).toBe(400);

    const cycle = await updateTask(projectA1Id, parent.body.id, { parentTaskId: child.body.id });
    expect(cycle.status).toBe(400);
  });
});

describe("Project Schedule — dependencies (Phase C1)", () => {
  it("14. create FS dependency", async () => {
    const a = await createTask(projectA1Id, baseTask({ name: "سابقة" }));
    const b = await createTask(projectA1Id, baseTask({ name: "لاحقة", startDate: "2026-01-11", endDate: "2026-01-20" }));
    const res = await createDependency(projectA1Id, { predecessorTaskId: a.body.id, successorTaskId: b.body.id });
    expect(res.status).toBe(201);
    expect(res.body.dependencyType).toBe("FS");
  });

  it("15. duplicate dependency rejected", async () => {
    const a = await createTask(projectA1Id, baseTask({ name: "سابقة تكرار" }));
    const b = await createTask(projectA1Id, baseTask({ name: "لاحقة تكرار" }));
    await createDependency(projectA1Id, { predecessorTaskId: a.body.id, successorTaskId: b.body.id });
    const res = await createDependency(projectA1Id, { predecessorTaskId: a.body.id, successorTaskId: b.body.id });
    expect(res.status).toBe(409);
  });

  it("16. self dependency rejected", async () => {
    const a = await createTask(projectA1Id, baseTask({ name: "نفسها" }));
    const res = await createDependency(projectA1Id, { predecessorTaskId: a.body.id, successorTaskId: a.body.id });
    expect(res.status).toBe(400);
  });

  it("17. cross-project dependency rejected", async () => {
    const a = await createTask(projectA1Id, baseTask({ name: "من مشروع A1" }));
    const b = await createTask(projectA2Id, baseTask({ name: "من مشروع A2" }));
    const res = await createDependency(projectA1Id, { predecessorTaskId: a.body.id, successorTaskId: b.body.id });
    expect(res.status).toBe(400);
  });

  it("18. cross-tenant dependency rejected", async () => {
    const a = await createTask(projectA1Id, baseTask({ name: "من الشركة A" }));
    const b = await createTask(projectB1Id, baseTask({ name: "من الشركة B" }), ownerBToken);
    const res = await createDependency(projectA1Id, { predecessorTaskId: a.body.id, successorTaskId: b.body.id });
    expect(res.status).toBe(400);
  });

  it("19. circular dependency rejected (A→B, B→C, C→A)", async () => {
    const a = await createTask(projectA1Id, baseTask({ name: "دورة A" }));
    const b = await createTask(projectA1Id, baseTask({ name: "دورة B" }));
    const c = await createTask(projectA1Id, baseTask({ name: "دورة C" }));
    const ab = await createDependency(projectA1Id, { predecessorTaskId: a.body.id, successorTaskId: b.body.id });
    expect(ab.status).toBe(201);
    const bc = await createDependency(projectA1Id, { predecessorTaskId: b.body.id, successorTaskId: c.body.id });
    expect(bc.status).toBe(201);
    const ca = await createDependency(projectA1Id, { predecessorTaskId: c.body.id, successorTaskId: a.body.id });
    expect(ca.status).toBe(400);
  });

  it("20. delete dependency", async () => {
    const a = await createTask(projectA1Id, baseTask({ name: "حذف سابقة" }));
    const b = await createTask(projectA1Id, baseTask({ name: "حذف لاحقة" }));
    const dep = await createDependency(projectA1Id, { predecessorTaskId: a.body.id, successorTaskId: b.body.id });
    const res = await deleteDependency(projectA1Id, dep.body.id);
    expect(res.status).toBe(204);
    const schedule = await getSchedule(projectA1Id);
    expect(schedule.body.dependencies.find((d: { id: string }) => d.id === dep.body.id)).toBeUndefined();
  });

  it("21. task deletion cleans up related dependencies safely (no orphan rows)", async () => {
    const a = await createTask(projectA1Id, baseTask({ name: "مرتبطة سابقة" }));
    const b = await createTask(projectA1Id, baseTask({ name: "مرتبطة لاحقة" }));
    const dep = await createDependency(projectA1Id, { predecessorTaskId: a.body.id, successorTaskId: b.body.id });
    expect(dep.status).toBe(201);

    const del = await deleteTask(projectA1Id, a.body.id);
    expect(del.status).toBe(204);

    const orphan = await db.query.projectTaskDependencies.findFirst({ where: eq(projectTaskDependencies.id, dep.body.id) });
    expect(orphan).toBeUndefined();

    // The still-existing successor task must be unaffected.
    const schedule = await getSchedule(projectA1Id);
    expect(schedule.body.tasks.find((t: { id: string }) => t.id === b.body.id)).toBeTruthy();
  });
});

describe("Project Schedule — authorization (Phase C1)", () => {
  it("22. unauthenticated mutation rejected", async () => {
    const res = await request(app).post(`/api/projects/${projectA1Id}/schedule/tasks`).send(baseTask());
    expect(res.status).toBe(401);
  });

  it("23. unauthorized internal user (member) cannot delete a task", async () => {
    const created = await createTask(projectA1Id, baseTask({ name: "محمية من الحذف" }));
    const res = await deleteTask(projectA1Id, created.body.id, memberAToken);
    expect(res.status).toBe(403);
  });

  it("a member CAN create and update tasks (member-open, matching the task.delete/dailyLog.delete precedent)", async () => {
    const created = await createTask(projectA1Id, baseTask({ name: "من عضو" }), memberAToken);
    expect(created.status).toBe(201);
    const updated = await updateTask(projectA1Id, created.body.id, { status: "in_progress" }, memberAToken);
    expect(updated.status).toBe(200);
  });

  it("24. cross-tenant read rejected", async () => {
    const res = await getSchedule(projectA1Id, ownerBToken);
    expect(res.status).toBe(404);
  });

  it("25. cross-tenant update rejected", async () => {
    const created = await createTask(projectA1Id, baseTask({ name: "تحديث عبر المستأجرين" }));
    const res = await updateTask(projectA1Id, created.body.id, { status: "completed" }, ownerBToken);
    expect(res.status).toBe(404);
  });

  it("26. cross-tenant delete rejected", async () => {
    const created = await createTask(projectA1Id, baseTask({ name: "حذف عبر المستأجرين" }));
    const res = await deleteTask(projectA1Id, created.body.id, ownerBToken);
    expect(res.status).toBe(404);
  });

  it("27. Client Portal identity cannot mutate scheduling (different auth scope entirely, rejected before any handler runs)", async () => {
    const createRes = await createTask(projectA1Id, baseTask({ name: "من العميل" }), portalToken);
    expect(createRes.status).toBe(401);

    const readRes = await getSchedule(projectA1Id, portalToken);
    expect(readRes.status).toBe(401);
  });
});

describe("Project Schedule — audit (Phase C1)", () => {
  it("28. task creation audited", async () => {
    const created = await createTask(projectA1Id, baseTask({ name: "تدقيق الإنشاء" }));
    const event = await db.query.auditEvents.findFirst({
      where: and(eq(auditEvents.entityId, created.body.id), eq(auditEvents.action, "projectTask.created")),
    });
    expect(event).toBeTruthy();
    expect(event!.entityType).toBe("project_task");
    expect((event!.metadata as { projectId: string }).projectId).toBe(projectA1Id);
  });

  it("29. task update audited", async () => {
    const created = await createTask(projectA1Id, baseTask({ name: "تدقيق التحديث" }));
    await updateTask(projectA1Id, created.body.id, { status: "in_progress" });
    const event = await db.query.auditEvents.findFirst({
      where: and(eq(auditEvents.entityId, created.body.id), eq(auditEvents.action, "projectTask.updated")),
    });
    expect(event).toBeTruthy();
    expect((event!.beforeValue as { status: string }).status).toBe("not_started");
    expect((event!.afterValue as { status: string }).status).toBe("in_progress");
  });

  it("30. task deletion audited", async () => {
    const created = await createTask(projectA1Id, baseTask({ name: "تدقيق الحذف" }));
    await deleteTask(projectA1Id, created.body.id);
    const event = await db.query.auditEvents.findFirst({
      where: and(eq(auditEvents.entityId, created.body.id), eq(auditEvents.action, "projectTask.deleted")),
    });
    expect(event).toBeTruthy();
  });

  it("31. dependency creation and deletion audited", async () => {
    const a = await createTask(projectA1Id, baseTask({ name: "تدقيق ربط سابقة" }));
    const b = await createTask(projectA1Id, baseTask({ name: "تدقيق ربط لاحقة" }));
    const dep = await createDependency(projectA1Id, { predecessorTaskId: a.body.id, successorTaskId: b.body.id });
    const createdEvent = await db.query.auditEvents.findFirst({
      where: and(eq(auditEvents.entityId, dep.body.id), eq(auditEvents.action, "projectTaskDependency.created")),
    });
    expect(createdEvent).toBeTruthy();

    await deleteDependency(projectA1Id, dep.body.id);
    const deletedEvent = await db.query.auditEvents.findFirst({
      where: and(eq(auditEvents.entityId, dep.body.id), eq(auditEvents.action, "projectTaskDependency.deleted")),
    });
    expect(deletedEvent).toBeTruthy();
  });
});

describe("Project Schedule — Gantt data shape (Phase C1)", () => {
  it("32. hierarchy is returned correctly via parentTaskId", async () => {
    const projectId = projectA2Id;
    const parent = await createTask(projectId, baseTask({ name: "الهيكل" }));
    const child = await createTask(projectId, baseTask({ name: "الأساسات", parentTaskId: parent.body.id }));
    const res = await getSchedule(projectId);
    const childRow = res.body.tasks.find((t: { id: string }) => t.id === child.body.id);
    expect(childRow.parentTaskId).toBe(parent.body.id);
  });

  it("33. milestone returned correctly (taskType + equal dates)", async () => {
    const projectId = projectA2Id;
    const milestone = await createTask(projectId, { name: "معلم قراءة", taskType: "milestone", startDate: "2026-05-01", endDate: "2026-05-01" });
    const res = await getSchedule(projectId);
    const row = res.body.tasks.find((t: { id: string }) => t.id === milestone.body.id);
    expect(row.taskType).toBe("milestone");
    expect(row.startDate).toBe(row.endDate);
  });

  it("34. progress is returned correctly", async () => {
    const projectId = projectA2Id;
    const created = await createTask(projectId, baseTask({ name: "تقدم", progressPercent: 55 }));
    const res = await getSchedule(projectId);
    expect(res.body.tasks.find((t: { id: string }) => t.id === created.body.id).progressPercent).toBe(55);
  });

  it("35. dependencies are returned correctly in the combined response", async () => {
    const projectId = projectA2Id;
    const a = await createTask(projectId, baseTask({ name: "اعتماديات سابقة" }));
    const b = await createTask(projectId, baseTask({ name: "اعتماديات لاحقة" }));
    const dep = await createDependency(projectId, { predecessorTaskId: a.body.id, successorTaskId: b.body.id });
    const res = await getSchedule(projectId);
    const row = res.body.dependencies.find((d: { id: string }) => d.id === dep.body.id);
    expect(row.predecessorTaskId).toBe(a.body.id);
    expect(row.successorTaskId).toBe(b.body.id);
  });

  it("36. schedule read returns only the current project's tasks and dependencies", async () => {
    const resA1 = await getSchedule(projectA1Id);
    const resA2 = await getSchedule(projectA2Id);
    const a1Ids = new Set(resA1.body.tasks.map((t: { id: string }) => t.id));
    const a2Ids = new Set(resA2.body.tasks.map((t: { id: string }) => t.id));
    for (const id of a2Ids) expect(a1Ids.has(id)).toBe(false);
    expect(resA1.body.tasks.every((t: { projectId: string }) => t.projectId === projectA1Id)).toBe(true);
    expect(resA2.body.tasks.every((t: { projectId: string }) => t.projectId === projectA2Id)).toBe(true);
  });
});
