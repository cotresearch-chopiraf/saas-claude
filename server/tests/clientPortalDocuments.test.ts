import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { eq, and } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { auditEvents, files } from "../src/db/schema.js";
import { PROJECT_DOCUMENT_ENTITY_TYPE } from "../src/routes/documents.js";

// MIDAD Phase B3 — Client Portal Documents & Visibility. A document is
// NEVER client-visible merely because it exists — every test below either
// proves the explicit clientVisible flag is the sole gate, or proves one of
// the four independent authorization conditions
// (authenticated + active project grant + document belongs to that project
// + clientVisible = true) fails closed.

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
    .send({ companyName: "B3 Docs Co A", name: "Owner A", email: uniqueEmail("b3-owner-a"), password: "password123" });
  ownerAToken = ownerARes.body.token;

  const inviteRes = await request(app)
    .post("/api/company/invites")
    .set("Authorization", `Bearer ${ownerAToken}`)
    .send({ email: uniqueEmail("b3-member-a"), role: "member" });
  const mailCall = (sendMail as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
  const inviteToken = (mailCall[2] as string).match(/token=([a-f0-9]{40,80})/)![1];
  const acceptRes = await request(app)
    .post("/api/auth/accept-invite")
    .send({ token: inviteToken, name: "Member A", password: "memberpass123" });
  memberAToken = acceptRes.body.token;

  const ownerBRes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "B3 Docs Co B", name: "Owner B", email: uniqueEmail("b3-owner-b"), password: "password123" });
  ownerBToken = ownerBRes.body.token;

  const projectA1 = await request(app).post("/api/projects").set("Authorization", `Bearer ${ownerAToken}`).send({ name: "مشروع A1" });
  projectA1Id = projectA1.body.id;
  const projectA2 = await request(app).post("/api/projects").set("Authorization", `Bearer ${ownerAToken}`).send({ name: "مشروع A2" });
  projectA2Id = projectA2.body.id;
  const projectB1 = await request(app).post("/api/projects").set("Authorization", `Bearer ${ownerBToken}`).send({ name: "مشروع B1" });
  projectB1Id = projectB1.body.id;
});

function uploadPng(projectId: string, token = ownerAToken, filename = "doc.png") {
  return request(app)
    .post(`/api/projects/${projectId}/documents`)
    .set("Authorization", `Bearer ${token}`)
    .attach("document", ONE_PIXEL_PNG, { filename, contentType: "image/png" });
}
function patchVisibility(projectId: string, documentId: string, clientVisible: boolean, token = ownerAToken) {
  return request(app)
    .patch(`/api/projects/${projectId}/documents/${documentId}`)
    .set("Authorization", `Bearer ${token}`)
    .send({ clientVisible });
}
async function createPortalUserWithGrant(projectId: string, name = "عميل المستندات"): Promise<{ id: string; portalToken: string }> {
  const email = uniqueEmail("b3-portal-client");
  const created = await request(app)
    .post("/api/client-portal-users")
    .set("Authorization", `Bearer ${ownerAToken}`)
    .send({ name, email, password: "clientpass123" });
  expect(created.status).toBe(201);
  const grant = await request(app)
    .post(`/api/client-portal-users/${created.body.id}/access`)
    .set("Authorization", `Bearer ${ownerAToken}`)
    .send({ projectId });
  expect(grant.status).toBe(201);
  const login = await request(app).post("/api/portal/auth/login").send({ email, password: "clientpass123" });
  expect(login.status).toBe(200);
  return { id: created.body.id, portalToken: login.body.token };
}
function revokeAccess(portalUserId: string, projectId: string, token = ownerAToken) {
  return request(app).post(`/api/client-portal-users/${portalUserId}/access/${projectId}/revoke`).set("Authorization", `Bearer ${token}`);
}
function listPortalDocuments(projectId: string, token: string) {
  return request(app).get(`/api/portal/projects/${projectId}/documents`).set("Authorization", `Bearer ${token}`);
}
function downloadPortalDocument(projectId: string, documentId: string, token: string) {
  return request(app).get(`/api/portal/projects/${projectId}/documents/${documentId}`).set("Authorization", `Bearer ${token}`);
}

