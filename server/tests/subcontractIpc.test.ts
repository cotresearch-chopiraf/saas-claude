import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { commitmentLines, commitments } from "../src/db/schema.js";

// MIDAD Phase 2 — Subcontractor IPC. A completely separate certification
// ledger from Owner IPC (server/tests/ipc.test.ts) — see
// server/src/routes/subcontractIpcs.ts's own header comment for the full
// architectural reasoning. Same shared-company-per-file discipline as
// ipc.test.ts / procurement.test.ts.

vi.mock("../src/lib/mailer.js", () => ({ sendMail: vi.fn() }));
import { sendMail } from "../src/lib/mailer.js";

const app = buildApp();

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
    .send({ companyName: "SubIPC Co", name: "Owner", email: uniqueEmail("subipc-owner"), password: "password123" });
  expect(ownerRes.status).toBe(201);
  ownerToken = ownerRes.body.token;

  const inviteRes = await request(app)
    .post("/api/company/invites")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ email: uniqueEmail("subipc-member"), role: "member" });
  expect(inviteRes.status).toBe(201);
  const mailCall = (sendMail as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
  const inviteToken = (mailCall[2] as string).match(/token=([a-f0-9]{64})/)![1];
  const acceptRes = await request(app)
    .post("/api/auth/accept-invite")
    .send({ token: inviteToken, name: "Member", password: "memberpass123" });
  expect(acceptRes.status).toBe(201);
  memberToken = acceptRes.body.token;

  const companyBRes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Other SubIPC Co", name: "Owner B", email: uniqueEmail("subipc-other"), password: "password123" });
  expect(companyBRes.status).toBe(201);
  companyBToken = companyBRes.body.token;
});

async function createProject(token = ownerToken) {
  const res = await request(app)
    .post("/api/projects")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: `SubIPC Project ${Math.random()}` });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function createSubcontractorSupplier() {
  const res = await request(app)
    .post("/api/suppliers")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ name: `Subcontractor ${Math.random()}`, type: "subcontractor" });
  expect(res.status).toBe(201);
  return res.body as { id: string; name: string };
}

async function createDraftSubcontractCommitment(projectId: string, supplierId: string) {
  const res = await request(app)
    .post(`/api/projects/${projectId}/commitments`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ supplierId, type: "subcontract" });
  expect(res.status).toBe(201);
  return res.body as { id: string; commitment_number: number; status: string };
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
  return approveRes.body as { id: string; status: string };
}

// Full setup: subcontractor supplier -> active subcontract commitment with
// one quantity/rate line and one amount-only line.
async function setupActiveSubcontract(quantity = 100, rate = 50, retentionPercent?: number) {
  const projectId = await createProject();
  const supplier = await createSubcontractorSupplier();
  const commitment = await createDraftSubcontractCommitment(projectId, supplier.id);

  const qtyLineRes = await addCommitmentLine(projectId, commitment.id, { description: "Formwork", quantity, rate });
  expect(qtyLineRes.status).toBe(201);
  const amountLineRes = await addCommitmentLine(projectId, commitment.id, { description: "Mobilization", amount: 5000 });
  expect(amountLineRes.status).toBe(201);

  await submitAndApproveCommitment(projectId, commitment.id);

  if (retentionPercent !== undefined) {
    await db.update(commitments).set({ retentionPercent: String(retentionPercent) }).where(eq(commitments.id, commitment.id));
  }

  return {
    projectId,
    supplierId: supplier.id,
    commitmentId: commitment.id,
    qtyLineId: qtyLineRes.body.id as string,
    amountLineId: amountLineRes.body.id as string,
  };
}

function createSubcontractIpc(projectId: string, commitmentId: string, token = ownerToken) {
  return request(app)
    .post(`/api/projects/${projectId}/subcontract-ipcs`)
    .set("Authorization", `Bearer ${token}`)
    .send({ commitmentId, periodStart: "2026-03-01", periodEnd: "2026-03-31" });
}

