import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { platformOperators, companies, users, projects } from "../src/db/schema.js";
import { hashPassword } from "../src/lib/password.js";

// MIDAD Final Pre-Launch audit, Phase 10-11 — Tenant Export / Import.
// Export -> Validate/Preview/Conflict-Detection -> Explicit Confirmation
// -> Import -> Verification -> Audit, all against a real Postgres, no
// mocking of the database layer.

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

async function registerCompanyWithData(name: string) {
  const reg = await request(app)
    .post("/api/auth/register")
    .send({ companyName: name, name: "Owner", email: uniqueEmail("td-owner"), password: "password123" });
  expect(reg.status).toBe(201);
  const token = reg.body.token as string;
  const companyId = reg.body.company.id as string;

  const project = await request(app).post("/api/projects").set("Authorization", `Bearer ${token}`).send({ name: "Test Project" });
  expect(project.status).toBe(201);
  const projectId = project.body.id as string;

  const task = await request(app)
    .post(`/api/projects/${projectId}/tasks`)
    .set("Authorization", `Bearer ${token}`)
    .send({ title: "Site inspection" });
  expect(task.status).toBe(201);

  return { token, companyId, projectId };
}

async function createOperatorToken(role: "platform_owner" | "platform_admin" | "support" | "compliance" | "auditor" = "platform_owner") {
  const email = uniqueEmail(`td-${role}`);
  await db.insert(platformOperators).values({ email, name: role, role, passwordHash: await hashPassword("operatorpass123") });
  const login = await request(app).post("/api/platform/auth/login").send({ email, password: "operatorpass123" });
  expect(login.status).toBe(200);
  return login.body.token as string;
}

beforeEach(resetDb);

describe("tenant export: auth boundary", () => {
  it("unauthenticated and tenant-JWT access are rejected", async () => {
    const { token, companyId } = await registerCompanyWithData("Co A");
    expect((await request(app).post(`/api/platform/organizations/${companyId}/export`)).status).toBe(401);
    expect((await request(app).post(`/api/platform/organizations/${companyId}/export`).set("Authorization", `Bearer ${token}`)).status).toBe(401);
  });

  it("is denied for support, compliance, and auditor roles", async () => {
    const { companyId } = await registerCompanyWithData("Co A");
    for (const role of ["support", "compliance", "auditor"] as const) {
      const opToken = await createOperatorToken(role);
      const res = await request(app).post(`/api/platform/organizations/${companyId}/export`).set("Authorization", `Bearer ${opToken}`);
      expect(res.status).toBe(403);
    }
  });
});

describe("tenant export: content", () => {
  it("exports the company and its real data, with row counts and a checksum", async () => {
    const { companyId, projectId } = await registerCompanyWithData("Riyadh Export Co");
    const opToken = await createOperatorToken();

    const res = await request(app).post(`/api/platform/organizations/${companyId}/export`).set("Authorization", `Bearer ${opToken}`);
    expect(res.status).toBe(200);
    expect(res.body.manifest.companyId).toBe(companyId);
    expect(res.body.manifest.companyName).toBe("Riyadh Export Co");
    expect(res.body.manifest.tableRowCounts.users).toBe(1);
    expect(res.body.manifest.tableRowCounts.projects).toBe(1);
    expect(res.body.manifest.tableRowCounts.tasks).toBe(1);
    expect(res.body.manifest.checksumSha256).toBeTruthy();
    expect(res.body.manifest.includesDocumentBytes).toBe(false);
    expect(res.body.tables.projects[0].id).toBe(projectId);
  });

  it("redacts password hashes and never leaks them", async () => {
    const { companyId } = await registerCompanyWithData("Co A");
    const opToken = await createOperatorToken();
    const res = await request(app).post(`/api/platform/organizations/${companyId}/export`).set("Authorization", `Bearer ${opToken}`);
    // The manifest's OWN redactedColumns field legitimately mentions the
    // string "password_hash" as documentation of what was redacted — only
    // the actual exported row data must never contain a real hash value.
    expect(JSON.stringify(res.body.tables.users)).not.toMatch(/password_hash|\$2[aby]\$/i);
    expect(res.body.tables.users[0].password_hash).toBeUndefined();
  });

  it("a nonexistent company returns 404", async () => {
    const opToken = await createOperatorToken();
    const res = await request(app)
      .post(`/api/platform/organizations/00000000-0000-0000-0000-000000000000/export`)
      .set("Authorization", `Bearer ${opToken}`);
    expect(res.status).toBe(404);
  });
});