describe("Client Portal Documents — schema/default (Phase B3)", () => {
  it("1. a newly uploaded document defaults to clientVisible=false, both in the API response and the DB row", async () => {
    const uploadRes = await uploadPng(projectA1Id);
    expect(uploadRes.status).toBe(201);
    expect(uploadRes.body.clientVisible).toBe(false);

    const row = (await db.query.files.findFirst({ where: eq(files.id, uploadRes.body.id) }))!;
    expect(row.clientVisible).toBe(false);
  });

  it("2. the column's own DB default (not application logic) is what guarantees a pre-existing row stays hidden after migration", async () => {
    // Insert a row the way a migrated pre-B3 row would have looked — no
    // clientVisible in the insert payload at all — and confirm Postgres'
    // own column default (not a server-side fallback we could forget to
    // apply) is what makes it false.
    const existing = (await db.query.files.findFirst({ where: eq(files.entityId, projectA1Id) }))!;
    const [row] = await db
      .insert(files)
      .values({
        companyId: existing.companyId,
        storageProvider: "local",
        storageKey: `documents/pre-b3-${Math.random()}`,
        fileName: "legacy.pdf",
        mimeType: "application/pdf",
        size: 1,
        uploadedBy: existing.uploadedBy,
        entityType: PROJECT_DOCUMENT_ENTITY_TYPE,
        entityId: projectA1Id,
      })
      .returning();
    expect(row.clientVisible).toBe(false);
  });
});

describe("Client Portal Documents — internal authorization (Phase B3)", () => {
  it("3. an owner (clientPortal.manage) can enable visibility", async () => {
    const uploadRes = await uploadPng(projectA1Id);
    const res = await patchVisibility(projectA1Id, uploadRes.body.id, true);
    expect(res.status).toBe(200);
    expect(res.body.clientVisible).toBe(true);
  });

  it("4. an owner can disable visibility again", async () => {
    const uploadRes = await uploadPng(projectA1Id);
    await patchVisibility(projectA1Id, uploadRes.body.id, true);
    const res = await patchVisibility(projectA1Id, uploadRes.body.id, false);
    expect(res.status).toBe(200);
    expect(res.body.clientVisible).toBe(false);
  });

  it("5. an ordinary member cannot change visibility (clientPortal.manage is owner-only)", async () => {
    const uploadRes = await uploadPng(projectA1Id);
    const res = await patchVisibility(projectA1Id, uploadRes.body.id, true, memberAToken);
    expect(res.status).toBe(403);

    const row = (await db.query.files.findFirst({ where: eq(files.id, uploadRes.body.id) }))!;
    expect(row.clientVisible).toBe(false);
  });

  it("6. a Client Portal session token cannot change visibility (different auth scope entirely — never mass-assignable from the portal)", async () => {
    const uploadRes = await uploadPng(projectA1Id);
    await patchVisibility(projectA1Id, uploadRes.body.id, true);
    const { portalToken } = await createPortalUserWithGrant(projectA1Id);
    const res = await patchVisibility(projectA1Id, uploadRes.body.id, false, portalToken);
    expect(res.status).toBe(401);

    const row = (await db.query.files.findFirst({ where: eq(files.id, uploadRes.body.id) }))!;
    expect(row.clientVisible).toBe(true);
  });
});

describe("Client Portal Documents — audit (Phase B3)", () => {
  it("7. enabling visibility creates a client_document_visibility_enabled audit event with full context", async () => {
    const uploadRes = await uploadPng(projectA1Id);
    await patchVisibility(projectA1Id, uploadRes.body.id, true);

    const event = await db.query.auditEvents.findFirst({
      where: and(eq(auditEvents.entityId, uploadRes.body.id), eq(auditEvents.action, "client_document_visibility_enabled")),
    });
    expect(event).toBeTruthy();
    expect(event!.entityType).toBe(PROJECT_DOCUMENT_ENTITY_TYPE);
    expect(event!.beforeValue).toEqual({ clientVisible: false });
    expect(event!.afterValue).toEqual({ clientVisible: true });
    expect((event!.metadata as { projectId: string }).projectId).toBe(projectA1Id);
    expect(event!.actorUserId).toBeTruthy();
  });

  it("8. disabling visibility creates a client_document_visibility_disabled audit event", async () => {
    const uploadRes = await uploadPng(projectA1Id);
    await patchVisibility(projectA1Id, uploadRes.body.id, true);
    await patchVisibility(projectA1Id, uploadRes.body.id, false);

    const event = await db.query.auditEvents.findFirst({
      where: and(eq(auditEvents.entityId, uploadRes.body.id), eq(auditEvents.action, "client_document_visibility_disabled")),
    });
    expect(event).toBeTruthy();
    expect(event!.beforeValue).toEqual({ clientVisible: true });
    expect(event!.afterValue).toEqual({ clientVisible: false });
  });

  it("9. visibility audit events never contain secrets, tokens, or credentials", async () => {
    const uploadRes = await uploadPng(projectA1Id);
    await patchVisibility(projectA1Id, uploadRes.body.id, true);

    const events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, uploadRes.body.id) });
    const dump = JSON.stringify(events).toLowerCase();
    for (const term of ["password", "token", "secret", "authorization", "credential", "apikey"]) {
      expect(dump).not.toContain(term);
    }
  });
});

