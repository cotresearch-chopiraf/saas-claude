import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";

// P0.5 remediation — DELETE /api/projects/:id must never destroy a project
// with certified financial history (certified IPC, approved budget
// revision, or a non-cancelled commitment). Same shared-company-per-file
// discipline as ipc.test.ts/procurement.test.ts.

vi.mock("../src/lib/mailer.js", () => ({ sendMail: vi.fn() }));

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

let ownerToken: string;
let companyBToken: string;

beforeAll(async () => {
  await resetDb();

  const ownerRes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "ProjectDelete Co", name: "Owner", email: uniqueEmail("pd-owner"), password: "password123" });
  expect(ownerRes.status).toBe(201);
  ownerToken = ownerRes.body.token;

  const companyBRes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Other Co", name: "Owner B", email: uniqueEmail("pd-other"), password: "password123" });
  expect(companyBRes.status).toBe(201);
  companyBToken = companyBRes.body.token;
});

async function createProject(token = ownerToken) {
  const res = await request(app)
    .post("/api/projects")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: `PD Project ${Math.random()}` });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

function deleteProject(projectId: string, token = ownerToken) {
  return request(app).delete(`/api/projects/${projectId}`).set("Authorization", `Bearer ${token}`);
}

async function setupPublishedBoq(quantity = 100, rate = 10) {
  const projectId = await createProject();
  const contractRes = await request(app)
    .post(`/api/projects/${projectId}/contracts`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ originalValue: 50000 });
  const revRes = await request(app)
    .post(`/api/projects/${projectId}/boq-revisions`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ contractId: contractRes.body.id });
  const itemRes = await request(app)
    .post(`/api/projects/${projectId}/boq-revisions/${revRes.body.id}/items`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ description: "Excavation", unit: "m3", quantity, rate });
  const publishRes = await request(app)
    .post(`/api/projects/${projectId}/boq-revisions/${revRes.body.id}/publish`)
    .set("Authorization", `Bearer ${ownerToken}`);
  expect(publishRes.status).toBe(200);

  return {
    projectId,
    contractId: contractRes.body.id as string,
    revisionId: revRes.body.id as string,
    boqItemId: itemRes.body.id as string,
  };
}

async function approveMeasurement(projectId: string, contractId: string, revisionId: string, boqItemId: string, quantity: number) {
  const mRes = await request(app)
    .post(`/api/projects/${projectId}/measurements`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ contractId, boqRevisionId: revisionId, measurementDate: "2026-02-01" });
  await request(app)
    .post(`/api/projects/${projectId}/measurements/${mRes.body.id}/items`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ boqItemId, measuredQuantity: quantity });
  await request(app)
    .post(`/api/projects/${projectId}/measurements/${mRes.body.id}/submit`)
    .set("Authorization", `Bearer ${ownerToken}`);
  const approveRes = await request(app)
    .post(`/api/projects/${projectId}/measurements/${mRes.body.id}/approve`)
    .set("Authorization", `Bearer ${ownerToken}`);
  expect(approveRes.status).toBe(200);
}

// Builds a project all the way through a CERTIFIED IPC — the strongest of
// the three blocking conditions.
async function setupProjectWithCertifiedIpc() {
  const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq(100, 10);
  await approveMeasurement(projectId, contractId, revisionId, boqItemId, 40);

  const ipcRes = await request(app)
    .post(`/api/projects/${projectId}/ipcs`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ contractId, boqRevisionId: revisionId, periodStart: "2026-02-01", periodEnd: "2026-02-28" });
  expect(ipcRes.status).toBe(201);
  const ipcId = ipcRes.body.id as string;

  const lineRes = await request(app)
    .post(`/api/projects/${projectId}/ipcs/${ipcId}/items`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ boqItemId, currentQuantity: 30 });
  expect(lineRes.status).toBe(201);

  const submitRes = await request(app)
    .post(`/api/projects/${projectId}/ipcs/${ipcId}/submit`)
    .set("Authorization", `Bearer ${ownerToken}`);
  expect(submitRes.status).toBe(200);

  const approveRes = await request(app)
    .post(`/api/projects/${projectId}/ipcs/${ipcId}/approve`)
    .set("Authorization", `Bearer ${ownerToken}`);
  expect(approveRes.status).toBe(200);

  const certifyRes = await request(app)
    .post(`/api/projects/${projectId}/ipcs/${ipcId}/certify`)
    .set("Authorization", `Bearer ${ownerToken}`);
  expect(certifyRes.status).toBe(200);
  expect(certifyRes.body.status).toBe("certified");

  return { projectId, contractId, revisionId, boqItemId, ipcId };
}

