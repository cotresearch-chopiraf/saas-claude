import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";

// Slice AA — Tasks/Daily Logs RBAC + audit hardening. Create/update remain
// member-open (a deliberate, pre-existing product decision — see
// lib/permissions.ts's own comment), only delete is now owner-gated,
// mirroring project.delete's precedent. Every mutation now also writes a
// real audit_events row.

vi.mock("../src/lib/mailer.js", () => ({ sendMail: vi.fn() }));
import { sendMail } from "../src/lib/mailer.js";

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

function extractToken(mailBody: string): string {
  const match = mailBody.match(/token=([a-f0-9]{64})/);
  if (!match) throw new Error(`no token found in mail body: ${mailBody}`);
  return match[1];
}

let ownerTokenA: string, memberTokenA: string, companyA: string;
let ownerTokenB: string, companyB: string;

beforeAll(async () => {
  await resetDb();

  const ownerA = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Task Co A", name: "Owner A", email: uniqueEmail("task-owner-a"), password: "password123" });
  ownerTokenA = ownerA.body.token;
  companyA = ownerA.body.company.id;

  const inviteRes = await request(app)
    .post("/api/company/invites")
    .set("Authorization", `Bearer ${ownerTokenA}`)
    .send({ email: uniqueEmail("task-member-a"), role: "member" });
  const mailCall = (sendMail as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
  const inviteToken = extractToken(mailCall[2] as string);
  const acceptRes = await request(app)
    .post("/api/auth/accept-invite")
    .send({ token: inviteToken, name: "Member A", password: "memberpass123" });
  memberTokenA = acceptRes.body.token;

  const ownerB = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Task Co B", name: "Owner B", email: uniqueEmail("task-owner-b"), password: "password123" });
  ownerTokenB = ownerB.body.token;
  companyB = ownerB.body.company.id;
});

async function createProject(token: string) {
  const res = await request(app)
    .post("/api/projects")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: `Task Project ${Math.random()}`, budgetTotal: 1000 });
  return res.body.id as string;
}

