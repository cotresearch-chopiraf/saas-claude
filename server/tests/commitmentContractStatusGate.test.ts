import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";

// P0.5 remediation — amend()/submit()/approve() on a commitment must be
// rejected once the commitment's parent contract has moved to completed or
// terminated, the same execution-gating already enforced at commitment
// creation (CTR-001). Same shared-company-per-file discipline as
// procurement.test.ts.

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

let ownerToken: string;

beforeAll(async () => {
  await resetDb();
  const ownerRes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "ContractGate Co", name: "Owner", email: uniqueEmail("cg-owner"), password: "password123" });
  expect(ownerRes.status).toBe(201);
  ownerToken = ownerRes.body.token;
});

async function createProject() {
  const res = await request(app)
    .post("/api/projects")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ name: `CG Project ${Math.random()}` });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

// Contract starts "draft"; PATCHing status:"active" is a valid
// draft->active transition per CONTRACT_STATUS_TRANSITIONS.
async function createActiveContract(projectId: string) {
  const createRes = await request(app)
    .post(`/api/projects/${projectId}/contracts`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ originalValue: 50000 });
  expect(createRes.status).toBe(201);
  const contractId = createRes.body.id as string;

  const activateRes = await request(app)
    .patch(`/api/projects/${projectId}/contracts/${contractId}`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ status: "active" });
  expect(activateRes.status).toBe(200);
  expect(activateRes.body.status).toBe("active");
  return contractId;
}

function setContractStatus(projectId: string, contractId: string, status: "completed" | "terminated") {
  return request(app)
    .patch(`/api/projects/${projectId}/contracts/${contractId}`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ status });
}

async function createSupplier() {
  const res = await request(app)
    .post("/api/suppliers")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ name: `Supplier ${Math.random()}`, type: "supplier" });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function createDraftCommitment(projectId: string, contractId?: string) {
  const supplierId = await createSupplier();
  const res = await request(app)
    .post(`/api/projects/${projectId}/commitments`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ supplierId, type: "purchase_order", ...(contractId ? { contractId } : {}) });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function addCommitmentLine(projectId: string, commitmentId: string) {
  const res = await request(app)
    .post(`/api/projects/${projectId}/commitments/${commitmentId}/items`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ description: "Rebar", amount: 1000 });
  expect(res.status).toBe(201);
}

function submitCommitment(projectId: string, commitmentId: string) {
  return request(app)
    .post(`/api/projects/${projectId}/commitments/${commitmentId}/submit`)
    .set("Authorization", `Bearer ${ownerToken}`);
}

function approveCommitment(projectId: string, commitmentId: string) {
  return request(app)
    .post(`/api/projects/${projectId}/commitments/${commitmentId}/approve`)
    .set("Authorization", `Bearer ${ownerToken}`);
}

function amendCommitment(projectId: string, commitmentId: string) {
  return request(app)
    .post(`/api/projects/${projectId}/commitments/${commitmentId}/amend`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ lines: [{ description: "Extra rebar", amount: 500 }] });
}

// Builds a commitment all the way to "active" (draft -> line -> submit ->
// approve), still while the contract itself is active.
async function buildActiveCommitment(projectId: string, contractId: string) {
  const commitmentId = await createDraftCommitment(projectId, contractId);
  await addCommitmentLine(projectId, commitmentId);
  const submitRes = await submitCommitment(projectId, commitmentId);
  expect(submitRes.status).toBe(200);
  const approveRes = await approveCommitment(projectId, commitmentId);
  expect(approveRes.status).toBe(200);
  expect(approveRes.body.status).toBe("active");
  return commitmentId;
}

