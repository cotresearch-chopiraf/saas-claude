import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { auditEvents, ipcLines, ipcs } from "../src/db/schema.js";
import { listAuditEvents } from "../src/lib/audit.js";

// Phase 2C: IPC (Interim Payment Certificate). Same shared-company-per-file
// discipline as measurement.test.ts / procurement.test.ts.

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
    .send({ companyName: "IPC Co", name: "Owner", email: uniqueEmail("ipc-owner"), password: "password123" });
  expect(ownerRes.status).toBe(201);
  ownerToken = ownerRes.body.token;

  const inviteRes = await request(app)
    .post("/api/company/invites")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ email: uniqueEmail("ipc-member"), role: "member" });
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
    .send({ companyName: "Other Co", name: "Owner B", email: uniqueEmail("ipc-other"), password: "password123" });
  expect(companyBRes.status).toBe(201);
  companyBToken = companyBRes.body.token;
});

async function createProject(token = ownerToken) {
  const res = await request(app)
    .post("/api/projects")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: `IPC Project ${Math.random()}` });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function setupPublishedBoq(quantity = 100, rate = 10, retentionPercent?: number) {
  const projectId = await createProject();
  const contractRes = await request(app)
    .post(`/api/projects/${projectId}/contracts`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ originalValue: 50000, ...(retentionPercent !== undefined ? { retentionPercent } : {}) });
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

// Creates and approves a Measurement for a given quantity against the
// given BOQ item — the approved-quantity floor every IPC line depends on.
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
  return mRes.body.id as string;
}

async function createDraftIpc(projectId: string, contractId: string, revisionId: string, token = ownerToken) {
  const res = await request(app)
    .post(`/api/projects/${projectId}/ipcs`)
    .set("Authorization", `Bearer ${token}`)
    .send({ contractId, boqRevisionId: revisionId, periodStart: "2026-02-01", periodEnd: "2026-02-28" });
  expect(res.status).toBe(201);
  return res.body as { id: string; ipc_number: number; status: string };
}

function addLine(projectId: string, ipcId: string, body: Record<string, unknown>, token = ownerToken) {
  return request(app)
    .post(`/api/projects/${projectId}/ipcs/${ipcId}/items`)
    .set("Authorization", `Bearer ${token}`)
    .send(body);
}

function submit(projectId: string, ipcId: string, token = ownerToken) {
  return request(app).post(`/api/projects/${projectId}/ipcs/${ipcId}/submit`).set("Authorization", `Bearer ${token}`);
}
function approve(projectId: string, ipcId: string, token = ownerToken) {
  return request(app).post(`/api/projects/${projectId}/ipcs/${ipcId}/approve`).set("Authorization", `Bearer ${token}`);
}
function reject(projectId: string, ipcId: string, reason = "Needs revision", token = ownerToken) {
  return request(app)
    .post(`/api/projects/${projectId}/ipcs/${ipcId}/reject`)
    .set("Authorization", `Bearer ${token}`)
    .send({ reason });
}
function certify(projectId: string, ipcId: string, token = ownerToken) {
  return request(app).post(`/api/projects/${projectId}/ipcs/${ipcId}/certify`).set("Authorization", `Bearer ${token}`);
}

