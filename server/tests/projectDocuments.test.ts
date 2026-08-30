import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { files } from "../src/db/schema.js";
import { eq } from "drizzle-orm";
import fs from "node:fs";
import path from "node:path";
import { storageRoot } from "../src/lib/storage/localDiskProvider.js";
import { PROJECT_DOCUMENT_ENTITY_TYPE } from "../src/routes/documents.js";

// MIDAD UI-10 — project-scoped Documents. Closes the gap the existing
// storage abstraction (lib/storage/files.ts, previously exercised only by
// company-logo upload) left open: no project-document route, no
// authorization model, no MIME/size policy, no tests. Same shared-
// company-per-file discipline as projectInvoices.test.ts / ipc.test.ts.

vi.mock("../src/lib/mailer.js", () => ({ sendMail: vi.fn() }));
import { sendMail } from "../src/lib/mailer.js";

const app = buildApp();

// A minimal, valid 1x1 PNG — same fixture storage.test.ts already uses, so
// multer's real fileFilter/memoryStorage and Node's real file I/O are
// exercised, not a stub.
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

let ownerToken: string;
let memberToken: string;
let companyBToken: string;

beforeAll(async () => {
  await resetDb();

  const ownerRes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Docs Test Co", name: "Owner", email: uniqueEmail("doc-owner"), password: "password123" });
  expect(ownerRes.status).toBe(201);
  ownerToken = ownerRes.body.token;

  const inviteRes = await request(app)
    .post("/api/company/invites")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ email: uniqueEmail("doc-member"), role: "member" });
  expect(inviteRes.status).toBe(201);
  const mailCall = (sendMail as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
  const inviteToken = (mailCall[2] as string).match(/token=([a-f0-9]{40,80})/)![1];
  const acceptRes = await request(app)
    .post("/api/auth/accept-invite")
    .send({ token: inviteToken, name: "Member", password: "memberpass123" });
  expect(acceptRes.status).toBe(201);
  memberToken = acceptRes.body.token;

  const companyBRes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Other Docs Co", name: "Owner B", email: uniqueEmail("doc-other"), password: "password123" });
  expect(companyBRes.status).toBe(201);
  companyBToken = companyBRes.body.token;
});

async function createProject(token = ownerToken) {
  const res = await request(app)
    .post("/api/projects")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: `Docs Project ${Math.random()}` });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

function uploadPng(projectId: string, token = ownerToken, filename = "evidence.png") {
  return request(app)
    .post(`/api/projects/${projectId}/documents`)
    .set("Authorization", `Bearer ${token}`)
    .attach("document", ONE_PIXEL_PNG, { filename, contentType: "image/png" });
}

function listDocuments(projectId: string, token = ownerToken) {
  return request(app).get(`/api/projects/${projectId}/documents`).set("Authorization", `Bearer ${token}`);
}

function downloadDocument(projectId: string, documentId: string, token = ownerToken) {
  return request(app).get(`/api/projects/${projectId}/documents/${documentId}`).set("Authorization", `Bearer ${token}`);
}