// Builds a project with an APPROVED budget revision (no items needed —
// budgetRevisions.ts's approve() has no line-count guard).
async function setupProjectWithApprovedBudgetRevision() {
  const projectId = await createProject();
  const revRes = await request(app)
    .post(`/api/projects/${projectId}/budget-revisions`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({});
  expect(revRes.status).toBe(201);
  const revisionId = revRes.body.id as string;

  const approveRes = await request(app)
    .post(`/api/projects/${projectId}/budget-revisions/${revisionId}/approve`)
    .set("Authorization", `Bearer ${ownerToken}`);
  expect(approveRes.status).toBe(200);
  expect(approveRes.body.status).toBe("approved");

  return { projectId, revisionId };
}

async function createSupplier() {
  const res = await request(app)
    .post("/api/suppliers")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ name: `Supplier ${Math.random()}`, type: "supplier" });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

// Builds a project with a commitment left in the given status. "draft" and
// "pending_approval" stop after create/submit; "active" additionally
// approves; "cancelled" additionally cancels the draft.
async function setupProjectWithCommitment(status: "draft" | "pending_approval" | "active" | "cancelled") {
  const projectId = await createProject();
  const supplierId = await createSupplier();

  const createRes = await request(app)
    .post(`/api/projects/${projectId}/commitments`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ supplierId, type: "purchase_order" });
  expect(createRes.status).toBe(201);
  const commitmentId = createRes.body.id as string;

  if (status === "draft") return { projectId, commitmentId };

  if (status === "cancelled") {
    const cancelRes = await request(app)
      .post(`/api/projects/${projectId}/commitments/${commitmentId}/cancel`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(cancelRes.status).toBe(200);
    return { projectId, commitmentId };
  }

  const lineRes = await request(app)
    .post(`/api/projects/${projectId}/commitments/${commitmentId}/items`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ description: "Rebar", amount: 1000 });
  expect(lineRes.status).toBe(201);

  const submitRes = await request(app)
    .post(`/api/projects/${projectId}/commitments/${commitmentId}/submit`)
    .set("Authorization", `Bearer ${ownerToken}`);
  expect(submitRes.status).toBe(200);
  if (status === "pending_approval") return { projectId, commitmentId };

  const approveRes = await request(app)
    .post(`/api/projects/${projectId}/commitments/${commitmentId}/approve`)
    .set("Authorization", `Bearer ${ownerToken}`);
  expect(approveRes.status).toBe(200);
  return { projectId, commitmentId };
}