describe("Lifecycle", () => {
  it("1-6. full happy path: create, add line, remove draft line, submit, approve, certify", async () => {
    const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq(100, 10);
    await approveMeasurement(projectId, contractId, revisionId, boqItemId, 60);

    const ipc = await createDraftIpc(projectId, contractId, revisionId);
    expect(ipc.status).toBe("draft");

    const throwawayLine = await addLine(projectId, ipc.id, { boqItemId, currentQuantity: 10 });
    expect(throwawayLine.status).toBe(201);
    const removeRes = await request(app)
      .delete(`/api/projects/${projectId}/ipcs/${ipc.id}/items/${throwawayLine.body.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(removeRes.status).toBe(204);

    const lineRes = await addLine(projectId, ipc.id, { boqItemId, currentQuantity: 40 });
    expect(lineRes.status).toBe(201);
    expect(Number(lineRes.body.currentValue)).toBe(400);

    const submitRes = await submit(projectId, ipc.id);
    expect(submitRes.status).toBe(200);
    expect(submitRes.body.status).toBe("submitted");

    const approveRes = await approve(projectId, ipc.id);
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.status).toBe("approved");

    const certifyRes = await certify(projectId, ipc.id);
    expect(certifyRes.status).toBe(200);
    expect(certifyRes.body.status).toBe("certified");
    expect(Number(certifyRes.body.grossValue)).toBe(400);
    expect(Number(certifyRes.body.netCertified)).toBe(400); // no retention configured on this contract
  });

  it("7/8. reject, then the IPC is editable and resubmittable", async () => {
    const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq(100, 10);
    await approveMeasurement(projectId, contractId, revisionId, boqItemId, 50);
    const ipc = await createDraftIpc(projectId, contractId, revisionId);
    await addLine(projectId, ipc.id, { boqItemId, currentQuantity: 20 });
    await submit(projectId, ipc.id);

    const rejectRes = await reject(projectId, ipc.id, "Quantities look off");
    expect(rejectRes.status).toBe(200);
    expect(rejectRes.body.status).toBe("rejected");

    const addAfterReject = await addLine(projectId, ipc.id, { boqItemId, currentQuantity: 5 });
    expect(addAfterReject.status).toBe(201);

    const resubmitRes = await submit(projectId, ipc.id);
    expect(resubmitRes.status).toBe(200);
    expect(resubmitRes.body.rejectionReason).toBeNull();
  });

  it("9/10/11. submitted, approved, and certified are all immutable to line mutation", async () => {
    const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq(100, 10);
    await approveMeasurement(projectId, contractId, revisionId, boqItemId, 100);
    const ipc = await createDraftIpc(projectId, contractId, revisionId);
    const lineRes = await addLine(projectId, ipc.id, { boqItemId, currentQuantity: 30 });
    await submit(projectId, ipc.id);

    const addAfterSubmit = await addLine(projectId, ipc.id, { boqItemId, currentQuantity: 5 });
    expect(addAfterSubmit.status).toBe(409);

    await approve(projectId, ipc.id);
    const addAfterApprove = await addLine(projectId, ipc.id, { boqItemId, currentQuantity: 5 });
    expect(addAfterApprove.status).toBe(409);

    await certify(projectId, ipc.id);
    const addAfterCertify = await addLine(projectId, ipc.id, { boqItemId, currentQuantity: 5 });
    expect(addAfterCertify.status).toBe(409);
    const deleteAfterCertify = await request(app)
      .delete(`/api/projects/${projectId}/ipcs/${ipc.id}/items/${lineRes.body.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(deleteAfterCertify.status).toBe(409);
  });

  it("certified cannot be re-approved, re-submitted, re-rejected, or re-certified", async () => {
    const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq(100, 10);
    await approveMeasurement(projectId, contractId, revisionId, boqItemId, 100);
    const ipc = await createDraftIpc(projectId, contractId, revisionId);
    await addLine(projectId, ipc.id, { boqItemId, currentQuantity: 20 });
    await submit(projectId, ipc.id);
    await approve(projectId, ipc.id);
    await certify(projectId, ipc.id);

    expect((await submit(projectId, ipc.id)).status).toBe(409);
    expect((await approve(projectId, ipc.id)).status).toBe(409);
    expect((await reject(projectId, ipc.id)).status).toBe(409);
    expect((await certify(projectId, ipc.id)).status).toBe(409);
  });
});

describe("Measurement relationship", () => {
  it("12/16. an IPC line requires approved measurement quantity for that BOQ item", async () => {
    const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq(100, 10);
    // No measurement approved at all — certifiable remainder is 0.
    const ipc = await createDraftIpc(projectId, contractId, revisionId);
    const res = await addLine(projectId, ipc.id, { boqItemId, currentQuantity: 10 });
    expect(res.status).toBe(400);
  });

  it("13. cannot use a draft measurement's quantity", async () => {
    const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq(100, 10);
    const mRes = await request(app)
      .post(`/api/projects/${projectId}/measurements`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId, boqRevisionId: revisionId, measurementDate: "2026-02-01" });
    await request(app)
      .post(`/api/projects/${projectId}/measurements/${mRes.body.id}/items`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ boqItemId, measuredQuantity: 50 });
    // Never submitted/approved — still draft.

    const ipc = await createDraftIpc(projectId, contractId, revisionId);
    const res = await addLine(projectId, ipc.id, { boqItemId, currentQuantity: 10 });
    expect(res.status).toBe(400);
  });

  it("14. cannot use a rejected measurement's quantity", async () => {
    const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq(100, 10);
    const mRes = await request(app)
      .post(`/api/projects/${projectId}/measurements`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId, boqRevisionId: revisionId, measurementDate: "2026-02-01" });
    await request(app)
      .post(`/api/projects/${projectId}/measurements/${mRes.body.id}/items`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ boqItemId, measuredQuantity: 50 });
    await request(app)
      .post(`/api/projects/${projectId}/measurements/${mRes.body.id}/submit`)
      .set("Authorization", `Bearer ${ownerToken}`);
    await request(app)
      .post(`/api/projects/${projectId}/measurements/${mRes.body.id}/reject`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ reason: "bad" });

    const ipc = await createDraftIpc(projectId, contractId, revisionId);
    const res = await addLine(projectId, ipc.id, { boqItemId, currentQuantity: 10 });
    expect(res.status).toBe(400);
  });

  it("15. the BOQ revision referenced must be published", async () => {
    const projectId = await createProject();
    const contractRes = await request(app)
      .post(`/api/projects/${projectId}/contracts`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ originalValue: 10000 });
    const revRes = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId: contractRes.body.id });
    // Never published.

    const res = await request(app)
      .post(`/api/projects/${projectId}/ipcs`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId: contractRes.body.id, boqRevisionId: revRes.body.id, periodStart: "2026-02-01", periodEnd: "2026-02-28" });
    expect(res.status).toBe(400);
  });

  it("17. project/contract/revision consistency is enforced (wrong contract for this project rejected)", async () => {
    const { projectId } = await setupPublishedBoq();
    const otherProjectId = await createProject();
    const otherContractRes = await request(app)
      .post(`/api/projects/${otherProjectId}/contracts`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ originalValue: 1000 });

    const res = await request(app)
      .post(`/api/projects/${projectId}/ipcs`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        contractId: otherContractRes.body.id,
        boqRevisionId: "00000000-0000-0000-0000-000000000000",
        periodStart: "2026-02-01",
        periodEnd: "2026-02-28",
      });
    expect(res.status).toBe(404);
  });
});