function addLine(projectId: string, ipcId: string, body: Record<string, unknown>, token = ownerToken) {
  return request(app)
    .post(`/api/projects/${projectId}/subcontract-ipcs/${ipcId}/items`)
    .set("Authorization", `Bearer ${token}`)
    .send(body);
}
function submit(projectId: string, ipcId: string, token = ownerToken) {
  return request(app).post(`/api/projects/${projectId}/subcontract-ipcs/${ipcId}/submit`).set("Authorization", `Bearer ${token}`);
}
function approve(projectId: string, ipcId: string, token = ownerToken) {
  return request(app).post(`/api/projects/${projectId}/subcontract-ipcs/${ipcId}/approve`).set("Authorization", `Bearer ${token}`);
}
function reject(projectId: string, ipcId: string, reason = "يحتاج مراجعة", token = ownerToken) {
  return request(app)
    .post(`/api/projects/${projectId}/subcontract-ipcs/${ipcId}/reject`)
    .set("Authorization", `Bearer ${token}`)
    .send({ reason });
}
function certify(projectId: string, ipcId: string, token = ownerToken) {
  return request(app).post(`/api/projects/${projectId}/subcontract-ipcs/${ipcId}/certify`).set("Authorization", `Bearer ${token}`);
}

// ---------------------------------------------------------------------------
describe("Isolation", () => {
  it("foreign company GET (list) -> 404 via project ownership", async () => {
    const { projectId } = await setupActiveSubcontract();
    const res = await request(app).get(`/api/projects/${projectId}/subcontract-ipcs`).set("Authorization", `Bearer ${companyBToken}`);
    expect(res.status).toBe(404);
  });

  it("foreign company mutation (create) -> 404", async () => {
    const { projectId, commitmentId } = await setupActiveSubcontract();
    const res = await createSubcontractIpc(projectId, commitmentId, companyBToken);
    expect(res.status).toBe(404);
  });

  it("foreign project -> 404", async () => {
    const res = await request(app)
      .get(`/api/projects/00000000-0000-0000-0000-000000000000/subcontract-ipcs`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(404);
  });

  it("foreign commitment (belongs to another project) -> 404", async () => {
    const { commitmentId } = await setupActiveSubcontract();
    const otherProjectId = await createProject();
    const res = await createSubcontractIpc(otherProjectId, commitmentId);
    expect(res.status).toBe(404);
  });

  it("foreign commitment line (belongs to another IPC's commitment) -> 404", async () => {
    const a = await setupActiveSubcontract();
    const b = await setupActiveSubcontract();
    const ipcA = await createSubcontractIpc(a.projectId, a.commitmentId);
    const res = await addLine(a.projectId, ipcA.body.id, { commitmentLineId: b.qtyLineId, currentQuantity: 5 });
    expect(res.status).toBe(404);
  });

  it("non-subcontract commitment (type=purchase_order) is rejected at creation", async () => {
    const projectId = await createProject();
    const supplier = await createSubcontractorSupplier();
    const poRes = await request(app)
      .post(`/api/projects/${projectId}/commitments`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ supplierId: supplier.id, type: "purchase_order" });
    expect(poRes.status).toBe(201);
    await addCommitmentLine(projectId, poRes.body.id, { description: "Materials", amount: 1000 });
    const activePo = await submitAndApproveCommitment(projectId, poRes.body.id);
    const res = await createSubcontractIpc(projectId, activePo.id);
    expect(res.status).toBe(409);
  });

  it("a draft (not yet active) commitment is rejected at creation", async () => {
    const projectId = await createProject();
    const supplier = await createSubcontractorSupplier();
    const draft = await createDraftSubcontractCommitment(projectId, supplier.id);
    const res = await createSubcontractIpc(projectId, draft.id);
    expect(res.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
describe("Lifecycle", () => {
  it("draft -> submitted -> approved -> certified (quantity/rate + amount-only lines together)", async () => {
    const { projectId, commitmentId, qtyLineId, amountLineId } = await setupActiveSubcontract(100, 50, 10);
    const ipc = await createSubcontractIpc(projectId, commitmentId);
    expect(ipc.body.status).toBe("draft");

    const qtyLine = await addLine(projectId, ipc.body.id, { commitmentLineId: qtyLineId, currentQuantity: 40 });
    expect(qtyLine.status).toBe(201);
    expect(Number(qtyLine.body.currentValue)).toBe(2000);

    const amountLine = await addLine(projectId, ipc.body.id, { commitmentLineId: amountLineId, currentValue: 3000 });
    expect(amountLine.status).toBe(201);
    expect(Number(amountLine.body.currentValue)).toBe(3000);

    const submitRes = await submit(projectId, ipc.body.id);
    expect(submitRes.status).toBe(200);
    expect(submitRes.body.status).toBe("submitted");

    const approveRes = await approve(projectId, ipc.body.id);
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.status).toBe("approved");

    const certifyRes = await certify(projectId, ipc.body.id);
    expect(certifyRes.status).toBe(200);
    expect(certifyRes.body.status).toBe("certified");
    expect(Number(certifyRes.body.grossValue)).toBe(5000);
    expect(Number(certifyRes.body.retentionAmount)).toBe(500);
    expect(Number(certifyRes.body.netCertified)).toBe(4500);
  });

  it("submitted -> rejected, then the IPC is editable and resubmittable", async () => {
    const { projectId, commitmentId, amountLineId } = await setupActiveSubcontract();
    const ipc = await createSubcontractIpc(projectId, commitmentId);
    await addLine(projectId, ipc.body.id, { commitmentLineId: amountLineId, currentValue: 1000 });
    await submit(projectId, ipc.body.id);

    const rejectRes = await reject(projectId, ipc.body.id);
    expect(rejectRes.status).toBe(200);
    expect(rejectRes.body.status).toBe("rejected");

    const secondLine = await addLine(projectId, ipc.body.id, { commitmentLineId: amountLineId, currentValue: 500 });
    expect(secondLine.status).toBe(201);

    const resubmitRes = await submit(projectId, ipc.body.id);
    expect(resubmitRes.status).toBe(200);
    expect(resubmitRes.body.status).toBe("submitted");
  });

  it("invalid transitions are rejected with 409: submit with no lines, approve a draft, certify a submitted one", async () => {
    const { projectId, commitmentId } = await setupActiveSubcontract();
    const ipc = await createSubcontractIpc(projectId, commitmentId);

    const noLinesSubmit = await submit(projectId, ipc.body.id);
    expect(noLinesSubmit.status).toBe(400);

    const approveDraft = await approve(projectId, ipc.body.id);
    expect(approveDraft.status).toBe(409);

    const certifySubmitted = await certify(projectId, ipc.body.id);
    expect(certifySubmitted.status).toBe(409);
  });

  it("certified is terminal: cannot be edited (add/delete line) or deleted further", async () => {
    const { projectId, commitmentId, amountLineId } = await setupActiveSubcontract();
    const ipc = await createSubcontractIpc(projectId, commitmentId);
    const line = await addLine(projectId, ipc.body.id, { commitmentLineId: amountLineId, currentValue: 1000 });
    await submit(projectId, ipc.body.id);
    await approve(projectId, ipc.body.id);
    const certifyRes = await certify(projectId, ipc.body.id);
    expect(certifyRes.status).toBe(200);

    const addAfterCertify = await addLine(projectId, ipc.body.id, { commitmentLineId: amountLineId, currentValue: 1 });
    expect(addAfterCertify.status).toBe(409);

    const deleteAfterCertify = await request(app)
      .delete(`/api/projects/${projectId}/subcontract-ipcs/${ipc.body.id}/items/${line.body.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(deleteAfterCertify.status).toBe(409);

    const submitAgain = await submit(projectId, ipc.body.id);
    expect(submitAgain.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
describe("RBAC (server-authoritative, not UI-hidden)", () => {
  it("owner succeeds, member gets 403, for every mutation", async () => {
    const { projectId, commitmentId, amountLineId } = await setupActiveSubcontract();

    const memberCreate = await createSubcontractIpc(projectId, commitmentId, memberToken);
    expect(memberCreate.status).toBe(403);

    const ipc = await createSubcontractIpc(projectId, commitmentId, ownerToken);

    const memberAddLine = await addLine(projectId, ipc.body.id, { commitmentLineId: amountLineId, currentValue: 100 }, memberToken);
    expect(memberAddLine.status).toBe(403);

    const ownerLine = await addLine(projectId, ipc.body.id, { commitmentLineId: amountLineId, currentValue: 100 }, ownerToken);
    expect(ownerLine.status).toBe(201);

    const memberDelete = await request(app)
      .delete(`/api/projects/${projectId}/subcontract-ipcs/${ipc.body.id}/items/${ownerLine.body.id}`)
      .set("Authorization", `Bearer ${memberToken}`);
    expect(memberDelete.status).toBe(403);

    const memberSubmit = await submit(projectId, ipc.body.id, memberToken);
    expect(memberSubmit.status).toBe(403);

    const ownerSubmit = await submit(projectId, ipc.body.id, ownerToken);
    expect(ownerSubmit.status).toBe(200);

    const memberApprove = await approve(projectId, ipc.body.id, memberToken);
    expect(memberApprove.status).toBe(403);

    const memberReject = await reject(projectId, ipc.body.id, "x", memberToken);
    expect(memberReject.status).toBe(403);

    const ownerApprove = await approve(projectId, ipc.body.id, ownerToken);
    expect(ownerApprove.status).toBe(200);

    const memberCertify = await certify(projectId, ipc.body.id, memberToken);
    expect(memberCertify.status).toBe(403);

    const ownerCertify = await certify(projectId, ipc.body.id, ownerToken);
    expect(ownerCertify.status).toBe(200);
  });

  it("read access is open to members (no permission gate on GET)", async () => {
    const { projectId, commitmentId } = await setupActiveSubcontract();
    const ipc = await createSubcontractIpc(projectId, commitmentId);
    const listRes = await request(app).get(`/api/projects/${projectId}/subcontract-ipcs`).set("Authorization", `Bearer ${memberToken}`);
    expect(listRes.status).toBe(200);
    const detailRes = await request(app)
      .get(`/api/projects/${projectId}/subcontract-ipcs/${ipc.body.id}`)
      .set("Authorization", `Bearer ${memberToken}`);
    expect(detailRes.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
describe("Financial truth", () => {
  it("quantity/rate line: server computes currentValue = quantity * rate, never trusting a client-supplied value", async () => {
    const { projectId, commitmentId, qtyLineId } = await setupActiveSubcontract(100, 37.5);
    const ipc = await createSubcontractIpc(projectId, commitmentId);
    // Deliberately send an unrelated, wrong currentValue too — the server
    // must ignore it and compute its own.
    const res = await request(app)
      .post(`/api/projects/${projectId}/subcontract-ipcs/${ipc.body.id}/items`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ commitmentLineId: qtyLineId, currentQuantity: 8, currentValue: 999999 });
    expect(res.status).toBe(201);
    expect(Number(res.body.currentValue)).toBe(300); // 8 * 37.5, NOT 999999
  });

  it("amount-only line: currentValue is the entered input, not a derived quantity*rate", async () => {
    const { projectId, commitmentId, amountLineId } = await setupActiveSubcontract();
    const ipc = await createSubcontractIpc(projectId, commitmentId);
    const res = await addLine(projectId, ipc.body.id, { commitmentLineId: amountLineId, currentValue: 1234.56 });
    expect(res.status).toBe(201);
    expect(Number(res.body.currentValue)).toBe(1234.56);
    expect(res.body.currentQuantity).toBeNull();
    expect(res.body.rate).toBeNull();
  });

  it("amount-only line without currentValue is rejected (never inventing a fake quantity/rate)", async () => {
    const { projectId, commitmentId, amountLineId } = await setupActiveSubcontract();
    const ipc = await createSubcontractIpc(projectId, commitmentId);
    const res = await addLine(projectId, ipc.body.id, { commitmentLineId: amountLineId, currentQuantity: 5 });
    expect(res.status).toBe(400);
  });

  it("quantity/rate line without currentQuantity is rejected", async () => {
    const { projectId, commitmentId, qtyLineId } = await setupActiveSubcontract();
    const ipc = await createSubcontractIpc(projectId, commitmentId);
    const res = await addLine(projectId, ipc.body.id, { commitmentLineId: qtyLineId, currentValue: 500 });
    expect(res.status).toBe(400);
  });

  it("gross/retention/net use deliberately non-additive fixture values, proving the server's own arithmetic, not a client echo", async () => {
    // 1234.56 + 765.44 = 2000.00 exactly (deliberately round to make the
    // retention math easy to hand-verify: 15% of 2000 = 300).
    const { projectId, commitmentId, amountLineId } = await setupActiveSubcontract(100, 50, 15);
    const ipc = await createSubcontractIpc(projectId, commitmentId);
    await addLine(projectId, ipc.body.id, { commitmentLineId: amountLineId, currentValue: 1234.56 });
    // amountLineId ceiling is 5000, so a second line for the remainder is safe.
    await addLine(projectId, ipc.body.id, { commitmentLineId: amountLineId, currentValue: 765.44 });
    await submit(projectId, ipc.body.id);
    await approve(projectId, ipc.body.id);
    const res = await certify(projectId, ipc.body.id);
    expect(res.status).toBe(200);
    expect(Number(res.body.grossValue)).toBe(2000);
    expect(Number(res.body.retentionPercent)).toBe(15);
    expect(Number(res.body.retentionAmount)).toBe(300);
    expect(Number(res.body.advanceRecoveryAmount)).toBe(0);
    expect(Number(res.body.otherDeductions)).toBe(0);
    expect(Number(res.body.netCertified)).toBe(1700);
  });

  it("zero retentionPercent on the commitment yields zero retention and net === gross", async () => {
    const { projectId, commitmentId, amountLineId } = await setupActiveSubcontract(100, 50); // no retentionPercent set
    const ipc = await createSubcontractIpc(projectId, commitmentId);
    await addLine(projectId, ipc.body.id, { commitmentLineId: amountLineId, currentValue: 1000 });
    await submit(projectId, ipc.body.id);
    await approve(projectId, ipc.body.id);
    const res = await certify(projectId, ipc.body.id);
    expect(Number(res.body.retentionAmount)).toBe(0);
    expect(Number(res.body.netCertified)).toBe(1000);
  });

  it("reads never recompute the certified snapshot — GET returns exactly the stored, frozen values", async () => {
    const { projectId, commitmentId, amountLineId } = await setupActiveSubcontract(100, 50, 10);
    const ipc = await createSubcontractIpc(projectId, commitmentId);
    await addLine(projectId, ipc.body.id, { commitmentLineId: amountLineId, currentValue: 1000 });
    await submit(projectId, ipc.body.id);
    await approve(projectId, ipc.body.id);
    const certifyRes = await certify(projectId, ipc.body.id);

    const getRes = await request(app)
      .get(`/api/projects/${projectId}/subcontract-ipcs/${ipc.body.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(getRes.status).toBe(200);
    expect(Number(getRes.body.grossValue)).toBe(Number(certifyRes.body.grossValue));
    expect(Number(getRes.body.netCertified)).toBe(Number(certifyRes.body.netCertified));
  });
});

// ---------------------------------------------------------------------------
describe("Ceiling / overrun", () => {
  it("quantity/rate line: cumulative certified quantity may never exceed the commitment line's quantity", async () => {
    const { projectId, commitmentId, qtyLineId } = await setupActiveSubcontract(100, 10); // ceiling qty = 100
    const ipc1 = await createSubcontractIpc(projectId, commitmentId);
    const line1 = await addLine(projectId, ipc1.body.id, { commitmentLineId: qtyLineId, currentQuantity: 60 });
    expect(line1.status).toBe(201);
    await submit(projectId, ipc1.body.id);
    await approve(projectId, ipc1.body.id);
    const certify1 = await certify(projectId, ipc1.body.id);
    expect(certify1.status).toBe(200);

    const ipc2 = await createSubcontractIpc(projectId, commitmentId);
    const overrunLine = await addLine(projectId, ipc2.body.id, { commitmentLineId: qtyLineId, currentQuantity: 45 }); // 60+45=105 > 100
    expect(overrunLine.status).toBe(400);

    const okLine = await addLine(projectId, ipc2.body.id, { commitmentLineId: qtyLineId, currentQuantity: 40 }); // 60+40=100, exactly at ceiling
    expect(okLine.status).toBe(201);
    await submit(projectId, ipc2.body.id);
    await approve(projectId, ipc2.body.id);
    const certify2 = await certify(projectId, ipc2.body.id);
    expect(certify2.status).toBe(200);
  });

  it("amount-only line: cumulative certified value may never exceed the commitment line's amount", async () => {
    const { projectId, commitmentId, amountLineId } = await setupActiveSubcontract(); // ceiling amount = 5000
    const ipc1 = await createSubcontractIpc(projectId, commitmentId);
    await addLine(projectId, ipc1.body.id, { commitmentLineId: amountLineId, currentValue: 4500 });
    await submit(projectId, ipc1.body.id);
    await approve(projectId, ipc1.body.id);
    await certify(projectId, ipc1.body.id);

    const ipc2 = await createSubcontractIpc(projectId, commitmentId);
    const overrun = await addLine(projectId, ipc2.body.id, { commitmentLineId: amountLineId, currentValue: 600 }); // 4500+600 > 5000
    expect(overrun.status).toBe(400);
  });

  it("overrun caught authoritatively at certify() even if two draft IPCs both pass the fast-path line-add check", async () => {
    const { projectId, commitmentId, amountLineId } = await setupActiveSubcontract(); // ceiling = 5000
    const ipc1 = await createSubcontractIpc(projectId, commitmentId);
    const ipc2 = await createSubcontractIpc(projectId, commitmentId);
    // Both draft IPCs individually pass the fast-path (nothing certified
    // yet), even though together they'd overrun the ceiling.
    const l1 = await addLine(projectId, ipc1.body.id, { commitmentLineId: amountLineId, currentValue: 3000 });
    expect(l1.status).toBe(201);
    const l2 = await addLine(projectId, ipc2.body.id, { commitmentLineId: amountLineId, currentValue: 3000 });
    expect(l2.status).toBe(201);

    await submit(projectId, ipc1.body.id);
    await approve(projectId, ipc1.body.id);
    const c1 = await certify(projectId, ipc1.body.id);
    expect(c1.status).toBe(200);

    await submit(projectId, ipc2.body.id);
    await approve(projectId, ipc2.body.id);
    const c2 = await certify(projectId, ipc2.body.id); // 3000+3000 > 5000
    expect(c2.status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
describe("PIT / snapshot integrity", () => {
  it("after certification, mutating the commitment line's rate, the commitment's retentionPercent, and the line's amount never changes the certified snapshot", async () => {
    const { projectId, commitmentId, qtyLineId, amountLineId } = await setupActiveSubcontract(100, 20, 10);
    const ipc = await createSubcontractIpc(projectId, commitmentId);
    await addLine(projectId, ipc.body.id, { commitmentLineId: qtyLineId, currentQuantity: 10 }); // 200
    await addLine(projectId, ipc.body.id, { commitmentLineId: amountLineId, currentValue: 800 }); // 800
    await submit(projectId, ipc.body.id);
    await approve(projectId, ipc.body.id);
    const certifyRes = await certify(projectId, ipc.body.id);
    expect(certifyRes.status).toBe(200);
    expect(Number(certifyRes.body.grossValue)).toBe(1000);
    expect(Number(certifyRes.body.retentionAmount)).toBe(100);
    expect(Number(certifyRes.body.netCertified)).toBe(900);

    // Mutate the underlying data directly at the DB layer (simulating any
    // future route that might allow it) — the certified IPC must be blind
    // to all of it.
    await db.update(commitmentLines).set({ rate: "999.99", amount: "1" }).where(eq(commitmentLines.id, qtyLineId));
    await db.update(commitments).set({ retentionPercent: "99" }).where(eq(commitments.id, commitmentId));

    const reread = await request(app)
      .get(`/api/projects/${projectId}/subcontract-ipcs/${ipc.body.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(reread.status).toBe(200);
    expect(Number(reread.body.grossValue)).toBe(1000);
    expect(Number(reread.body.retentionPercent)).toBe(10);
    expect(Number(reread.body.retentionAmount)).toBe(100);
    expect(Number(reread.body.netCertified)).toBe(900);

    const qtyLineRow = reread.body.lines.find((l: { commitmentLineId: string }) => l.commitmentLineId === qtyLineId);
    expect(Number(qtyLineRow.rate)).toBe(20); // frozen at line-add time, NOT 999.99
    expect(Number(qtyLineRow.currentValue)).toBe(200);
  });
});

// ---------------------------------------------------------------------------
describe("Cross-ledger independence (mandatory)", () => {
  async function setupPublishedBoq() {
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
      .send({ description: "Shared scope item", unit: "m2", quantity: 100, rate: 10 });
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

  async function approveOwnerMeasurement(projectId: string, contractId: string, revisionId: string, boqItemId: string, quantity: number) {
    const mRes = await request(app)
      .post(`/api/projects/${projectId}/measurements`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId, boqRevisionId: revisionId, measurementDate: "2026-03-01" });
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

  it("Owner IPC and Subcontractor IPC can both certify against the same BOQ item without interfering with each other's ledger", async () => {
    const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq();
    await approveOwnerMeasurement(projectId, contractId, revisionId, boqItemId, 80);

    // Owner IPC certifies 50 of the 80 approved quantity.
    const ownerIpcRes = await request(app)
      .post(`/api/projects/${projectId}/ipcs`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId, boqRevisionId: revisionId, periodStart: "2026-03-01", periodEnd: "2026-03-31" });
    expect(ownerIpcRes.status).toBe(201);
    await request(app)
      .post(`/api/projects/${projectId}/ipcs/${ownerIpcRes.body.id}/items`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ boqItemId, currentQuantity: 50 });
    await request(app).post(`/api/projects/${projectId}/ipcs/${ownerIpcRes.body.id}/submit`).set("Authorization", `Bearer ${ownerToken}`);
    await request(app).post(`/api/projects/${projectId}/ipcs/${ownerIpcRes.body.id}/approve`).set("Authorization", `Bearer ${ownerToken}`);
    const ownerCertify = await request(app).post(`/api/projects/${projectId}/ipcs/${ownerIpcRes.body.id}/certify`).set("Authorization", `Bearer ${ownerToken}`);
    expect(ownerCertify.status).toBe(200);
    expect(Number(ownerCertify.body.grossValue)).toBe(500); // 50 * 10

    // A subcontract commitment referencing the SAME boqItemId, with a much
    // larger committed quantity (150) than the BOQ item's own total (100)
    // — proving the subcontractor ceiling is the commitment, never the BOQ.
    const supplier = await createSubcontractorSupplier();
    const commitment = await createDraftSubcontractCommitment(projectId, supplier.id);
    const lineRes = await addCommitmentLine(projectId, commitment.id, { description: "Same scope, subcontracted", boqItemId, quantity: 150, rate: 8 });
    expect(lineRes.status).toBe(201);
    await submitAndApproveCommitment(projectId, commitment.id);

    // Subcontractor IPC certifies 120 — far more than the 30 units the
    // owner's approved-measurement ledger has "remaining" (80 - 50 = 30).
    // If this domain accidentally shared Owner IPC's ledger, this would
    // be rejected as an overrun; it must succeed, because the ceiling here
    // is the commitment's own 150, entirely independent.
    const subIpcRes = await createSubcontractIpc(projectId, commitment.id);
    const subLine = await addLine(projectId, subIpcRes.body.id, { commitmentLineId: lineRes.body.id, currentQuantity: 120 });
    expect(subLine.status).toBe(201);
    await submit(projectId, subIpcRes.body.id);
    await approve(projectId, subIpcRes.body.id);
    const subCertify = await certify(projectId, subIpcRes.body.id);
    expect(subCertify.status).toBe(200);
    expect(Number(subCertify.body.grossValue)).toBe(960); // 120 * 8

    // Owner IPC's own remaining certifiable capacity for this BOQ item is
    // untouched by the subcontractor's certification: 80 approved - 50
    // already certified = 30 still available, exactly as before.
    const ownerIpc2 = await request(app)
      .post(`/api/projects/${projectId}/ipcs`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId, boqRevisionId: revisionId, periodStart: "2026-04-01", periodEnd: "2026-04-30" });
    const overOwnerLine = await request(app)
      .post(`/api/projects/${projectId}/ipcs/${ownerIpc2.body.id}/items`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ boqItemId, currentQuantity: 31 }); // 50+31=81 > 80 approved
    expect(overOwnerLine.status).toBe(400);
    const exactOwnerLine = await request(app)
      .post(`/api/projects/${projectId}/ipcs/${ownerIpc2.body.id}/items`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ boqItemId, currentQuantity: 30 }); // exactly the remaining 30
    expect(exactOwnerLine.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
describe("Concurrency", () => {
  it("two concurrent certify() calls on IPCs sharing the same commitment line: only one may consume overlapping remaining capacity", async () => {
    const { projectId, commitmentId, amountLineId } = await setupActiveSubcontract(); // ceiling = 5000
    const ipc1 = await createSubcontractIpc(projectId, commitmentId);
    const ipc2 = await createSubcontractIpc(projectId, commitmentId);
    await addLine(projectId, ipc1.body.id, { commitmentLineId: amountLineId, currentValue: 3000 });
    await addLine(projectId, ipc2.body.id, { commitmentLineId: amountLineId, currentValue: 3000 });
    await submit(projectId, ipc1.body.id);
    await submit(projectId, ipc2.body.id);
    await approve(projectId, ipc1.body.id);
    await approve(projectId, ipc2.body.id);

    const [r1, r2] = await Promise.all([certify(projectId, ipc1.body.id), certify(projectId, ipc2.body.id)]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);
  });
});

// ---------------------------------------------------------------------------
describe("Numbering", () => {
  it("ipcNumber is scoped per commitment — different commitments may both have IPC number 1", async () => {
    const a = await setupActiveSubcontract();
    const b = await setupActiveSubcontract();
    const ipcA1 = await createSubcontractIpc(a.projectId, a.commitmentId);
    const ipcB1 = await createSubcontractIpc(b.projectId, b.commitmentId);
    expect(ipcA1.body.ipc_number).toBe(1);
    expect(ipcB1.body.ipc_number).toBe(1);

    const ipcA2 = await createSubcontractIpc(a.projectId, a.commitmentId);
    expect(ipcA2.body.ipc_number).toBe(2);
  });

  it("concurrent creation on the same commitment never produces duplicate IPC numbers", async () => {
    const { projectId, commitmentId } = await setupActiveSubcontract();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => createSubcontractIpc(projectId, commitmentId)),
    );
    for (const r of results) expect(r.status).toBe(201);
    const numbers = results.map((r) => r.body.ipc_number).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2, 3, 4, 5]);
  });
});