describe("DELETE /api/projects/:id — financial history guard", () => {
  it("1. an empty project can still be deleted", async () => {
    const projectId = await createProject();
    const res = await deleteProject(projectId);
    expect(res.status).toBe(204);

    const getRes = await request(app).get(`/api/projects/${projectId}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(getRes.status).toBe(404);
  });

  it("2. a project with only draft/non-financial data (draft BOQ, draft measurement) can still be deleted", async () => {
    const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq(50, 5);
    // A draft measurement (never approved) — not one of the three blocking
    // conditions, so it must not prevent deletion.
    const mRes = await request(app)
      .post(`/api/projects/${projectId}/measurements`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId, boqRevisionId: revisionId, measurementDate: "2026-02-01" });
    expect(mRes.status).toBe(201);
    await request(app)
      .post(`/api/projects/${projectId}/measurements/${mRes.body.id}/items`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ boqItemId, measuredQuantity: 10 });

    const res = await deleteProject(projectId);
    expect(res.status).toBe(204);
  });

  it("3. a project with a certified IPC cannot be deleted (409)", async () => {
    const { projectId } = await setupProjectWithCertifiedIpc();
    const res = await deleteProject(projectId);
    expect(res.status).toBe(409);
    expect(res.body.error).toBeTruthy();

    const getRes = await request(app).get(`/api/projects/${projectId}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(getRes.status).toBe(200);
  });

  it("4. a project with an approved budget revision cannot be deleted (409)", async () => {
    const { projectId } = await setupProjectWithApprovedBudgetRevision();
    const res = await deleteProject(projectId);
    expect(res.status).toBe(409);
  });

  it("5. a project with a non-cancelled (active) commitment cannot be deleted (409)", async () => {
    const { projectId } = await setupProjectWithCommitment("active");
    const res = await deleteProject(projectId);
    expect(res.status).toBe(409);
  });

  it("5b. a project with a draft commitment (non-cancelled) also cannot be deleted (409)", async () => {
    const { projectId } = await setupProjectWithCommitment("draft");
    const res = await deleteProject(projectId);
    expect(res.status).toBe(409);
  });

  it("5c. a project with a pending_approval commitment also cannot be deleted (409)", async () => {
    const { projectId } = await setupProjectWithCommitment("pending_approval");
    const res = await deleteProject(projectId);
    expect(res.status).toBe(409);
  });

  it("6. a project whose only commitment is cancelled does NOT block deletion", async () => {
    const { projectId } = await setupProjectWithCommitment("cancelled");
    const res = await deleteProject(projectId);
    expect(res.status).toBe(204);
  });

  it("7. after a rejected delete, all project data remains intact and unchanged", async () => {
    const { projectId, ipcId } = await setupProjectWithCertifiedIpc();

    const deleteRes = await deleteProject(projectId);
    expect(deleteRes.status).toBe(409);

    const projectRes = await request(app).get(`/api/projects/${projectId}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(projectRes.status).toBe(200);

    const ipcRes = await request(app)
      .get(`/api/projects/${projectId}/ipcs/${ipcId}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(ipcRes.status).toBe(200);
    expect(ipcRes.body.status).toBe("certified");
  });

  it("8. cross-tenant project delete is forbidden (404, not 409 — existence itself is not confirmed to a foreign company)", async () => {
    const { projectId } = await setupProjectWithCertifiedIpc();
    const res = await deleteProject(projectId, companyBToken);
    expect(res.status).toBe(404);

    // Confirms the project genuinely still exists — the foreign-company
    // delete attempt did nothing, it wasn't merely blocked-and-partial.
    const getRes = await request(app).get(`/api/projects/${projectId}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(getRes.status).toBe(200);
  });

  it("9. concurrent certify-vs-delete is race-safe: never both a 204 delete and a 200 certify on the same IPC", async () => {
    const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq(100, 10);
    await approveMeasurement(projectId, contractId, revisionId, boqItemId, 40);

    const ipcRes = await request(app)
      .post(`/api/projects/${projectId}/ipcs`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId, boqRevisionId: revisionId, periodStart: "2026-02-01", periodEnd: "2026-02-28" });
    const ipcId = ipcRes.body.id as string;
    await request(app)
      .post(`/api/projects/${projectId}/ipcs/${ipcId}/items`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ boqItemId, currentQuantity: 30 });
    await request(app)
      .post(`/api/projects/${projectId}/ipcs/${ipcId}/submit`)
      .set("Authorization", `Bearer ${ownerToken}`);
    await request(app)
      .post(`/api/projects/${projectId}/ipcs/${ipcId}/approve`)
      .set("Authorization", `Bearer ${ownerToken}`);
    // IPC is now "approved" — one call away from certified, and NOT yet
    // certified, so a delete request racing the certify call could
    // plausibly see "no certified IPC yet" if the guard weren't genuinely
    // race-safe.

    const [certifyRes, deleteRes] = await Promise.all([
      request(app).post(`/api/projects/${projectId}/ipcs/${ipcId}/certify`).set("Authorization", `Bearer ${ownerToken}`),
      deleteProject(projectId),
    ]);

    // The one outcome that must never happen: the IPC gets certified AND
    // the project (and thus that same certified IPC) gets deleted.
    const bothSucceeded = certifyRes.status === 200 && deleteRes.status === 204;
    expect(bothSucceeded).toBe(false);

    // Every other combination is an acceptable, safe outcome:
    // - certify wins (200), delete is rejected (409) because a certified
    //   IPC now exists — this exercises the actual race being closed.
    // - delete wins (204) before certify's approved->certified transition
    //   completes, so certify then fails because the IPC/project no
    //   longer exists (404/409).
    expect([200, 404, 409]).toContain(certifyRes.status);
    expect([204, 404, 409]).toContain(deleteRes.status);
  });
});
