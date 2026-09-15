import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { eq, and } from "drizzle-orm";

// Priority 3 (read-only-review follow-up) — closes the same class of gap
// zatcaSuccessPathAtomicity.test.ts and quoteDecisionAtomicity.test.ts
// already prove for ZATCA and public quote decisions: several mutation +
// recordAuditEvent pairs used to be two separate, independently-committed
// statements, so an audit-insert failure after a real mutation could
// leave a state change durably committed with no audit trail (or, worse
// for the invite/logo cases, simply an inconsistent state a human
// couldn't explain later). Each site below now wraps its mutation and
// audit call in one db.transaction() — this file proves the mutation
// rolls back whenever the paired audit write fails, for:
//   - company logo upload (POST /api/company/logo)
//   - company invite creation (POST /api/company/invites)
//   - company invite revocation (DELETE /api/company/invites/:id)
//   - project document upload (POST /api/projects/:id/documents)
//
// Own file — mocks lib/audit.js the same way the sibling atomicity test
// files do, failing only the four actions these routes themselves write,
// so no other suite's audit calls (including this same app's own
// unrelated calls made during setup, like registration) are affected.
const TARGET_AUDIT_ACTIONS = new Set([
  "company.logoUpdated",
  "company.memberInvited",
  "company.inviteRevoked",
  "document.uploaded",
]);
let auditFailuresRemaining = 0;
vi.mock("../src/lib/audit.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/audit.js")>("../src/lib/audit.js");
  return {
    ...actual,
    recordAuditEvent: vi.fn(async (dbOrTx: unknown, input: { action: string }) => {
      if (TARGET_AUDIT_ACTIONS.has(input.action) && auditFailuresRemaining > 0) {
        auditFailuresRemaining--;
        throw new Error("simulated audit insert failure");
      }
      return actual.recordAuditEvent(dbOrTx as never, input as never);
    }),
  };
});

vi.mock("../src/lib/mailer.js", () => ({ sendMail: vi.fn() }));

const { buildApp } = await import("../src/app.js");
const { resetDb } = await import("./setup.js");
const { db } = await import("../src/db/client.js");
const { companies, companyInvites, files, auditEvents } = await import("../src/db/schema.js");

const app = buildApp();

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

async function setupCompany(name = "Atomicity Audit Co") {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ companyName: name, name: "Owner", email: uniqueEmail("audit-atomicity-owner"), password: "password123" });
  return { token: res.body.token as string, companyId: res.body.company.id as string };
}

beforeEach(() => {
  auditFailuresRemaining = 0;
});

describe("POST /api/company/logo — atomicity (companies.logoPath update + audit event)", () => {
  beforeEach(resetDb);

  it("audit insert fails: companies.logoPath is never updated without its audit trail", async () => {
    const { token, companyId } = await setupCompany();
    const before = await db.query.companies.findFirst({ where: eq(companies.id, companyId) });

    auditFailuresRemaining = 1;
    const res = await request(app)
      .post("/api/company/logo")
      .set("Authorization", `Bearer ${token}`)
      .attach("logo", ONE_PIXEL_PNG, { filename: "logo.png", contentType: "image/png" });
    expect(res.status).toBe(500);

    const after = await db.query.companies.findFirst({ where: eq(companies.id, companyId) });
    expect(after!.logoPath).toBe(before!.logoPath);

    const events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, companyId) });
    expect(events.some((e) => e.action === "company.logoUpdated")).toBe(false);
  });

  it("normal success: logoPath updates together with its audit event", async () => {
    const { token, companyId } = await setupCompany();
    const res = await request(app)
      .post("/api/company/logo")
      .set("Authorization", `Bearer ${token}`)
      .attach("logo", ONE_PIXEL_PNG, { filename: "logo.png", contentType: "image/png" });
    expect(res.status).toBe(200);

    const after = await db.query.companies.findFirst({ where: eq(companies.id, companyId) });
    expect(after!.logoPath).toBe(res.body.logoPath);

    const events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, companyId) });
    expect(events.some((e) => e.action === "company.logoUpdated")).toBe(true);
  });
});