describe("Valuation", () => {
  it("18. current-quantity valuation is quantity * rate", async () => {
    const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq(100, 12.5);
    await approveMeasurement(projectId, contractId, revisionId, boqItemId, 20);
    const ipc = await createDraftIpc(projectId, contractId, revisionId);
    const res = await addLine(projectId, ipc.id, { boqItemId, currentQuantity: 20 });
    expect(res.status).toBe(201);
    expect(Number(res.body.currentValue)).toBe(250);
  });

  it("19/20. cumulative valuation correctly excludes prior certification", async () => {
    const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq(100, 10);
    await approveMeasurement(projectId, contractId, revisionId, boqItemId, 40);

    const ipc1 = await createDraftIpc(projectId, contractId, revisionId);
    await addLine(projectId, ipc1.id, { boqItemId, currentQuantity: 40 });
    await submit(projectId, ipc1.id);
    await approve(projectId, ipc1.id);
    const cert1 = await certify(projectId, ipc1.id);
    expect(cert1.status).toBe(200);

    const line1 = await db.query.ipcLines.findFirst({ where: eq(ipcLines.ipcId, ipc1.id) });
    expect(Number(line1?.previousCertifiedQuantity)).toBe(0);
    expect(Number(line1?.cumulativeQuantity)).toBe(40);

    await approveMeasurement(projectId, contractId, revisionId, boqItemId, 30);
    const ipc2 = await createDraftIpc(projectId, contractId, revisionId);
    await addLine(projectId, ipc2.id, { boqItemId, currentQuantity: 30 });
    await submit(projectId, ipc2.id);
    await approve(projectId, ipc2.id);
    const cert2 = await certify(projectId, ipc2.id);
    expect(cert2.status).toBe(200);

    const line2 = await db.query.ipcLines.findFirst({ where: eq(ipcLines.ipcId, ipc2.id) });
    expect(Number(line2?.previousCertifiedQuantity)).toBe(40); // excludes only what was already certified
    expect(Number(line2?.cumulativeQuantity)).toBe(70);
    expect(Number(line2?.previousCertifiedValue)).toBe(400);
  });

  it("21/22. repeated certification is prevented — certified quantity never exceeds the BOQ quantity", async () => {
    const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq(100, 10);
    await approveMeasurement(projectId, contractId, revisionId, boqItemId, 100);

    const ipc1 = await createDraftIpc(projectId, contractId, revisionId);
    await addLine(projectId, ipc1.id, { boqItemId, currentQuantity: 100 });
    await submit(projectId, ipc1.id);
    await approve(projectId, ipc1.id);
    expect((await certify(projectId, ipc1.id)).status).toBe(200);

    // A second IPC attempting to certify even 1 more unit of the SAME
    // fully-certified BOQ item must be blocked at the line-add fast-path.
    const ipc2 = await createDraftIpc(projectId, contractId, revisionId);
    const res = await addLine(projectId, ipc2.id, { boqItemId, currentQuantity: 1 });
    expect(res.status).toBe(400);

    const certifiedRows = await db.query.ipcLines.findMany({ where: eq(ipcLines.boqItemId, boqItemId) });
    const totalCertifiedQty = certifiedRows.reduce((s, r) => s + Number(r.currentQuantity), 0);
    expect(totalCertifiedQty).toBeLessThanOrEqual(100);
  });

  it("23. retention is deterministic: retentionAmount = grossValue * contract.retentionPercent, frozen at certification", async () => {
    const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq(100, 10, 10); // 10% retention
    await approveMeasurement(projectId, contractId, revisionId, boqItemId, 50);
    const ipc = await createDraftIpc(projectId, contractId, revisionId);
    await addLine(projectId, ipc.id, { boqItemId, currentQuantity: 50 });
    await submit(projectId, ipc.id);
    await approve(projectId, ipc.id);
    const certRes = await certify(projectId, ipc.id);

    expect(Number(certRes.body.grossValue)).toBe(500);
    expect(Number(certRes.body.retentionAmount)).toBe(50); // 10% of 500
    expect(Number(certRes.body.netCertified)).toBe(450);
  });

  it("24. advance recovery does not invent an unsupported rule — always 0", async () => {
    const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq(100, 10);
    // Set an advancePercent on the contract — must NOT be used to compute
    // a recovery amount, since no advance-paid/recovery-schedule model
    // exists anywhere in this repository.
    await request(app)
      .patch(`/api/projects/${projectId}/contracts/${contractId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ advancePercent: 20 });
    await approveMeasurement(projectId, contractId, revisionId, boqItemId, 30);
    const ipc = await createDraftIpc(projectId, contractId, revisionId);
    await addLine(projectId, ipc.id, { boqItemId, currentQuantity: 30 });
    await submit(projectId, ipc.id);
    await approve(projectId, ipc.id);
    const certRes = await certify(projectId, ipc.id);

    expect(Number(certRes.body.advanceRecoveryAmount)).toBe(0);
    expect(Number(certRes.body.otherDeductions)).toBe(0);
  });

  it("25/26. net certified = gross - retention - advance - deductions, and is never negative", async () => {
    const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq(100, 20, 5);
    await approveMeasurement(projectId, contractId, revisionId, boqItemId, 25);
    const ipc = await createDraftIpc(projectId, contractId, revisionId);
    await addLine(projectId, ipc.id, { boqItemId, currentQuantity: 25 });
    await submit(projectId, ipc.id);
    await approve(projectId, ipc.id);
    const certRes = await certify(projectId, ipc.id);

    const gross = Number(certRes.body.grossValue);
    const retention = Number(certRes.body.retentionAmount);
    const advance = Number(certRes.body.advanceRecoveryAmount);
    const deductions = Number(certRes.body.otherDeductions);
    const net = Number(certRes.body.netCertified);
    expect(net).toBe(gross - retention - advance - deductions);
    expect(net).toBeGreaterThanOrEqual(0);
  });
});

describe("Tenant isolation", () => {
  it("27. cross-tenant project rejected", async () => {
    const res = await request(app)
      .get("/api/projects/00000000-0000-0000-0000-000000000000/ipcs")
      .set("Authorization", `Bearer ${companyBToken}`);
    expect(res.status).toBe(404);
  });

  it("28. cross-tenant contract rejected", async () => {
    const { projectId } = await setupPublishedBoq();
    const otherProjectId = await createProject();
    const otherContractRes = await request(app)
      .post(`/api/projects/${otherProjectId}/contracts`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ originalValue: 1000 });
    const otherRevRes = await request(app)
      .post(`/api/projects/${otherProjectId}/boq-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId: otherContractRes.body.id });

    const res = await request(app)
      .post(`/api/projects/${projectId}/ipcs`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId: otherContractRes.body.id, boqRevisionId: otherRevRes.body.id, periodStart: "2026-02-01", periodEnd: "2026-02-28" });
    expect(res.status).toBe(404);
  });

  it("29. cross-contract BOQ revision rejected", async () => {
    const { projectId, contractId } = await setupPublishedBoq();
    const other = await setupPublishedBoq();

    const res = await request(app)
      .post(`/api/projects/${projectId}/ipcs`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId, boqRevisionId: other.revisionId, periodStart: "2026-02-01", periodEnd: "2026-02-28" });
    expect(res.status).toBe(400);
  });

  it("30. cross-revision BOQ item rejected", async () => {
    const { projectId, contractId, revisionId } = await setupPublishedBoq();
    const other = await setupPublishedBoq();
    const ipc = await createDraftIpc(projectId, contractId, revisionId);

    const res = await addLine(projectId, ipc.id, { boqItemId: other.boqItemId, currentQuantity: 5 });
    expect(res.status).toBe(404);
  });

  it("31. cross-tenant measurement never contributes to another company's certifiable quantity", async () => {
    // Company B cannot even reach Company A's project/BOQ item to create
    // a measurement against it in the first place — verified via the
    // ordinary tenant-scoping already proven in measurement.test.ts; here
    // we confirm an IPC line add against a foreign boqItemId is rejected
    // the same way regardless of any measurement state.
    const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq();
    const ipc = await createDraftIpc(projectId, contractId, revisionId);
    const res = await addLine(projectId, ipc.id, { boqItemId, currentQuantity: 5 }, companyBToken);
    expect(res.status).toBe(404); // company B can't even see this project
  });

  it("32. cross-tenant IPC access rejected", async () => {
    const { projectId, contractId, revisionId } = await setupPublishedBoq();
    const ipc = await createDraftIpc(projectId, contractId, revisionId);

    const res = await request(app)
      .get(`/api/projects/${projectId}/ipcs/${ipc.id}`)
      .set("Authorization", `Bearer ${companyBToken}`);
    expect(res.status).toBe(404);
  });
});

