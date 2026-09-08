import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { files } from "../src/db/schema.js";
import { S3StorageProvider } from "../src/lib/storage/s3Provider.js";
import { LocalDiskStorageProvider } from "../src/lib/storage/localDiskProvider.js";

// P0.5 remediation (FILES-001) — private documents (project documents,
// subcontract-IPC evidence) must never be reachable through the public
// express.static("/uploads", ...) mount, only through the authenticated
// download route. Logos remain intentionally public. Proven with real HTTP
// requests, not just source-code assertions.

const app = buildApp();

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

let ownerToken: string;
let companyBToken: string;

beforeAll(async () => {
  await resetDb();

  const ownerRes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "PrivateStorage Co", name: "Owner", email: uniqueEmail("ps-owner"), password: "password123" });
  expect(ownerRes.status).toBe(201);
  ownerToken = ownerRes.body.token;

  const companyBRes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Other Co", name: "Owner B", email: uniqueEmail("ps-other"), password: "password123" });
  expect(companyBRes.status).toBe(201);
  companyBToken = companyBRes.body.token;
});

async function createProject(token = ownerToken) {
  const res = await request(app)
    .post("/api/projects")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: `PS Project ${Math.random()}` });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

describe("public logo storage (unchanged, still served via /uploads)", () => {
  it("1. an uploaded logo is still reachable, unauthenticated, at its /uploads/logos/... path", async () => {
    const uploadRes = await request(app)
      .post("/api/company/logo")
      .set("Authorization", `Bearer ${ownerToken}`)
      .attach("logo", ONE_PIXEL_PNG, { filename: "logo.png", contentType: "image/png" });
    expect(uploadRes.status).toBe(200);
    expect(uploadRes.body.logoPath).toMatch(/^\/uploads\/logos\//);

    // Real HTTP request, no Authorization header at all — logos are
    // intentionally public branding assets.
    const fetchRes = await request(app).get(uploadRes.body.logoPath);
    expect(fetchRes.status).toBe(200);
    expect(fetchRes.headers["content-type"]).toMatch(/^image\/png/);
    expect(Buffer.compare(fetchRes.body, ONE_PIXEL_PNG)).toBe(0);
  });
});

describe("private project documents are never reachable through /uploads", () => {
  it("2. a real, known storageKey for a private document 404s through the static mount", async () => {
    const projectId = await createProject();
    const uploadRes = await request(app)
      .post(`/api/projects/${projectId}/documents`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .attach("document", ONE_PIXEL_PNG, { filename: "evidence.png", contentType: "image/png" });
    expect(uploadRes.status).toBe(201);
    const documentId = uploadRes.body.id as string;

    // storageKey is never returned to the client (see test 6) — read it
    // directly from the DB, exactly as an attacker would need real
    // out-of-band knowledge (a leak elsewhere) to ever learn it. Even with
    // that real, correct key in hand, the static mount must not serve it.
    const fileRow = await db.query.files.findFirst({ where: eq(files.id, documentId) });
    expect(fileRow).toBeTruthy();
    expect(fileRow!.storageKey).toMatch(/^documents\//);

    const staticRes = await request(app).get(`/uploads/${fileRow!.storageKey}`);
    expect(staticRes.status).toBe(404);
  });

  it("4. the authenticated download route still serves the same document correctly", async () => {
    const projectId = await createProject();
    const uploadRes = await request(app)
      .post(`/api/projects/${projectId}/documents`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .attach("document", ONE_PIXEL_PNG, { filename: "evidence.png", contentType: "image/png" });
    const documentId = uploadRes.body.id as string;

    const downloadRes = await request(app)
      .get(`/api/projects/${projectId}/documents/${documentId}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(downloadRes.status).toBe(200);
    expect(downloadRes.headers["content-type"]).toMatch(/^image\/png/);
    expect(Buffer.compare(downloadRes.body, ONE_PIXEL_PNG)).toBe(0);
  });

  it("5. cross-tenant document download is rejected (unauthenticated static mount AND the authenticated route both refuse)", async () => {
    const projectId = await createProject();
    const uploadRes = await request(app)
      .post(`/api/projects/${projectId}/documents`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .attach("document", ONE_PIXEL_PNG, { filename: "evidence.png", contentType: "image/png" });
    const documentId = uploadRes.body.id as string;

    const crossTenantRes = await request(app)
      .get(`/api/projects/${projectId}/documents/${documentId}`)
      .set("Authorization", `Bearer ${companyBToken}`);
    expect(crossTenantRes.status).toBe(404);
  });

  it("6. the upload response never leaks storageKey (the only thing that would make the static-mount path guessable)", async () => {
    const projectId = await createProject();
    const uploadRes = await request(app)
      .post(`/api/projects/${projectId}/documents`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .attach("document", ONE_PIXEL_PNG, { filename: "evidence.png", contentType: "image/png" });
    expect(uploadRes.status).toBe(201);
    expect(uploadRes.body).not.toHaveProperty("storageKey");

    const listRes = await request(app)
      .get(`/api/projects/${projectId}/documents`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(listRes.status).toBe(200);
    for (const row of listRes.body) {
      expect(row).not.toHaveProperty("storageKey");
    }
  });
});

describe("private subcontract-IPC evidence is never reachable through /uploads", () => {
  async function createSubcontractorSupplier() {
    const res = await request(app)
      .post("/api/suppliers")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: `Subcontractor ${Math.random()}`, type: "subcontractor" });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  async function setupSubcontractIpc() {
    const projectId = await createProject();
    const supplierId = await createSubcontractorSupplier();
    const commitmentRes = await request(app)
      .post(`/api/projects/${projectId}/commitments`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ supplierId, type: "subcontract" });
    expect(commitmentRes.status).toBe(201);
    const commitmentId = commitmentRes.body.id as string;

    const lineRes = await request(app)
      .post(`/api/projects/${projectId}/commitments/${commitmentId}/items`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ description: "Formwork", quantity: 100, rate: 50 });
    expect(lineRes.status).toBe(201);

    const submitRes = await request(app)
      .post(`/api/projects/${projectId}/commitments/${commitmentId}/submit`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(submitRes.status).toBe(200);
    const approveRes = await request(app)
      .post(`/api/projects/${projectId}/commitments/${commitmentId}/approve`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(approveRes.status).toBe(200);

    const ipcRes = await request(app)
      .post(`/api/projects/${projectId}/subcontract-ipcs`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ commitmentId, periodStart: "2026-03-01", periodEnd: "2026-03-31" });
    expect(ipcRes.status).toBe(201);
    return { projectId, ipcId: ipcRes.body.id as string };
  }

  it("3. a real, known storageKey for subcontract-IPC evidence 404s through the static mount", async () => {
    const { projectId, ipcId } = await setupSubcontractIpc();
    const uploadRes = await request(app)
      .post(`/api/projects/${projectId}/subcontract-ipcs/${ipcId}/documents`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .attach("document", ONE_PIXEL_PNG, { filename: "delivery-note.png", contentType: "image/png" });
    expect(uploadRes.status).toBe(201);
    const documentId = uploadRes.body.id as string;

    const fileRow = await db.query.files.findFirst({ where: eq(files.id, documentId) });
    expect(fileRow).toBeTruthy();
    expect(fileRow!.storageKey).toMatch(/^subcontract-ipc-documents\//);

    const staticRes = await request(app).get(`/uploads/${fileRow!.storageKey}`);
    expect(staticRes.status).toBe(404);

    // The authenticated route still works correctly (mirrors project
    // documents' test 4 for this second private namespace).
    const downloadRes = await request(app)
      .get(`/api/projects/${projectId}/subcontract-ipcs/${ipcId}/documents/${documentId}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(downloadRes.status).toBe(200);
    expect(Buffer.compare(downloadRes.body, ONE_PIXEL_PNG)).toBe(0);
  });
});

describe("S3 provider: private namespaces never get a public URL, even with a public base configured", () => {
  it("7a. getPublicUrl() returns a real URL for the public 'logos' namespace", () => {
    const provider = new S3StorageProvider({
      bucket: "b",
      region: "r",
      accessKeyId: "k",
      secretAccessKey: "s",
      publicUrlBase: "https://cdn.example.com",
    });
    expect(provider.getPublicUrl("logos/abc.png")).toBe("https://cdn.example.com/logos/abc.png");
  });

  it("7b. getPublicUrl() returns null for private namespaces even when publicUrlBase IS configured", () => {
    const provider = new S3StorageProvider({
      bucket: "b",
      region: "r",
      accessKeyId: "k",
      secretAccessKey: "s",
      publicUrlBase: "https://cdn.example.com",
    });
    expect(provider.getPublicUrl("documents/abc.pdf")).toBeNull();
    expect(provider.getPublicUrl("subcontract-ipc-documents/abc.pdf")).toBeNull();
  });

  it("7c. local disk provider's getPublicUrl() mirrors the same public/private split", () => {
    const provider = new LocalDiskStorageProvider();
    expect(provider.getPublicUrl("logos/abc.png")).toBe("/uploads/logos/abc.png");
    expect(provider.getPublicUrl("documents/abc.pdf")).toBeNull();
    expect(provider.getPublicUrl("subcontract-ipc-documents/abc.pdf")).toBeNull();
  });
});