describe("Client Portal Documents — portal listing (Phase B3)", () => {
  it("10. a visible document appears in the portal listing", async () => {
    const uploadRes = await uploadPng(projectA1Id, ownerAToken, "visible.png");
    await patchVisibility(projectA1Id, uploadRes.body.id, true);
    const { portalToken } = await createPortalUserWithGrant(projectA1Id);

    const res = await listPortalDocuments(projectA1Id, portalToken);
    expect(res.status).toBe(200);
    expect(res.body.some((d: { id: string }) => d.id === uploadRes.body.id)).toBe(true);
  });

  it("11. a hidden (clientVisible=false) document does not appear in the portal listing", async () => {
    const uploadRes = await uploadPng(projectA1Id, ownerAToken, "hidden.png");
    const { portalToken } = await createPortalUserWithGrant(projectA1Id);

    const res = await listPortalDocuments(projectA1Id, portalToken);
    expect(res.status).toBe(200);
    expect(res.body.some((d: { id: string }) => d.id === uploadRes.body.id)).toBe(false);
  });

  it("12. a project with a mix of visible and hidden documents returns only the visible ones", async () => {
    const projectId = projectA2Id;
    const visible1 = await uploadPng(projectId, ownerAToken, "mix-visible-1.png");
    const hidden1 = await uploadPng(projectId, ownerAToken, "mix-hidden-1.png");
    const visible2 = await uploadPng(projectId, ownerAToken, "mix-visible-2.png");
    await patchVisibility(projectId, visible1.body.id, true);
    await patchVisibility(projectId, visible2.body.id, true);
    const { portalToken } = await createPortalUserWithGrant(projectId);

    const res = await listPortalDocuments(projectId, portalToken);
    expect(res.status).toBe(200);
    const ids = res.body.map((d: { id: string }) => d.id);
    expect(ids.sort()).toEqual([visible1.body.id, visible2.body.id].sort());
    expect(ids).not.toContain(hidden1.body.id);
  });

  it("13. an unauthenticated request is rejected", async () => {
    const res = await request(app).get(`/api/portal/projects/${projectA1Id}/documents`);
    expect(res.status).toBe(401);
  });

  it("14. a project the client was never granted returns 404, not an empty/forbidden distinction", async () => {
    const { portalToken } = await createPortalUserWithGrant(projectA1Id);
    const res = await listPortalDocuments(projectA2Id, portalToken);
    expect(res.status).toBe(404);
  });
});

describe("Client Portal Documents — download (Phase B3)", () => {
  it("15. a visible document downloads successfully with valid access, real bytes returned", async () => {
    const uploadRes = await uploadPng(projectA1Id, ownerAToken, "download-ok.png");
    await patchVisibility(projectA1Id, uploadRes.body.id, true);
    const { portalToken } = await createPortalUserWithGrant(projectA1Id);

    const res = await downloadPortalDocument(projectA1Id, uploadRes.body.id, portalToken);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(Buffer.compare(res.body, ONE_PIXEL_PNG)).toBe(0);
  });

  it("16. a hidden document returns 404 on download, indistinguishable from nonexistent", async () => {
    const uploadRes = await uploadPng(projectA1Id, ownerAToken, "download-hidden.png");
    const { portalToken } = await createPortalUserWithGrant(projectA1Id);

    const res = await downloadPortalDocument(projectA1Id, uploadRes.body.id, portalToken);
    expect(res.status).toBe(404);
  });

  it("17. a document belonging to a different (ungranted) project returns 404", async () => {
    const uploadA2 = await uploadPng(projectA2Id, ownerAToken, "wrong-project.png");
    await patchVisibility(projectA2Id, uploadA2.body.id, true);
    const { portalToken } = await createPortalUserWithGrant(projectA1Id);

    const res = await downloadPortalDocument(projectA1Id, uploadA2.body.id, portalToken);
    expect(res.status).toBe(404);
  });

  it("18. a document belonging to a different tenant (company B) returns 404", async () => {
    const uploadB = await uploadPng(projectB1Id, ownerBToken, "wrong-tenant.png");
    await patchVisibility(projectB1Id, uploadB.body.id, true, ownerBToken);
    const { portalToken } = await createPortalUserWithGrant(projectA1Id);

    const res = await downloadPortalDocument(projectA1Id, uploadB.body.id, portalToken);
    expect(res.status).toBe(404);
  });

  it("19. once project access is revoked, both listing and download immediately fail with 404", async () => {
    const uploadRes = await uploadPng(projectA1Id, ownerAToken, "revoked-access.png");
    await patchVisibility(projectA1Id, uploadRes.body.id, true);
    const { id: portalUserId, portalToken } = await createPortalUserWithGrant(projectA1Id);

    const beforeRevoke = await downloadPortalDocument(projectA1Id, uploadRes.body.id, portalToken);
    expect(beforeRevoke.status).toBe(200);

    const revoke = await revokeAccess(portalUserId, projectA1Id);
    expect(revoke.status).toBe(200);

    const listAfter = await listPortalDocuments(projectA1Id, portalToken);
    expect(listAfter.status).toBe(404);
    const downloadAfter = await downloadPortalDocument(projectA1Id, uploadRes.body.id, portalToken);
    expect(downloadAfter.status).toBe(404);
  });

  it("20. an invalid/nonexistent file id returns 404", async () => {
    const { portalToken } = await createPortalUserWithGrant(projectA1Id);
    const res = await downloadPortalDocument(projectA1Id, "00000000-0000-0000-0000-000000000000", portalToken);
    expect(res.status).toBe(404);
  });

  it("visibility revoked mid-session: a document downloadable a moment ago 404s the instant clientVisible flips to false", async () => {
    const uploadRes = await uploadPng(projectA1Id, ownerAToken, "flip.png");
    await patchVisibility(projectA1Id, uploadRes.body.id, true);
    const { portalToken } = await createPortalUserWithGrant(projectA1Id);

    const before = await downloadPortalDocument(projectA1Id, uploadRes.body.id, portalToken);
    expect(before.status).toBe(200);

    await patchVisibility(projectA1Id, uploadRes.body.id, false);

    const after = await downloadPortalDocument(projectA1Id, uploadRes.body.id, portalToken);
    expect(after.status).toBe(404);
  });
});

