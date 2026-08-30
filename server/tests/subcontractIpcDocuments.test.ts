import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { commitments, files, subcontractIpcs } from "../src/db/schema.js";
import { SUBCONTRACT_IPC_DOCUMENT_ENTITY_TYPE } from "../src/routes/subcontractIpcDocuments.js";
import { PROJECT_DOCUMENT_ENTITY_TYPE } from "../src/routes/documents.js";

// MIDAD Phase 3 — Subcontractor IPC Evidence. Same shared-company-per-file
// discipline as subcontractIpc.test.ts / projectDocuments.test.ts. Never
// touches financial figures — the financial-safety test below exists
// specifically to prove uploading evidence cannot perturb a certified
// IPC's frozen snapshot.

vi.mock("../src/lib/mailer.js", () => ({ sendMail: vi.fn() }));
import { sendMail } from "../src/lib/mailer.js";

const app = buildApp();

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
    .send({ companyName: "SubIPC Docs Co", name: "Owner", email: uniqueEmail("subipcdoc-owner"), password: "password123" });
  expect(ownerRes.status).toBe(201);
  ownerToken = ownerRes.body.token;

  const inviteRes = await request(app)
    .post("/api/company/invites")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ email: uniqueEmail("subipcdoc-member"), role: "member" });
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
    .send({ companyName: "Other SubIPC Docs Co", name: "Owner B", email: uniqueEmail("subipcdoc-other"), password: "password123" });
  expect(companyBRes.status).toBe(201);
  companyBToken = companyBRes.body.token;
});

async function createProject(token = ownerToken) {
  const res = await request(app)
    .post("/api/projects")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: `SubIPC Docs Project ${Math.random()}` });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function createSubcontractorSupplier() {
  const res = await request(app)
    .post("/api/suppliers")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ name: `Subcontractor ${Math.random()}`, type: "subcontractor" });
  expect(res.status).toBe(201);
  return res.body as { id: string };
}

async function createDraftSubcontractCommitment(projectId: string, supplierId: string) {
  const res = await request(app)
    .post(`/api/projects/${projectId}/commitments`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ supplierId, type: "subcontract" });
  expect(res.status).toBe(201);
  return res.body as { id: string };
}

function addCommitmentLine(projectId: string, commitmentId: string, body: Record<string, unknown>) {
  return request(app)
    .post(`/api/projects/${projectId}/commitments/${commitmentId}/items`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send(body);
}

async function submitAndApproveCommitment(projectId: string, commitmentId: string) {
  const submitRes = await request(app)
    .post(`/api/projects/${projectId}/commitments/${commitmentId}/submit`)
    .set("Authorization", `Bearer ${ownerToken}`);
  expect(submitRes.status).toBe(200);
  const approveRes = await request(app)
    .post(`/api/projects/${projectId}/commitments/${commitmentId}/approve`)
    .set("Authorization", `Bearer ${ownerToken}`);
  expect(approveRes.status).toBe(200);
}

async function setupActiveSubcontract() {
  const projectId = await createProject();
  const supplier = await createSubcontractorSupplier();
  const commitment = await createDraftSubcontractCommitment(projectId, supplier.id);
  const lineRes = await addCommitmentLine(projectId, commitment.id, { description: "Formwork", quantity: 100, rate: 50 });
  expect(lineRes.status).toBe(201);
  await submitAndApproveCommitment(projectId, commitment.id);
  return { projectId, commitmentId: commitment.id, lineId: lineRes.body.id as string };
}

function createSubcontractIpc(projectId: string, commitmentId: string, token = ownerToken) {
  return request(app)
    .post(`/api/projects/${projectId}/subcontract-ipcs`)
    .set("Authorization", `Bearer ${token}`)
    .send({ commitmentId, periodStart: "2026-03-01", periodEnd: "2026-03-31" });
}

async function setupSubcontractIpc() {
  const { projectId, commitmentId, lineId } = await setupActiveSubcontract();
  const ipcRes = await createSubcontractIpc(projectId, commitmentId);
  expect(ipcRes.status).toBe(201);
  return { projectId, commitmentId, lineId, ipcId: ipcRes.body.id as string };
}

async function setupCertifiedSubcontractIpc() {
  const { projectId, lineId, ipcId } = await setupSubcontractIpc();
  const addLineRes = await request(app)
    .post(`/api/projects/${projectId}/subcontract-ipcs/${ipcId}/items`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ commitmentLineId: lineId, currentQuantity: 20 });
  expect(addLineRes.status).toBe(201);
  const submitRes = await request(app).post(`/api/projects/${projectId}/subcontract-ipcs/${ipcId}/submit`).set("Authorization", `Bearer ${ownerToken}`);
  expect(submitRes.status).toBe(200);
  const approveRes = await request(app).post(`/api/projects/${projectId}/subcontract-ipcs/${ipcId}/approve`).set("Authorization", `Bearer ${ownerToken}`);
  expect(approveRes.status).toBe(200);
  const certifyRes = await request(app).post(`/api/projects/${projectId}/subcontract-ipcs/${ipcId}/certify`).set("Authorization", `Bearer ${ownerToken}`);
  expect(certifyRes.status).toBe(200);
  return { projectId, ipcId, certified: certifyRes.body };
}