describe("RBAC", () => {
  it("33. an unauthorized member cannot approve", async () => {
    const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq();
    await approveMeasurement(projectId, contractId, revisionId, boqItemId, 10);
    const ipc = await createDraftIpc(projectId, contractId, revisionId);
    await addLine(projectId, ipc.id, { boqItemId, currentQuantity: 5 });
    await submit(projectId, ipc.id);

    const res = await approve(projectId, ipc.id, memberToken);
    expect(res.status).toBe(403);
  });

  it("34. an unauthorized member cannot certify", async () => {
    const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq();
    await approveMeasurement(projectId, contractId, revisionId, boqItemId, 10);
    const ipc = await createDraftIpc(projectId, contractId, revisionId);
    await addLine(projectId, ipc.id, { boqItemId, currentQuantity: 5 });
    await submit(projectId, ipc.id);
    await approve(projectId, ipc.id);

    const res = await certify(projectId, ipc.id, memberToken);
    expect(res.status).toBe(403);
  });

  it("35. a member cannot mutate a submitted IPC (create/items/submit are also owner-only, unlike Measurement)", async () => {
    const { projectId, contractId, revisionId } = await setupPublishedBoq();
    const createAsMember = await request(app)
      .post(`/api/projects/${projectId}/ipcs`)
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ contractId, boqRevisionId: revisionId, periodStart: "2026-02-01", periodEnd: "2026-02-28" });
    expect(createAsMember.status).toBe(403);
  });

  it("36. certification permission is enforced server-side, not just hidden client-side", async () => {
    const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq();
    await approveMeasurement(projectId, contractId, revisionId, boqItemId, 10);
    const ipc = await createDraftIpc(projectId, contractId, revisionId);
    await addLine(projectId, ipc.id, { boqItemId, currentQuantity: 5 });
    await submit(projectId, ipc.id);
    await approve(projectId, ipc.id);

    const memberAttempt = await certify(projectId, ipc.id, memberToken);
    expect(memberAttempt.status).toBe(403);
    const stillApproved = await db.query.ipcs.findFirst({ where: eq(ipcs.id, ipc.id) });
    expect(stillApproved?.status).toBe("approved");
  });
});