describe("Project Documents (UI-10)", () => {
  it("1. authenticated owner can list a project's documents (empty initially)", async () => {
    const projectId = await createProject();
    const res = await listDocuments(projectId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("2. project ownership: a nonexistent project returns 404, not an empty list masquerading as success", async () => {
    const res = await listDocuments("00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });

  it("3. tenant isolation: another company's token cannot list this project's documents", async () => {
    const projectId = await createProject();
    const res = await listDocuments(projectId, companyBToken);
    expect(res.status).toBe(404);
  });

  it("4. foreign project returns a safe failure on upload too, not a silent misfile", async () => {
    const res = await request(app)
      .post("/api/projects/00000000-0000-0000-0000-000000000000/documents")
      .set("Authorization", `Bearer ${ownerToken}`)
      .attach("document", ONE_PIXEL_PNG, { filename: "x.png", contentType: "image/png" });
    expect(res.status).toBe(404);
  });

  it("6. upload succeeds and the document appears in the project's list with correct metadata", async () => {
    const projectId = await createProject();
    const uploadRes = await uploadPng(projectId, ownerToken, "site-photo.png");
    expect(uploadRes.status).toBe(201);
    expect(uploadRes.body.fileName).toBe("site-photo.png");
    expect(uploadRes.body.mimeType).toBe("image/png");
    expect(uploadRes.body.size).toBe(ONE_PIXEL_PNG.length);
    expect(uploadRes.body.uploadedByName).toBe("Owner");
    expect(uploadRes.body.version).toBe(1);
    expect(uploadRes.body).not.toHaveProperty("storageKey");

    const listRes = await listDocuments(projectId);
    expect(listRes.status).toBe(200);
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0].id).toBe(uploadRes.body.id);
  });

  it("7. rejects an unsupported MIME type", async () => {
    const projectId = await createProject();
    const res = await request(app)
      .post(`/api/projects/${projectId}/documents`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .attach("document", Buffer.from("MZ\x90\x00fake-exe"), { filename: "evil.exe", contentType: "application/x-msdownload" });
    expect(res.status).toBe(400);

    const listRes = await listDocuments(projectId);
    expect(listRes.body).toEqual([]);
  });

  it("8. rejects an oversized file (over the 10MB limit)", async () => {
    const projectId = await createProject();
    const oversized = Buffer.alloc(10 * 1024 * 1024 + 1);
    const res = await request(app)
      .post(`/api/projects/${projectId}/documents`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .attach("document", oversized, { filename: "huge.png", contentType: "image/png" });
    expect(res.status).toBe(400);
  }, 20000);

  it("9. safe filename handling: a path-traversal-styled filename never escapes the storage root", async () => {
    const projectId = await createProject();
    const res = await uploadPng(projectId, ownerToken, "../../../../etc/passwd.png");
    expect(res.status).toBe(201);
    // The multipart layer itself (matching real <input type="file"> browser
    // behavior) already strips any path portion before our code ever sees
    // it — only the basename survives as the display filename.
    expect(res.body.fileName).toBe("passwd.png");
    expect(res.body.fileName).not.toContain("..");

    // Regardless, the actual on-disk storage key is always a fresh
    // namespace/uuid the server generated itself, never derived from the
    // client-supplied name at all — confirmed by reading the row directly
    // and checking it resolves safely inside storageRoot.
    const row = (await db.query.files.findFirst({ where: eq(files.id, res.body.id) }))!;
    expect(row.storageKey.startsWith("documents/")).toBe(true);
    expect(row.storageKey).not.toContain("..");
    const resolved = path.resolve(storageRoot, row.storageKey);
    expect(resolved.startsWith(storageRoot)).toBe(true);
    expect(fs.existsSync(resolved)).toBe(true);
  });

  it("10. unauthenticated requests are rejected on every route", async () => {
    const projectId = await createProject();
    const listRes = await request(app).get(`/api/projects/${projectId}/documents`);
    expect(listRes.status).toBe(401);
    const uploadRes = await request(app)
      .post(`/api/projects/${projectId}/documents`)
      .attach("document", ONE_PIXEL_PNG, { filename: "x.png", contentType: "image/png" });
    expect(uploadRes.status).toBe(401);
  });

  it("11. authorization: a member can both list and upload (evidence entry is member-open, matching Measurement/dailyLogs precedent)", async () => {
    const projectId = await createProject();
    const uploadRes = await uploadPng(projectId, memberToken, "member-upload.png");
    expect(uploadRes.status).toBe(201);
    expect(uploadRes.body.uploadedByName).toBe("Member");

    const listRes = await listDocuments(projectId, memberToken);
    expect(listRes.status).toBe(200);
    expect(listRes.body).toHaveLength(1);
  });

  it("12. an uploaded document belongs to exactly the entity type/id it was uploaded for", async () => {
    const projectId = await createProject();
    const uploadRes = await uploadPng(projectId);
    const row = (await db.query.files.findFirst({ where: eq(files.id, uploadRes.body.id) }))!;
    expect(row.entityType).toBe(PROJECT_DOCUMENT_ENTITY_TYPE);
    expect(row.entityId).toBe(projectId);
  });

  it("13. no cross-project leakage: project A's list never includes project B's documents", async () => {
    const projectA = await createProject();
    const projectB = await createProject();
    const uploadA = await uploadPng(projectA, ownerToken, "a-only.png");
    await uploadPng(projectB, ownerToken, "b-only.png");

    const listA = await listDocuments(projectA);
    expect(listA.status).toBe(200);
    expect(listA.body).toHaveLength(1);
    expect(listA.body[0].id).toBe(uploadA.body.id);
  });

  it("14. storage service interaction: checksum and size are genuinely recorded by the storage layer, not fabricated", async () => {
    const projectId = await createProject();
    const uploadRes = await uploadPng(projectId);
    const row = (await db.query.files.findFirst({ where: eq(files.id, uploadRes.body.id) }))!;
    expect(row.checksum).toBeTruthy();
    expect(row.storageProvider).toBe("local");
    expect(row.size).toBe(ONE_PIXEL_PNG.length);
  });

  it("5 / 15. a foreign project's document id cannot be downloaded, and neither can a same-company file of a different entity type (e.g. a company logo)", async () => {
    const projectA = await createProject();
    const projectB = await createProject();
    const uploadA = await uploadPng(projectA);

    // Wrong project in the URL, even though the document and the caller
    // both belong to the same company.
    const wrongProject = await downloadDocument(projectB, uploadA.body.id);
    expect(wrongProject.status).toBe(404);

    // A same-company logo upload must never be reachable via the
    // project-documents download route (different entityType).
    const logoRes = await request(app)
      .post("/api/company/logo")
      .set("Authorization", `Bearer ${ownerToken}`)
      .attach("logo", ONE_PIXEL_PNG, { filename: "logo.png", contentType: "image/png" });
    expect(logoRes.status).toBe(200);
    const logoRow = (await db.query.files.findFirst({ where: eq(files.entityType, "company_logo") }))!;
    const logoViaDocsRoute = await downloadDocument(projectA, logoRow.id);
    expect(logoViaDocsRoute.status).toBe(404);

    // Correct project + correct document: succeeds, real bytes returned.
    const okRes = await downloadDocument(projectA, uploadA.body.id);
    expect(okRes.status).toBe(200);
    expect(okRes.headers["content-type"]).toBe("image/png");
    expect(Buffer.compare(okRes.body, ONE_PIXEL_PNG)).toBe(0);

    // Another company entirely cannot download it either.
    const foreignCompanyRes = await downloadDocument(projectA, uploadA.body.id, companyBToken);
    expect(foreignCompanyRes.status).toBe(404);
  });

  it("15. deletion is intentionally not implemented — no DELETE route exists on this resource", async () => {
    const projectId = await createProject();
    const uploadRes = await uploadPng(projectId);
    const res = await request(app)
      .delete(`/api/projects/${projectId}/documents/${uploadRes.body.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    // Express reports an unmatched method on a router as 404, not 405 —
    // this simply confirms no delete handler was ever wired up.
    expect(res.status).toBe(404);

    const listRes = await listDocuments(projectId);
    expect(listRes.body).toHaveLength(1);
  });
});