describe("tenant import: validate (side-effect-free)", () => {
  it("reports canImport: true once the original company no longer exists in this database", async () => {
    const { companyId } = await registerCompanyWithData("Co A");
    const opToken = await createOperatorToken();
    const exportRes = await request(app).post(`/api/platform/organizations/${companyId}/export`).set("Authorization", `Bearer ${opToken}`);

    // Still exists: canImport is correctly false, blocked on the id conflict.
    const beforeDelete = await request(app)
      .post(`/api/platform/tenant-import/validate`)
      .set("Authorization", `Bearer ${opToken}`)
      .send({ bundle: exportRes.body });
    expect(beforeDelete.body.checksumValid).toBe(true);
    expect(beforeDelete.body.companyIdAlreadyExists).toBe(true);
    expect(beforeDelete.body.canImport).toBe(false);

    await db.delete(companies).where(eq(companies.id, companyId));

    const afterDelete = await request(app)
      .post(`/api/platform/tenant-import/validate`)
      .set("Authorization", `Bearer ${opToken}`)
      .send({ bundle: exportRes.body });
    expect(afterDelete.status).toBe(200);
    expect(afterDelete.body.canImport).toBe(true);
    expect(afterDelete.body.checksumValid).toBe(true);
    expect(afterDelete.body.companyIdAlreadyExists).toBe(false);
  });

  it("detects a tampered checksum", async () => {
    const { companyId } = await registerCompanyWithData("Co A");
    const opToken = await createOperatorToken();
    const exportRes = await request(app).post(`/api/platform/organizations/${companyId}/export`).set("Authorization", `Bearer ${opToken}`);

    const tampered = { ...exportRes.body, manifest: { ...exportRes.body.manifest, checksumSha256: "0".repeat(64) } };
    const validateRes = await request(app)
      .post(`/api/platform/tenant-import/validate`)
      .set("Authorization", `Bearer ${opToken}`)
      .send({ bundle: tampered });
    expect(validateRes.body.checksumValid).toBe(false);
    expect(validateRes.body.canImport).toBe(false);
  });

  it("validate is denied for non-owner/admin roles", async () => {
    const { companyId } = await registerCompanyWithData("Co A");
    const opToken = await createOperatorToken();
    const exportRes = await request(app).post(`/api/platform/organizations/${companyId}/export`).set("Authorization", `Bearer ${opToken}`);

    const auditorToken = await createOperatorToken("auditor");
    const res = await request(app)
      .post(`/api/platform/tenant-import/validate`)
      .set("Authorization", `Bearer ${auditorToken}`)
      .send({ bundle: exportRes.body });
    expect(res.status).toBe(403);
  });
});

describe("tenant import: confirm (round trip)", () => {
  it("requires the confirmation company name to match exactly", async () => {
    const { companyId } = await registerCompanyWithData("Co A");
    const opToken = await createOperatorToken();
    const exportRes = await request(app).post(`/api/platform/organizations/${companyId}/export`).set("Authorization", `Bearer ${opToken}`);

    const res = await request(app)
      .post(`/api/platform/tenant-import/confirm`)
      .set("Authorization", `Bearer ${opToken}`)
      .send({ bundle: exportRes.body, confirmationCompanyName: "Wrong Name" });
    expect(res.status).toBe(400);
  });

  it("refuses to import when the company id already exists (this exact same database)", async () => {
    const { companyId } = await registerCompanyWithData("Co A");
    const opToken = await createOperatorToken();
    const exportRes = await request(app).post(`/api/platform/organizations/${companyId}/export`).set("Authorization", `Bearer ${opToken}`);

    const res = await request(app)
      .post(`/api/platform/tenant-import/confirm`)
      .set("Authorization", `Bearer ${opToken}`)
      .send({ bundle: exportRes.body, confirmationCompanyName: "Co A" });
    expect(res.status).toBe(409);
    expect(res.body.blockers).toContain("company_id_already_exists");
  });

  it("a full export -> delete -> import round trip restores the company and its data byte-for-byte, and is audited", async () => {
    const { companyId, projectId } = await registerCompanyWithData("Round Trip Co");
    const opToken = await createOperatorToken();

    const exportRes = await request(app).post(`/api/platform/organizations/${companyId}/export`).set("Authorization", `Bearer ${opToken}`);
    expect(exportRes.status).toBe(200);

    // Simulate a disaster-recovery scenario: the tenant no longer exists
    // in this database (CASCADE removes every dependent row too).
    await db.delete(companies).where(eq(companies.id, companyId));
    expect(await db.query.companies.findFirst({ where: eq(companies.id, companyId) })).toBeUndefined();

    const confirmRes = await request(app)
      .post(`/api/platform/tenant-import/confirm`)
      .set("Authorization", `Bearer ${opToken}`)
      .send({ bundle: exportRes.body, confirmationCompanyName: "Round Trip Co" });
    expect(confirmRes.status).toBe(201);
    expect(confirmRes.body.verified).toBe(true);
    expect(confirmRes.body.passwordResetRequiredForImportedUsers).toBe(true);
    expect(confirmRes.body.importedTableRowCounts.projects).toBe(1);
    expect(confirmRes.body.importedTableRowCounts.tasks).toBe(1);

    const restoredCompany = await db.query.companies.findFirst({ where: eq(companies.id, companyId) });
    expect(restoredCompany?.name).toBe("Round Trip Co");
    const restoredUsers = await db.query.users.findMany({ where: eq(users.companyId, companyId) });
    expect(restoredUsers).toHaveLength(1);

    // The imported user's original password no longer works (a fresh,
    // unknown hash was generated — see lib/tenantImport.ts's
    // withFreshPasswordHashes) — "forgot password" is required.
    const loginWithOldPassword = await request(app)
      .post("/api/auth/login")
      .send({ email: restoredUsers[0].email, password: "password123" });
    expect(loginWithOldPassword.status).toBe(401);

    const restoredProjects = await db.query.projects.findMany({ where: eq(projects.companyId, companyId) });
    expect(restoredProjects).toHaveLength(1);
    expect(restoredProjects[0].id).toBe(projectId);

    const events = await db.query.auditEvents.findMany({
      where: (e, { and: a, eq: eqOp }) => a(eqOp(e.companyId, companyId), eqOp(e.action, "tenant.imported")),
    });
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe("platform_admin");
  });

  it("confirm is denied for non-owner/admin roles", async () => {
    const { companyId } = await registerCompanyWithData("Co A");
    const opToken = await createOperatorToken();
    const exportRes = await request(app).post(`/api/platform/organizations/${companyId}/export`).set("Authorization", `Bearer ${opToken}`);
    await db.delete(companies).where(eq(companies.id, companyId));

    const supportToken = await createOperatorToken("support");
    const res = await request(app)
      .post(`/api/platform/tenant-import/confirm`)
      .set("Authorization", `Bearer ${supportToken}`)
      .send({ bundle: exportRes.body, confirmationCompanyName: "Co A" });
    expect(res.status).toBe(403);
  });
});