function uploadPng(projectId: string, ipcId: string, token = ownerToken, filename = "evidence.png") {
  return request(app)
    .post(`/api/projects/${projectId}/subcontract-ipcs/${ipcId}/documents`)
    .set("Authorization", `Bearer ${token}`)
    .attach("document", ONE_PIXEL_PNG, { filename, contentType: "image/png" });
}

function listDocuments(projectId: string, ipcId: string, token = ownerToken) {
  return request(app).get(`/api/projects/${projectId}/subcontract-ipcs/${ipcId}/documents`).set("Authorization", `Bearer ${token}`);
}

function downloadDocument(projectId: string, ipcId: string, documentId: string, token = ownerToken) {
  return request(app).get(`/api/projects/${projectId}/subcontract-ipcs/${ipcId}/documents/${documentId}`).set("Authorization", `Bearer ${token}`);
}

describe("Subcontractor IPC Evidence (Phase 3)", () => {
  // --- Isolation (5) ---
  it("1. foreign company cannot list this IPC's documents -> 404", async () => {
    const { projectId, ipcId } = await setupSubcontractIpc();
    const res = await listDocuments(projectId, ipcId, companyBToken);
    expect(res.status).toBe(404);
  });

  it("2. foreign company cannot upload to this IPC -> 404", async () => {
    const { projectId, ipcId } = await setupSubcontractIpc();
    const res = await uploadPng(projectId, ipcId, companyBToken);
    expect(res.status).toBe(404);
  });

  it("3. a nonexistent IPC id -> 404, not an empty list masquerading as success", async () => {
    const { projectId } = await setupSubcontractIpc();
    const res = await listDocuments(projectId, "00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });

  it("4. an IPC id that belongs to a different project -> 404", async () => {
    const { ipcId } = await setupSubcontractIpc();
    const otherProjectId = await createProject();
    const res = await listDocuments(otherProjectId, ipcId);
    expect(res.status).toBe(404);
  });

  it("5. no cross-IPC leakage: IPC A's list never includes IPC B's documents", async () => {
    const a = await setupSubcontractIpc();
    const b = await setupSubcontractIpc();
    const uploadA = await uploadPng(a.projectId, a.ipcId, ownerToken, "a-only.png");
    expect(uploadA.status).toBe(201);
    await uploadPng(b.projectId, b.ipcId, ownerToken, "b-only.png");

    const listA = await listDocuments(a.projectId, a.ipcId);
    expect(listA.status).toBe(200);
    expect(listA.body).toHaveLength(1);
    expect(listA.body[0].id).toBe(uploadA.body.id);
  });

  // --- RBAC (3) ---
  it("6. owner can upload evidence", async () => {
    const { projectId, ipcId } = await setupSubcontractIpc();
    const res = await uploadPng(projectId, ipcId);
    expect(res.status).toBe(201);
    expect(res.body.uploadedByName).toBe("Owner");
  });

  it("7. member cannot upload evidence (subcontractIpc.manage is owner-only)", async () => {
    const { projectId, ipcId } = await setupSubcontractIpc();
    const res = await uploadPng(projectId, ipcId, memberToken);
    expect(res.status).toBe(403);
  });

  it("8. member CAN list and download evidence (read is member-open)", async () => {
    const { projectId, ipcId } = await setupSubcontractIpc();
    const uploadRes = await uploadPng(projectId, ipcId);
    expect(uploadRes.status).toBe(201);

    const listRes = await listDocuments(projectId, ipcId, memberToken);
    expect(listRes.status).toBe(200);
    expect(listRes.body).toHaveLength(1);

    const downloadRes = await downloadDocument(projectId, ipcId, uploadRes.body.id, memberToken);
    expect(downloadRes.status).toBe(200);
  });

  // --- Relationship integrity (3) ---
  it("9. an uploaded document belongs to exactly this entity type/id", async () => {
    const { projectId, ipcId } = await setupSubcontractIpc();
    const uploadRes = await uploadPng(projectId, ipcId);
    const row = (await db.query.files.findFirst({ where: eq(files.id, uploadRes.body.id) }))!;
    expect(row.entityType).toBe(SUBCONTRACT_IPC_DOCUMENT_ENTITY_TYPE);
    expect(row.entityId).toBe(ipcId);
  });

  it("10. a project document (different entityType) cannot be reached via this IPC's download route", async () => {
    const { projectId, ipcId } = await setupSubcontractIpc();
    const projDocRes = await request(app)
      .post(`/api/projects/${projectId}/documents`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .attach("document", ONE_PIXEL_PNG, { filename: "proj.png", contentType: "image/png" });
    expect(projDocRes.status).toBe(201);
    const row = (await db.query.files.findFirst({ where: eq(files.id, projDocRes.body.id) }))!;
    expect(row.entityType).toBe(PROJECT_DOCUMENT_ENTITY_TYPE);

    const res = await downloadDocument(projectId, ipcId, projDocRes.body.id);
    expect(res.status).toBe(404);
  });

  it("11. another IPC's document id cannot be downloaded through this IPC's route", async () => {
    const a = await setupSubcontractIpc();
    const b = await setupSubcontractIpc();
    const uploadB = await uploadPng(b.projectId, b.ipcId);
    expect(uploadB.status).toBe(201);

    const res = await downloadDocument(a.projectId, a.ipcId, uploadB.body.id);
    expect(res.status).toBe(404);
  });

  // --- Financial safety (1) ---
  it("12. uploading evidence to a certified IPC never changes its frozen financial snapshot", async () => {
    const { projectId, ipcId, certified } = await setupCertifiedSubcontractIpc();
    const before = { grossValue: certified.grossValue, retentionAmount: certified.retentionAmount, netCertified: certified.netCertified, status: certified.status };

    const uploadRes = await uploadPng(projectId, ipcId);
    expect(uploadRes.status).toBe(201);

    const afterRow = (await db.query.subcontractIpcs.findFirst({ where: eq(subcontractIpcs.id, ipcId) }))!;
    expect(afterRow.grossValue).toBe(before.grossValue);
    expect(afterRow.retentionAmount).toBe(before.retentionAmount);
    expect(afterRow.netCertified).toBe(before.netCertified);
    expect(afterRow.status).toBe(before.status);
  });

  // --- File policy (2) ---
  it("13. rejects an unsupported MIME type", async () => {
    const { projectId, ipcId } = await setupSubcontractIpc();
    const res = await request(app)
      .post(`/api/projects/${projectId}/subcontract-ipcs/${ipcId}/documents`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .attach("document", Buffer.from("MZ\x90\x00fake-exe"), { filename: "evil.exe", contentType: "application/x-msdownload" });
    expect(res.status).toBe(400);

    const listRes = await listDocuments(projectId, ipcId);
    expect(listRes.body).toEqual([]);
  });

  it("14. rejects an oversized file (over the 10MB limit)", async () => {
    const { projectId, ipcId } = await setupSubcontractIpc();
    const oversized = Buffer.alloc(10 * 1024 * 1024 + 1);
    const res = await request(app)
      .post(`/api/projects/${projectId}/subcontract-ipcs/${ipcId}/documents`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .attach("document", oversized, { filename: "huge.png", contentType: "image/png" });
    expect(res.status).toBe(400);
  }, 20000);

  // --- Persistence (2) ---
  it("15. upload succeeds and the document appears in the IPC's list with correct metadata; never exposes storageKey", async () => {
    const { projectId, ipcId } = await setupSubcontractIpc();
    const uploadRes = await uploadPng(projectId, ipcId, ownerToken, "site-photo.png");
    expect(uploadRes.status).toBe(201);
    expect(uploadRes.body.fileName).toBe("site-photo.png");
    expect(uploadRes.body.mimeType).toBe("image/png");
    expect(uploadRes.body.size).toBe(ONE_PIXEL_PNG.length);
    expect(uploadRes.body.version).toBe(1);
    expect(uploadRes.body).not.toHaveProperty("storageKey");

    const listRes = await listDocuments(projectId, ipcId);
    expect(listRes.status).toBe(200);
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0].id).toBe(uploadRes.body.id);
  });

  it("16. no DELETE route exists on this resource", async () => {
    const { projectId, ipcId } = await setupSubcontractIpc();
    const uploadRes = await uploadPng(projectId, ipcId);
    const res = await request(app)
      .delete(`/api/projects/${projectId}/subcontract-ipcs/${ipcId}/documents/${uploadRes.body.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(404);

    const listRes = await listDocuments(projectId, ipcId);
    expect(listRes.body).toHaveLength(1);
  });

  it("17. unauthenticated requests are rejected on every route", async () => {
    const { projectId, ipcId } = await setupSubcontractIpc();
    const listRes = await request(app).get(`/api/projects/${projectId}/subcontract-ipcs/${ipcId}/documents`);
    expect(listRes.status).toBe(401);
    const uploadRes = await request(app)
      .post(`/api/projects/${projectId}/subcontract-ipcs/${ipcId}/documents`)
      .attach("document", ONE_PIXEL_PNG, { filename: "x.png", contentType: "image/png" });
    expect(uploadRes.status).toBe(401);
  });
});