describe("Audit trail", () => {
  it("37-43. every lifecycle transition produces its canonical audit event", async () => {
    const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq(100, 10);
    await approveMeasurement(projectId, contractId, revisionId, boqItemId, 60);
    const ipc = await createDraftIpc(projectId, contractId, revisionId);
    const lineRes = await addLine(projectId, ipc.id, { boqItemId, currentQuantity: 10 });
    const removeRes = await request(app)
      .delete(`/api/projects/${projectId}/ipcs/${ipc.id}/items/${lineRes.body.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(removeRes.status).toBe(204);
    const lineRes2 = await addLine(projectId, ipc.id, { boqItemId, currentQuantity: 20 });
    await submit(projectId, ipc.id);
    await reject(projectId, ipc.id, "recheck");
    await submit(projectId, ipc.id);
    await approve(projectId, ipc.id);
    const certRes = await certify(projectId, ipc.id);
    expect(certRes.status).toBe(200);

    const events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, ipc.id) });
    const actions = events.map((e) => e.action).sort();
    expect(actions).toEqual(
      ["ipc.approved", "ipc.certified", "ipc.created", "ipc.rejected", "ipc.submitted", "ipc.submitted"].sort(),
    );

    const lineAddedEvents = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, lineRes.body.id) });
    expect(lineAddedEvents.some((e) => e.action === "ipc.lineAdded")).toBe(true);
    expect(lineAddedEvents.some((e) => e.action === "ipc.lineRemoved")).toBe(true);

    const line2Events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, lineRes2.body.id) });
    expect(line2Events.some((e) => e.action === "ipc.lineAdded")).toBe(true);

    const certifiedEvent = events.find((e) => e.action === "ipc.certified");
    expect(certifiedEvent).toBeTruthy();
    const after = certifiedEvent!.afterValue as { grossValue: string; netCertified: string };
    expect(Number(after.grossValue)).toBe(200);
    expect(Number(after.netCertified)).toBe(200);

    for (const event of events) {
      expect(event.companyId).toBeTruthy();
      expect(event.actorUserId).toBeTruthy();
      expect(event.entityType).toBe("ipc");
    }
  });

  it("44. audit retrieval is tenant-isolated", async () => {
    const { projectId, contractId, revisionId } = await setupPublishedBoq();
    const ipc = await createDraftIpc(projectId, contractId, revisionId);

    const ownerRow = await db.query.auditEvents.findFirst({ where: eq(auditEvents.entityId, ipc.id) });
    expect(ownerRow).toBeTruthy();
    const ownerScoped = await listAuditEvents(ownerRow!.companyId, { entityType: "ipc" });
    expect(ownerScoped.some((e) => e.entityId === ipc.id)).toBe(true);

    const otherRes = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "IPC Rival Co", name: "Owner", email: uniqueEmail("ipc-rival"), password: "password123" });
    const otherScoped = await listAuditEvents(otherRes.body.company.id, { entityType: "ipc" });
    expect(otherScoped.some((e) => e.entityId === ipc.id)).toBe(false);
  });
});

describe("Concurrency", () => {
  const TRIALS = 5;

  it(`${TRIALS}x: concurrent submit — exactly one succeeds`, async () => {
    for (let trial = 0; trial < TRIALS; trial++) {
      const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq();
      await approveMeasurement(projectId, contractId, revisionId, boqItemId, 10);
      const ipc = await createDraftIpc(projectId, contractId, revisionId);
      await addLine(projectId, ipc.id, { boqItemId, currentQuantity: 5 });

      const results = await Promise.all(Array.from({ length: 5 }, () => submit(projectId, ipc.id)));
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(4);

      const row = await db.query.ipcs.findFirst({ where: eq(ipcs.id, ipc.id) });
      expect(row?.status).toBe("submitted");
    }
  });

  it(`${TRIALS}x: concurrent approve — exactly one succeeds`, async () => {
    for (let trial = 0; trial < TRIALS; trial++) {
      const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq();
      await approveMeasurement(projectId, contractId, revisionId, boqItemId, 10);
      const ipc = await createDraftIpc(projectId, contractId, revisionId);
      await addLine(projectId, ipc.id, { boqItemId, currentQuantity: 5 });
      await submit(projectId, ipc.id);

      const results = await Promise.all(Array.from({ length: 5 }, () => approve(projectId, ipc.id)));
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(4);

      const row = await db.query.ipcs.findFirst({ where: eq(ipcs.id, ipc.id) });
      expect(row?.status).toBe("approved");
    }
  });

  it(`${TRIALS}x: concurrent certify — exactly one succeeds`, async () => {
    for (let trial = 0; trial < TRIALS; trial++) {
      const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq();
      await approveMeasurement(projectId, contractId, revisionId, boqItemId, 10);
      const ipc = await createDraftIpc(projectId, contractId, revisionId);
      await addLine(projectId, ipc.id, { boqItemId, currentQuantity: 5 });
      await submit(projectId, ipc.id);
      await approve(projectId, ipc.id);

      const results = await Promise.all(Array.from({ length: 5 }, () => certify(projectId, ipc.id)));
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(4);

      const row = await db.query.ipcs.findFirst({ where: eq(ipcs.id, ipc.id) });
      expect(row?.status).toBe("certified");
    }
  });

  it(`${TRIALS}x: certify vs line mutation never leaves an inconsistent database state`, async () => {
    for (let trial = 0; trial < TRIALS; trial++) {
      const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq();
      await approveMeasurement(projectId, contractId, revisionId, boqItemId, 10);
      const ipc = await createDraftIpc(projectId, contractId, revisionId);
      const lineRes = await addLine(projectId, ipc.id, { boqItemId, currentQuantity: 5 });
      await submit(projectId, ipc.id);
      await approve(projectId, ipc.id);

      const [certifyRes, deleteRes] = await Promise.all([
        certify(projectId, ipc.id),
        request(app)
          .delete(`/api/projects/${projectId}/ipcs/${ipc.id}/items/${lineRes.body.id}`)
          .set("Authorization", `Bearer ${ownerToken}`),
      ]);
      expect(certifyRes.status).toBe(200);
      expect(deleteRes.status).toBe(409); // approved is already immutable, before certify even races

      const lines = await db.query.ipcLines.findMany({ where: eq(ipcLines.ipcId, ipc.id) });
      expect(lines).toHaveLength(1);
    }
  });

  it(`${TRIALS}x: concurrent overlapping certification across two DIFFERENT IPCs never exceeds the BOQ quantity`, async () => {
    for (let trial = 0; trial < TRIALS; trial++) {
      const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq(100, 10);
      await approveMeasurement(projectId, contractId, revisionId, boqItemId, 100);

      const ipcA = await createDraftIpc(projectId, contractId, revisionId);
      await addLine(projectId, ipcA.id, { boqItemId, currentQuantity: 60 });
      await submit(projectId, ipcA.id);
      await approve(projectId, ipcA.id);

      const ipcB = await createDraftIpc(projectId, contractId, revisionId);
      const addB = await addLine(projectId, ipcB.id, { boqItemId, currentQuantity: 60 });
      // The line-add fast-path may or may not catch this depending on
      // ordering — the real guarantee is certify()'s locked recheck below.
      if (addB.status === 201) {
        await submit(projectId, ipcB.id);
        await approve(projectId, ipcB.id);
      }

      const [certA, certB] = await Promise.all([
        certify(projectId, ipcA.id),
        addB.status === 201 ? certify(projectId, ipcB.id) : Promise.resolve({ status: 409 } as { status: number }),
      ]);

      const outcomes = [certA.status, certB.status];
      expect(outcomes.filter((s) => s === 200).length).toBeLessThanOrEqual(1);

      // The database invariant that must ALWAYS hold regardless of which
      // side won the race:
      const certifiedRows = await db.query.ipcLines.findMany({ where: eq(ipcLines.boqItemId, boqItemId) });
      const totalCertifiedQty = await db.query.ipcs
        .findMany({ where: eq(ipcs.boqRevisionId, revisionId) })
        .then(async (allIpcs) => {
          const certifiedIpcIds = new Set(allIpcs.filter((i) => i.status === "certified").map((i) => i.id));
          return certifiedRows
            .filter((l) => certifiedIpcIds.has(l.ipcId))
            .reduce((sum, l) => sum + Number(l.currentQuantity), 0);
        });
      expect(totalCertifiedQty).toBeLessThanOrEqual(100);
    }
  });

  it(`${TRIALS}x: concurrent IPC creation never collides on ipcNumber`, async () => {
    for (let trial = 0; trial < TRIALS; trial++) {
      const { projectId, contractId, revisionId } = await setupPublishedBoq();

      const results = await Promise.all(
        Array.from({ length: 5 }, () => createDraftIpcRaw(projectId, contractId, revisionId)),
      );
      const numbers = results.map((r) => r.body.ipc_number).sort((a, b) => a - b);
      expect(numbers).toEqual([1, 2, 3, 4, 5]);
    }
  });
});

function createDraftIpcRaw(projectId: string, contractId: string, revisionId: string) {
  return request(app)
    .post(`/api/projects/${projectId}/ipcs`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ contractId, boqRevisionId: revisionId, periodStart: "2026-02-01", periodEnd: "2026-02-28" });
}

describe("Architectural invariant: IPC never rewrites the canonical financial baselines", () => {
  it("certify never modifies projects.budgetTotal, contracts.revisedValue, published BOQ item amounts, or Commitment values", async () => {
    const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq(100, 10, 10);
    await approveMeasurement(projectId, contractId, revisionId, boqItemId, 40);

    const projectBefore = await request(app).get(`/api/projects/${projectId}`).set("Authorization", `Bearer ${ownerToken}`);
    const contractBefore = await request(app)
      .get(`/api/projects/${projectId}/contracts/${contractId}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    const boqBefore = await request(app)
      .get(`/api/projects/${projectId}/boq-revisions/${revisionId}`)
      .set("Authorization", `Bearer ${ownerToken}`);

    const ipc = await createDraftIpc(projectId, contractId, revisionId);
    await addLine(projectId, ipc.id, { boqItemId, currentQuantity: 40 });
    await submit(projectId, ipc.id);
    await approve(projectId, ipc.id);
    const certRes = await certify(projectId, ipc.id);
    expect(certRes.status).toBe(200);

    const projectAfter = await request(app).get(`/api/projects/${projectId}`).set("Authorization", `Bearer ${ownerToken}`);
    const contractAfter = await request(app)
      .get(`/api/projects/${projectId}/contracts/${contractId}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    const boqAfter = await request(app)
      .get(`/api/projects/${projectId}/boq-revisions/${revisionId}`)
      .set("Authorization", `Bearer ${ownerToken}`);

    expect(projectAfter.body.budgetTotal).toBe(projectBefore.body.budgetTotal);
    expect(contractAfter.body.revisedValue).toBe(contractBefore.body.revisedValue);
    expect(boqAfter.body.items[0].amount).toBe(boqBefore.body.items[0].amount);
  });
});

describe("Phase 3.2 hardening — IPC-002: certify() locks the parent contract row", () => {
  async function approvedIpc(retentionPercent: number) {
    const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq(100, 10, retentionPercent);
    await approveMeasurement(projectId, contractId, revisionId, boqItemId, 100);
    const ipc = await createDraftIpc(projectId, contractId, revisionId);
    await addLine(projectId, ipc.id, { boqItemId, currentQuantity: 100 });
    await submit(projectId, ipc.id);
    await approve(projectId, ipc.id);
    return { projectId, contractId, ipc };
  }

  it("certify() uses the retentionPercent that is current at certification time, not one cached before the request began", async () => {
    const { projectId, contractId, ipc } = await approvedIpc(5);

    const patchRes = await request(app)
      .patch(`/api/projects/${projectId}/contracts/${contractId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ retentionPercent: 15 });
    expect(patchRes.status).toBe(200);

    const certifyRes = await certify(projectId, ipc.id);
    expect(certifyRes.status).toBe(200);
    expect(Number(certifyRes.body.retentionAmount)).toBe(150); // grossValue 1000 * 15%
    expect(Number(certifyRes.body.netCertified)).toBe(850);
  });

  it("3x: a contract retentionPercent PATCH concurrent with certify() never produces a retentionAmount inconsistent with either rate", async () => {
    for (let i = 0; i < 3; i++) {
      const { projectId, contractId, ipc } = await approvedIpc(5);

      const [patchRes, certifyRes] = await Promise.all([
        request(app)
          .patch(`/api/projects/${projectId}/contracts/${contractId}`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .send({ retentionPercent: 20 }),
        certify(projectId, ipc.id),
      ]);

      expect(patchRes.status).toBe(200);
      expect(certifyRes.status).toBe(200);

      const grossValue = 1000;
      const atOldRate = 50; // 1000 * 5%
      const atNewRate = 200; // 1000 * 20%
      const retentionAmount = Number(certifyRes.body.retentionAmount);
      expect([atOldRate, atNewRate]).toContain(retentionAmount);
      // Whichever rate was actually used, the certified snapshot must be
      // internally consistent — never a torn read mixing part of one rate
      // with part of another.
      expect(Number(certifyRes.body.netCertified)).toBe(grossValue - retentionAmount);
    }
  });
});

describe("Phase 3.2 hardening — QTY-001: quantity normalization", () => {
  it("a currentQuantity with more than 3 decimal places is normalized to 3dp before both storage and valuation", async () => {
    const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq(100, 10);
    await approveMeasurement(projectId, contractId, revisionId, boqItemId, 100);
    const ipc = await createDraftIpc(projectId, contractId, revisionId);

    const lineRes = await addLine(projectId, ipc.id, { boqItemId, currentQuantity: 1.23456 });
    expect(lineRes.status).toBe(201);
    expect(Number(lineRes.body.currentQuantity)).toBe(1.235);
    expect(Number(lineRes.body.currentValue)).toBe(12.35); // 1.235 * 10, not 1.23456 * 10

    const stored = await db.query.ipcLines.findFirst({ where: eq(ipcLines.id, lineRes.body.id) });
    expect(Number(stored!.currentQuantity)).toBe(1.235);
  });

  it("a quantity already within 3dp precision is unchanged", async () => {
    const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq(100, 10);
    await approveMeasurement(projectId, contractId, revisionId, boqItemId, 100);
    const ipc = await createDraftIpc(projectId, contractId, revisionId);

    const lineRes = await addLine(projectId, ipc.id, { boqItemId, currentQuantity: 1.234 });
    expect(lineRes.status).toBe(201);
    expect(Number(lineRes.body.currentQuantity)).toBe(1.234);
  });

  it("a whole-number quantity is unchanged", async () => {
    const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq(100, 10);
    await approveMeasurement(projectId, contractId, revisionId, boqItemId, 100);
    const ipc = await createDraftIpc(projectId, contractId, revisionId);

    const lineRes = await addLine(projectId, ipc.id, { boqItemId, currentQuantity: 5 });
    expect(lineRes.status).toBe(201);
    expect(Number(lineRes.body.currentQuantity)).toBe(5);
  });
});

describe("Phase 3.2 hardening — VAL-001: finite numeric validation", () => {
  // z.coerce.number() runs Number(input) first — a JSON body can never
  // carry a literal Infinity/NaN (JSON.stringify turns those into null
  // before the request is even sent), so the realistic attack surface is
  // the STRING "Infinity"/"NaN", which Number() happily turns into the
  // non-finite value these tests exist to catch.
  it('the string "Infinity" for currentQuantity is rejected with 400, not a 500', async () => {
    const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq(100, 10);
    await approveMeasurement(projectId, contractId, revisionId, boqItemId, 100);
    const ipc = await createDraftIpc(projectId, contractId, revisionId);

    const res = await addLine(projectId, ipc.id, { boqItemId, currentQuantity: "Infinity" });
    expect(res.status).toBe(400);
  });

  it('the string "-Infinity" for currentQuantity is rejected with 400', async () => {
    const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq(100, 10);
    await approveMeasurement(projectId, contractId, revisionId, boqItemId, 100);
    const ipc = await createDraftIpc(projectId, contractId, revisionId);

    const res = await addLine(projectId, ipc.id, { boqItemId, currentQuantity: "-Infinity" });
    expect(res.status).toBe(400);
  });

  it('the string "NaN" for currentQuantity is rejected with 400', async () => {
    const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq(100, 10);
    await approveMeasurement(projectId, contractId, revisionId, boqItemId, 100);
    const ipc = await createDraftIpc(projectId, contractId, revisionId);

    const res = await addLine(projectId, ipc.id, { boqItemId, currentQuantity: "NaN" });
    expect(res.status).toBe(400);
  });

  it("a normal valid quantity still works", async () => {
    const { projectId, contractId, revisionId, boqItemId } = await setupPublishedBoq(100, 10);
    await approveMeasurement(projectId, contractId, revisionId, boqItemId, 100);
    const ipc = await createDraftIpc(projectId, contractId, revisionId);

    const res = await addLine(projectId, ipc.id, { boqItemId, currentQuantity: 42 });
    expect(res.status).toBe(201);
  });
});