describe("Slice AA — Tasks: authorization", () => {
  it("a member can create and update a task (member-open, unchanged behavior)", async () => {
    const projectId = await createProject(ownerTokenA);
    const createRes = await request(app)
      .post(`/api/projects/${projectId}/tasks`)
      .set("Authorization", `Bearer ${memberTokenA}`)
      .send({ title: "Pour foundation" });
    expect(createRes.status).toBe(201);

    const updateRes = await request(app)
      .patch(`/api/projects/${projectId}/tasks/${createRes.body.id}`)
      .set("Authorization", `Bearer ${memberTokenA}`)
      .send({ status: "in_progress" });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.status).toBe("in_progress");
  });

  it("a member CANNOT delete a task (403) — owner-only, mirroring project.delete", async () => {
    const projectId = await createProject(ownerTokenA);
    const createRes = await request(app)
      .post(`/api/projects/${projectId}/tasks`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .send({ title: "Delete me" });

    const deleteRes = await request(app)
      .delete(`/api/projects/${projectId}/tasks/${createRes.body.id}`)
      .set("Authorization", `Bearer ${memberTokenA}`);
    expect(deleteRes.status).toBe(403);
  });

  it("an owner CAN delete a task (200/204)", async () => {
    const projectId = await createProject(ownerTokenA);
    const createRes = await request(app)
      .post(`/api/projects/${projectId}/tasks`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .send({ title: "Delete me too" });

    const deleteRes = await request(app)
      .delete(`/api/projects/${projectId}/tasks/${createRes.body.id}`)
      .set("Authorization", `Bearer ${ownerTokenA}`);
    expect(deleteRes.status).toBe(204);
  });

  it("company B cannot read, update, or delete company A's tasks (404, not leaked as 403)", async () => {
    const projectId = await createProject(ownerTokenA);
    const createRes = await request(app)
      .post(`/api/projects/${projectId}/tasks`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .send({ title: "Company A's task" });

    const listRes = await request(app)
      .get(`/api/projects/${projectId}/tasks`)
      .set("Authorization", `Bearer ${ownerTokenB}`);
    expect(listRes.status).toBe(404);

    const updateRes = await request(app)
      .patch(`/api/projects/${projectId}/tasks/${createRes.body.id}`)
      .set("Authorization", `Bearer ${ownerTokenB}`)
      .send({ status: "done" });
    expect(updateRes.status).toBe(404);

    const deleteRes = await request(app)
      .delete(`/api/projects/${projectId}/tasks/${createRes.body.id}`)
      .set("Authorization", `Bearer ${ownerTokenB}`);
    expect(deleteRes.status).toBe(404);
  });
});

describe("Slice AA — Tasks: audit trail", () => {
  it("create, update, and delete each write a real audit_events row", async () => {
    const projectId = await createProject(ownerTokenA);
    const createRes = await request(app)
      .post(`/api/projects/${projectId}/tasks`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .send({ title: "Audited task" });
    const taskId = createRes.body.id as string;

    await request(app)
      .patch(`/api/projects/${projectId}/tasks/${taskId}`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .send({ status: "in_progress" });

    await request(app)
      .delete(`/api/projects/${projectId}/tasks/${taskId}`)
      .set("Authorization", `Bearer ${ownerTokenA}`);

    const auditRes = await request(app)
      .get(`/api/audit-events?entityType=task&limit=50`)
      .set("Authorization", `Bearer ${ownerTokenA}`);
    expect(auditRes.status).toBe(200);
    const actions = auditRes.body.events
      .filter((e: { entityId: string }) => e.entityId === taskId)
      .map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["task.created", "task.updated", "task.deleted"]));
  });
});

describe("Slice AA — Daily Logs: authorization", () => {
  it("a member can create a daily log (member-open, unchanged behavior)", async () => {
    const projectId = await createProject(ownerTokenA);
    const res = await request(app)
      .post(`/api/projects/${projectId}/daily-logs`)
      .set("Authorization", `Bearer ${memberTokenA}`)
      .send({ note: "Poured slab", logDate: "2026-01-15" });
    expect(res.status).toBe(201);
  });

  it("a member CANNOT delete a daily log (403) — owner-only", async () => {
    const projectId = await createProject(ownerTokenA);
    const createRes = await request(app)
      .post(`/api/projects/${projectId}/daily-logs`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .send({ note: "Delete me", logDate: "2026-01-15" });

    const deleteRes = await request(app)
      .delete(`/api/projects/${projectId}/daily-logs/${createRes.body.id}`)
      .set("Authorization", `Bearer ${memberTokenA}`);
    expect(deleteRes.status).toBe(403);
  });

  it("an owner CAN delete a daily log (204)", async () => {
    const projectId = await createProject(ownerTokenA);
    const createRes = await request(app)
      .post(`/api/projects/${projectId}/daily-logs`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .send({ note: "Delete me too", logDate: "2026-01-15" });

    const deleteRes = await request(app)
      .delete(`/api/projects/${projectId}/daily-logs/${createRes.body.id}`)
      .set("Authorization", `Bearer ${ownerTokenA}`);
    expect(deleteRes.status).toBe(204);
  });

  it("company B cannot read or delete company A's daily logs (404)", async () => {
    const projectId = await createProject(ownerTokenA);
    const createRes = await request(app)
      .post(`/api/projects/${projectId}/daily-logs`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .send({ note: "Company A's log", logDate: "2026-01-15" });

    const listRes = await request(app)
      .get(`/api/projects/${projectId}/daily-logs`)
      .set("Authorization", `Bearer ${ownerTokenB}`);
    expect(listRes.status).toBe(404);

    const deleteRes = await request(app)
      .delete(`/api/projects/${projectId}/daily-logs/${createRes.body.id}`)
      .set("Authorization", `Bearer ${ownerTokenB}`);
    expect(deleteRes.status).toBe(404);
  });
});

describe("Slice AA — Daily Logs: audit trail", () => {
  it("create and delete each write a real audit_events row", async () => {
    const projectId = await createProject(ownerTokenA);
    const createRes = await request(app)
      .post(`/api/projects/${projectId}/daily-logs`)
      .set("Authorization", `Bearer ${ownerTokenA}`)
      .send({ note: "Audited log", logDate: "2026-01-15" });
    const logId = createRes.body.id as string;

    await request(app)
      .delete(`/api/projects/${projectId}/daily-logs/${logId}`)
      .set("Authorization", `Bearer ${ownerTokenA}`);

    const auditRes = await request(app)
      .get(`/api/audit-events?entityType=dailyLog&limit=50`)
      .set("Authorization", `Bearer ${ownerTokenA}`);
    expect(auditRes.status).toBe(200);
    const actions = auditRes.body.events
      .filter((e: { entityId: string }) => e.entityId === logId)
      .map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["dailyLog.created", "dailyLog.deleted"]));
  });
});

// companyB is referenced only to prove it exists as a distinct tenant for
// the isolation tests above; this keeps the linter/typechecker satisfied
// without an unused-variable warning if that assertion set changes later.
void companyA;
void companyB;