describe("Commitment lifecycle vs. parent contract execution gating", () => {
  it.each(["completed", "terminated"] as const)("1/2. amend is blocked once the contract is %s", async (terminalStatus) => {
    const projectId = await createProject();
    const contractId = await createActiveContract(projectId);
    const commitmentId = await buildActiveCommitment(projectId, contractId);

    const statusRes = await setContractStatus(projectId, contractId, terminalStatus);
    expect(statusRes.status).toBe(200);

    const amendRes = await amendCommitment(projectId, commitmentId);
    expect(amendRes.status).toBe(409);
  });

  it.each(["completed", "terminated"] as const)("3/4. submit is blocked once the contract is %s", async (terminalStatus) => {
    const projectId = await createProject();
    const contractId = await createActiveContract(projectId);
    const commitmentId = await createDraftCommitment(projectId, contractId);
    await addCommitmentLine(projectId, commitmentId);

    const statusRes = await setContractStatus(projectId, contractId, terminalStatus);
    expect(statusRes.status).toBe(200);

    const submitRes = await submitCommitment(projectId, commitmentId);
    expect(submitRes.status).toBe(409);
  });

  it.each(["completed", "terminated"] as const)("5/6. approve is blocked once the contract is %s", async (terminalStatus) => {
    const projectId = await createProject();
    const contractId = await createActiveContract(projectId);
    const commitmentId = await createDraftCommitment(projectId, contractId);
    await addCommitmentLine(projectId, commitmentId);
    const submitRes = await submitCommitment(projectId, commitmentId);
    expect(submitRes.status).toBe(200);

    const statusRes = await setContractStatus(projectId, contractId, terminalStatus);
    expect(statusRes.status).toBe(200);

    const approveRes = await approveCommitment(projectId, commitmentId);
    expect(approveRes.status).toBe(409);
  });

  it("7. an active contract still permits normal submit/approve/amend", async () => {
    const projectId = await createProject();
    const contractId = await createActiveContract(projectId);
    const commitmentId = await createDraftCommitment(projectId, contractId);
    await addCommitmentLine(projectId, commitmentId);

    const submitRes = await submitCommitment(projectId, commitmentId);
    expect(submitRes.status).toBe(200);
    const approveRes = await approveCommitment(projectId, commitmentId);
    expect(approveRes.status).toBe(200);
    const amendRes = await amendCommitment(projectId, commitmentId);
    expect(amendRes.status).toBe(200);
    expect(Number(amendRes.body.revisedAmount)).toBe(1500);
  });

  it("8a. a commitment with no contract at all is never blocked by contract-status gating", async () => {
    const projectId = await createProject();
    const commitmentId = await createDraftCommitment(projectId); // no contractId
    await addCommitmentLine(projectId, commitmentId);

    const submitRes = await submitCommitment(projectId, commitmentId);
    expect(submitRes.status).toBe(200);
    const approveRes = await approveCommitment(projectId, commitmentId);
    expect(approveRes.status).toBe(200);
    const amendRes = await amendCommitment(projectId, commitmentId);
    expect(amendRes.status).toBe(200);
  });

  it("8b. a commitment linked to a still-draft contract is never blocked (draft is not an execution-blocked status)", async () => {
    const projectId = await createProject();
    const createContractRes = await request(app)
      .post(`/api/projects/${projectId}/contracts`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ originalValue: 20000 });
    expect(createContractRes.status).toBe(201);
    const draftContractId = createContractRes.body.id as string;

    const commitmentId = await createDraftCommitment(projectId, draftContractId);
    await addCommitmentLine(projectId, commitmentId);

    const submitRes = await submitCommitment(projectId, commitmentId);
    expect(submitRes.status).toBe(200);
    const approveRes = await approveCommitment(projectId, commitmentId);
    expect(approveRes.status).toBe(200);
  });

  it("9. concurrent contract-termination vs. commitment-amend is race-safe: never both succeed", async () => {
    const projectId = await createProject();
    const contractId = await createActiveContract(projectId);
    const commitmentId = await buildActiveCommitment(projectId, contractId);

    const [terminateRes, amendRes] = await Promise.all([
      setContractStatus(projectId, contractId, "terminated"),
      amendCommitment(projectId, commitmentId),
    ]);

    // The one outcome that must never happen: the contract is terminated
    // AND the commitment still gained new financial value afterward.
    const bothSucceeded = terminateRes.status === 200 && amendRes.status === 200;
    expect(bothSucceeded).toBe(false);
    expect([200, 409]).toContain(terminateRes.status);
    expect([200, 409]).toContain(amendRes.status);
  });
});