describe("POST /api/company/invites — atomicity (companyInvites insert + audit event)", () => {
  beforeEach(resetDb);

  it("audit insert fails: no orphaned invite row is left behind without its audit trail", async () => {
    const { token, companyId } = await setupCompany();
    const inviteEmail = uniqueEmail("invitee");

    auditFailuresRemaining = 1;
    const res = await request(app)
      .post("/api/company/invites")
      .set("Authorization", `Bearer ${token}`)
      .send({ email: inviteEmail, role: "member" });
    expect(res.status).toBe(500);

    const invite = await db.query.companyInvites.findFirst({
      where: and(eq(companyInvites.companyId, companyId), eq(companyInvites.email, inviteEmail)),
    });
    expect(invite).toBeUndefined();
  });

  it("normal success: invite row and its audit event both exist", async () => {
    const { token, companyId } = await setupCompany();
    const inviteEmail = uniqueEmail("invitee");

    const res = await request(app)
      .post("/api/company/invites")
      .set("Authorization", `Bearer ${token}`)
      .send({ email: inviteEmail, role: "member" });
    expect(res.status).toBe(201);

    const invite = await db.query.companyInvites.findFirst({
      where: and(eq(companyInvites.companyId, companyId), eq(companyInvites.email, inviteEmail)),
    });
    expect(invite).toBeDefined();

    const events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, invite!.id) });
    expect(events.some((e) => e.action === "company.memberInvited")).toBe(true);
  });
});

describe("DELETE /api/company/invites/:id — atomicity (companyInvites delete + audit event)", () => {
  beforeEach(resetDb);

  it("audit insert fails: the invite is NOT deleted when its audit trail can't be recorded", async () => {
    const { token } = await setupCompany();
    const created = await request(app)
      .post("/api/company/invites")
      .set("Authorization", `Bearer ${token}`)
      .send({ email: uniqueEmail("invitee"), role: "member" });
    expect(created.status).toBe(201);

    auditFailuresRemaining = 1;
    const res = await request(app).delete(`/api/company/invites/${created.body.id}`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(500);

    const stillThere = await db.query.companyInvites.findFirst({ where: eq(companyInvites.id, created.body.id) });
    expect(stillThere).toBeDefined();
  });
});

describe("POST /api/projects/:id/documents — atomicity (files insert + audit event)", () => {
  beforeEach(resetDb);

  it("audit insert fails: no orphaned files row is left behind without its audit trail", async () => {
    const { token } = await setupCompany();
    const project = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Atomicity Project" });
    expect(project.status).toBe(201);

    const before = await db.query.files.findMany({ where: eq(files.entityId, project.body.id) });
    expect(before.length).toBe(0);

    auditFailuresRemaining = 1;
    const res = await request(app)
      .post(`/api/projects/${project.body.id}/documents`)
      .set("Authorization", `Bearer ${token}`)
      .attach("document", ONE_PIXEL_PNG, { filename: "evidence.png", contentType: "image/png" });
    expect(res.status).toBe(500);

    const after = await db.query.files.findMany({ where: eq(files.entityId, project.body.id) });
    expect(after.length).toBe(0);
  });

  it("normal success: files row and its audit event both exist", async () => {
    const { token } = await setupCompany();
    const project = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Atomicity Project" });

    const res = await request(app)
      .post(`/api/projects/${project.body.id}/documents`)
      .set("Authorization", `Bearer ${token}`)
      .attach("document", ONE_PIXEL_PNG, { filename: "evidence.png", contentType: "image/png" });
    expect(res.status).toBe(201);

    const rows = await db.query.files.findMany({ where: eq(files.entityId, project.body.id) });
    expect(rows.length).toBe(1);

    const events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, rows[0].id) });
    expect(events.some((e) => e.action === "document.uploaded")).toBe(true);
  });
});