describe("Client Portal Documents — leakage (Phase B3)", () => {
  it("21-24. the portal listing response contains no companyId, storage path/object key, uploader identifiers, or secrets", async () => {
    const uploadRes = await uploadPng(projectA1Id, ownerAToken, "leakage-check.png");
    await patchVisibility(projectA1Id, uploadRes.body.id, true);
    const { portalToken } = await createPortalUserWithGrant(projectA1Id);

    const res = await listPortalDocuments(projectA1Id, portalToken);
    expect(res.status).toBe(200);
    expect(res.body[0]).toEqual({
      id: uploadRes.body.id,
      fileName: "leakage-check.png",
      mimeType: "image/png",
      size: ONE_PIXEL_PNG.length,
      uploadedAt: expect.any(String),
    });

    const dump = JSON.stringify(res.body).toLowerCase();
    for (const forbidden of ["companyid", "storagekey", "storageprovider", "uploadedby", "uploader", "passwordhash", "token", "secret"]) {
      expect(dump).not.toContain(forbidden);
    }
  });
});

describe("Client Portal Documents — isolation (Phase B3)", () => {
  it("25. cross-tenant fileId manipulation: a Company B document id supplied to a Company A grant fails", async () => {
    const uploadB = await uploadPng(projectB1Id, ownerBToken, "cross-tenant.png");
    await patchVisibility(projectB1Id, uploadB.body.id, true, ownerBToken);
    const { portalToken } = await createPortalUserWithGrant(projectA1Id);

    const res = await downloadPortalDocument(projectA1Id, uploadB.body.id, portalToken);
    expect(res.status).toBe(404);
  });

  it("26. cross-project fileId manipulation: a same-company but ungranted project's document id fails", async () => {
    const uploadA2 = await uploadPng(projectA2Id, ownerAToken, "cross-project.png");
    await patchVisibility(projectA2Id, uploadA2.body.id, true);
    const { portalToken } = await createPortalUserWithGrant(projectA1Id);

    const res = await downloadPortalDocument(projectA1Id, uploadA2.body.id, portalToken);
    expect(res.status).toBe(404);
  });

  it("27. direct id manipulation with a well-formed but nonexistent uuid fails", async () => {
    const { portalToken } = await createPortalUserWithGrant(projectA1Id);
    const res = await downloadPortalDocument(projectA1Id, "11111111-1111-1111-1111-111111111111", portalToken);
    expect(res.status).toBe(404);
  });
});

describe("Client Portal Documents — regression (Phase B3)", () => {
  it("28-29. the existing internal document list/download APIs still work and now also carry clientVisible", async () => {
    const uploadRes = await uploadPng(projectA1Id, ownerAToken, "regression.png");
    expect(uploadRes.status).toBe(201);
    expect(uploadRes.body.clientVisible).toBe(false);

    const listRes = await request(app).get(`/api/projects/${projectA1Id}/documents`).set("Authorization", `Bearer ${ownerAToken}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.some((d: { id: string; clientVisible: boolean }) => d.id === uploadRes.body.id && d.clientVisible === false)).toBe(true);

    const downloadRes = await request(app)
      .get(`/api/projects/${projectA1Id}/documents/${uploadRes.body.id}`)
      .set("Authorization", `Bearer ${ownerAToken}`);
    expect(downloadRes.status).toBe(200);
    expect(Buffer.compare(downloadRes.body, ONE_PIXEL_PNG)).toBe(0);
  });
});
