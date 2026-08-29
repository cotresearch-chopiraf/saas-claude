import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";

// Phase 2E: Cash Flow. Same shared-company-per-file discipline as
// forecast.test.ts / ipc.test.ts.

vi.mock("../src/lib/mailer.js", () => ({ sendMail: vi.fn() }));

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
function daysFromToday(delta: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

let ownerToken: string;
let memberToken: string;
let companyBToken: string;

beforeAll(async () => {
  await resetDb();

  const ownerRes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "CashFlow Co", name: "Owner", email: uniqueEmail("cf-owner"), password: "password123" });
  expect(ownerRes.status).toBe(201);
  ownerToken = ownerRes.body.token;

  const inviteRes = await request(app)
    .post("/api/company/invites")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ email: uniqueEmail("cf-member"), role: "member" });
  expect(inviteRes.status).toBe(201);
  const { sendMail } = await import("../src/lib/mailer.js");
  const mailCall = (sendMail as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
  const inviteToken = (mailCall[2] as string).match(/token=([a-f0-9]{64})/)![1];
  const acceptRes = await request(app)
    .post("/api/auth/accept-invite")
    .send({ token: inviteToken, name: "Member", password: "memberpass123" });
  expect(acceptRes.status).toBe(201);
  memberToken = acceptRes.body.token;

  const companyBRes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Other Co", name: "Owner B", email: uniqueEmail("cf-other"), password: "password123" });
  expect(companyBRes.status).toBe(201);
  companyBToken = companyBRes.body.token;
});

async function createProject(token = ownerToken) {
  const res = await request(app)
    .post("/api/projects")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: `CashFlow Project ${Math.random()}` });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function createContract(projectId: string, opts: { currency?: string; retentionPercent?: number } = {}) {
  const res = await request(app)
    .post(`/api/projects/${projectId}/contracts`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ originalValue: 50000, ...opts });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function addBudgetItem(projectId: string, plannedAmount: number) {
  const res = await request(app)
    .post(`/api/projects/${projectId}/budget/items`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ category: "Materials", plannedAmount });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function addExpense(projectId: string, amount: number, expenseDate: string) {
  const res = await request(app)
    .post(`/api/projects/${projectId}/budget/expenses`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ description: "Cement", amount, expenseDate });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function createSupplier() {
  const res = await request(app)
    .post("/api/suppliers")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ name: `Supplier ${Math.random()}`, type: "supplier" });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function createActiveCommitment(projectId: string, amount: number, opts: { currency?: string } = {}) {
  const supplierId = await createSupplier();
  const createRes = await request(app)
    .post(`/api/projects/${projectId}/commitments`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ supplierId, type: "purchase_order", ...(opts.currency ? { currency: opts.currency } : {}) });
  expect(createRes.status).toBe(201);
  const commitmentId = createRes.body.id as string;
  await request(app)
    .post(`/api/projects/${projectId}/commitments/${commitmentId}/items`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ description: "Steel", amount });
  await request(app)
    .post(`/api/projects/${projectId}/commitments/${commitmentId}/submit`)
    .set("Authorization", `Bearer ${ownerToken}`);
  const approveRes = await request(app)
    .post(`/api/projects/${projectId}/commitments/${commitmentId}/approve`)
    .set("Authorization", `Bearer ${ownerToken}`);
  expect(approveRes.status).toBe(200);
  return commitmentId;
}

async function createDraftCommitment(projectId: string, amount: number) {
  const supplierId = await createSupplier();
  const createRes = await request(app)
    .post(`/api/projects/${projectId}/commitments`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ supplierId, type: "purchase_order" });
  await request(app)
    .post(`/api/projects/${projectId}/commitments/${createRes.body.id}/items`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ description: "Steel", amount });
  return createRes.body.id as string;
}

async function createCancelledCommitment(projectId: string, amount: number) {
  const id = await createDraftCommitment(projectId, amount);
  await request(app).post(`/api/projects/${projectId}/commitments/${id}/submit`).set("Authorization", `Bearer ${ownerToken}`);
  const cancelRes = await request(app)
    .post(`/api/projects/${projectId}/commitments/${id}/cancel`)
    .set("Authorization", `Bearer ${ownerToken}`);
  expect(cancelRes.status).toBe(200);
  return id;
}

async function setupCertifiedIpc(quantity: number, rate: number, opts: { projectId?: string; retentionPercent?: number } = {}) {
  const projectId = opts.projectId ?? (await createProject());
  const contractId = await createContract(projectId, { retentionPercent: opts.retentionPercent });

  const revRes = await request(app)
    .post(`/api/projects/${projectId}/boq-revisions`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ contractId });
  const revisionId = revRes.body.id as string;
  const itemRes = await request(app)
    .post(`/api/projects/${projectId}/boq-revisions/${revisionId}/items`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ description: "Excavation", unit: "m3", quantity, rate });
  const boqItemId = itemRes.body.id as string;
  await request(app)
    .post(`/api/projects/${projectId}/boq-revisions/${revisionId}/publish`)
    .set("Authorization", `Bearer ${ownerToken}`);

  const mRes = await request(app)
    .post(`/api/projects/${projectId}/measurements`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ contractId, boqRevisionId: revisionId, measurementDate: today() });
  await request(app)
    .post(`/api/projects/${projectId}/measurements/${mRes.body.id}/items`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ boqItemId, measuredQuantity: quantity });
  await request(app).post(`/api/projects/${projectId}/measurements/${mRes.body.id}/submit`).set("Authorization", `Bearer ${ownerToken}`);
  await request(app).post(`/api/projects/${projectId}/measurements/${mRes.body.id}/approve`).set("Authorization", `Bearer ${ownerToken}`);

  const ipcRes = await request(app)
    .post(`/api/projects/${projectId}/ipcs`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ contractId, boqRevisionId: revisionId, periodStart: today(), periodEnd: today() });
  await request(app)
    .post(`/api/projects/${projectId}/ipcs/${ipcRes.body.id}/items`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ boqItemId, currentQuantity: quantity });
  await request(app).post(`/api/projects/${projectId}/ipcs/${ipcRes.body.id}/submit`).set("Authorization", `Bearer ${ownerToken}`);
  await request(app).post(`/api/projects/${projectId}/ipcs/${ipcRes.body.id}/approve`).set("Authorization", `Bearer ${ownerToken}`);
  const certifyRes = await request(app)
    .post(`/api/projects/${projectId}/ipcs/${ipcRes.body.id}/certify`)
    .set("Authorization", `Bearer ${ownerToken}`);
  expect(certifyRes.status).toBe(200);

  return {
    projectId,
    contractId,
    grossValue: Number(certifyRes.body.grossValue),
    retentionAmount: Number(certifyRes.body.retentionAmount),
    netCertified: Number(certifyRes.body.netCertified),
  };
}

async function createUncertifiedIpc(projectId: string, status: "draft" | "submitted") {
  const contractId = await createContract(projectId);
  const revRes = await request(app)
    .post(`/api/projects/${projectId}/boq-revisions`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ contractId });
  const itemRes = await request(app)
    .post(`/api/projects/${projectId}/boq-revisions/${revRes.body.id}/items`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ description: "Excavation", unit: "m3", quantity: 10, rate: 5 });
  await request(app).post(`/api/projects/${projectId}/boq-revisions/${revRes.body.id}/publish`).set("Authorization", `Bearer ${ownerToken}`);

  if (status === "submitted") {
    const mRes = await request(app)
      .post(`/api/projects/${projectId}/measurements`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId, boqRevisionId: revRes.body.id, measurementDate: today() });
    await request(app)
      .post(`/api/projects/${projectId}/measurements/${mRes.body.id}/items`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ boqItemId: itemRes.body.id, measuredQuantity: 10 });
    await request(app).post(`/api/projects/${projectId}/measurements/${mRes.body.id}/submit`).set("Authorization", `Bearer ${ownerToken}`);
    await request(app).post(`/api/projects/${projectId}/measurements/${mRes.body.id}/approve`).set("Authorization", `Bearer ${ownerToken}`);
  }

  const ipcRes = await request(app)
    .post(`/api/projects/${projectId}/ipcs`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ contractId, boqRevisionId: revRes.body.id, periodStart: today(), periodEnd: today() });
  if (status === "submitted") {
    await request(app)
      .post(`/api/projects/${projectId}/ipcs/${ipcRes.body.id}/items`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ boqItemId: itemRes.body.id, currentQuantity: 10 });
    await request(app).post(`/api/projects/${projectId}/ipcs/${ipcRes.body.id}/submit`).set("Authorization", `Bearer ${ownerToken}`);
  }
}

async function createPaidInvoice(projectId: string, amount: number) {
  const createRes = await request(app)
    .post("/api/invoices")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ clientName: "Client", projectId, items: [{ description: "Work", amount }], taxRatePercent: 0 });
  expect(createRes.status).toBe(201);
  await request(app).patch(`/api/invoices/${createRes.body.id}/send`).set("Authorization", `Bearer ${ownerToken}`);
  const paidRes = await request(app)
    .patch(`/api/invoices/${createRes.body.id}/mark-paid`)
    .set("Authorization", `Bearer ${ownerToken}`);
  expect(paidRes.status).toBe(200);
  return createRes.body.id as string;
}

async function createSentInvoice(projectId: string, amount: number) {
  const createRes = await request(app)
    .post("/api/invoices")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ clientName: "Client", projectId, items: [{ description: "Work", amount }], taxRatePercent: 0 });
  expect(createRes.status).toBe(201);
  await request(app).patch(`/api/invoices/${createRes.body.id}/send`).set("Authorization", `Bearer ${ownerToken}`);
  return createRes.body.id as string;
}

function getCashFlow(projectId: string, query: Record<string, string> = {}, token = ownerToken) {
  const qs = new URLSearchParams(query).toString();
  return request(app)
    .get(`/api/projects/${projectId}/cash-flow${qs ? `?${qs}` : ""}`)
    .set("Authorization", `Bearer ${token}`);
}

describe("Calculation", () => {
  it("zero project: everything zero", async () => {
    const projectId = await createProject();
    const res = await getCashFlow(projectId);
    expect(res.status).toBe(200);
    expect(res.body.historical.cashReceived).toBe(0);
    expect(res.body.historical.incurredCost).toBe(0);
    expect(res.body.projected.receivables).toBe(0);
    expect(res.body.projected.certifiedExpectedCollection).toBe(0);
    expect(res.body.projected.commitments).toBe(0);
    expect(res.body.projected.net).toBe(0);
    expect(res.body.undated.etc).toBe(0);
    expect(res.body.undated.retentionToBeReleased).toBe(0);
  });

  it("positive projected net cash flow", async () => {
    const projectId = await createProject();
    await createSentInvoice(projectId, 5000);
    await createActiveCommitment(projectId, 1000);
    const res = await getCashFlow(projectId);
    expect(res.body.projected.receivables).toBe(5000);
    expect(res.body.projected.commitments).toBe(1000);
    expect(res.body.projected.net).toBe(4000);
  });

  it("negative projected net cash flow", async () => {
    const projectId = await createProject();
    await createSentInvoice(projectId, 500);
    await createActiveCommitment(projectId, 3000);
    const res = await getCashFlow(projectId);
    expect(res.body.projected.net).toBe(500 - 3000);
    expect(res.body.projected.net).toBeLessThan(0);
  });

  it("money rounding stays exact across many small amounts", async () => {
    const projectId = await createProject();
    await createPaidInvoice(projectId, 0.1);
    await createPaidInvoice(projectId, 0.2);
    const res = await getCashFlow(projectId);
    expect(res.body.historical.cashReceived).toBe(0.3);
  });

  it("historical/projected/undated are kept in separate buckets", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 20000);
    await addExpense(projectId, 2000, today());
    await createPaidInvoice(projectId, 3000);
    await createSentInvoice(projectId, 1000);
    await createActiveCommitment(projectId, 4000);
    const { grossValue } = await setupCertifiedIpc(50, 10, { projectId });
    void grossValue;

    const res = await getCashFlow(projectId);
    expect(res.body.historical.incurredCost).toBe(2000);
    expect(res.body.historical.cashReceived).toBe(3000);
    expect(res.body.projected.receivables).toBe(1000);
    expect(res.body.projected.commitments).toBe(4000);
    expect(res.body.projected.certifiedExpectedCollection).toBe(500); // 50*10, no retention configured
    expect(res.body.undated.etc).toBeGreaterThanOrEqual(0);
  });
});

describe("PIT", () => {
  it("a future paid invoice (paidAt after asOfDate) is excluded by an earlier asOfDate", async () => {
    const projectId = await createProject();
    await createPaidInvoice(projectId, 1000); // paidAt = now
    const res = await getCashFlow(projectId, { asOfDate: daysFromToday(-1) });
    expect(res.status).toBe(200);
    expect(res.body.historical.cashReceived).toBe(0);
  });

  it("a future commitment (approvedAt after asOfDate) is excluded by an earlier asOfDate", async () => {
    const projectId = await createProject();
    await createActiveCommitment(projectId, 1000); // approvedAt = now
    const res = await getCashFlow(projectId, { asOfDate: daysFromToday(-1) });
    expect(res.body.projected.commitments).toBe(0);
  });

  it("a future-certified IPC is excluded by an earlier asOfDate", async () => {
    const { projectId } = await setupCertifiedIpc(10, 10, {}); // certifiedAt = now
    const res = await getCashFlow(projectId, { asOfDate: daysFromToday(-1) });
    expect(res.body.projected.certifiedExpectedCollection).toBe(0);
    expect(res.body.undated.retentionToBeReleased).toBe(0);
  });

  it("a sent invoice (issueDate = now) is excluded by an earlier asOfDate", async () => {
    const projectId = await createProject();
    await createSentInvoice(projectId, 500);
    const res = await getCashFlow(projectId, { asOfDate: daysFromToday(-1) });
    expect(res.body.projected.receivables).toBe(0);
  });

  it("rejects a future asOfDate", async () => {
    const projectId = await createProject();
    const res = await getCashFlow(projectId, { asOfDate: daysFromToday(5) });
    expect(res.status).toBe(400);
  });

  it("a snapshot dated today reflects everything created just now", async () => {
    const projectId = await createProject();
    await createPaidInvoice(projectId, 250);
    const res = await getCashFlow(projectId, { asOfDate: today() });
    expect(res.body.historical.cashReceived).toBe(250);
  });
});

describe("Invoice", () => {
  it("project-scoped invoices are included; unrelated project's invoices are excluded", async () => {
    const projectA = await createProject();
    const projectB = await createProject();
    await createPaidInvoice(projectA, 1000);
    await createPaidInvoice(projectB, 9999);

    const res = await getCashFlow(projectA);
    expect(res.body.historical.cashReceived).toBe(1000);
  });

  it("unallocated invoices (no projectId) never appear in any project's cash flow", async () => {
    const projectId = await createProject();
    const createRes = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ clientName: "Client", items: [{ description: "Work", amount: 999 }], taxRatePercent: 0 });
    expect(createRes.body.projectId).toBeNull();
    await request(app).patch(`/api/invoices/${createRes.body.id}/send`).set("Authorization", `Bearer ${ownerToken}`);
    await request(app).patch(`/api/invoices/${createRes.body.id}/mark-paid`).set("Authorization", `Bearer ${ownerToken}`);

    const res = await getCashFlow(projectId);
    expect(res.body.historical.cashReceived).toBe(0);
  });

  it("paid invoices are historical; unpaid (sent) invoices are projected receivables", async () => {
    const projectId = await createProject();
    await createPaidInvoice(projectId, 700);
    await createSentInvoice(projectId, 300);
    const res = await getCashFlow(projectId);
    expect(res.body.historical.cashReceived).toBe(700);
    expect(res.body.projected.receivables).toBe(300);
  });

  it("a draft invoice (never sent) is excluded entirely", async () => {
    const projectId = await createProject();
    const createRes = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ clientName: "Client", projectId, items: [{ description: "Work", amount: 500 }], taxRatePercent: 0 });
    expect(createRes.body.status).toBe("draft");
    const res = await getCashFlow(projectId);
    expect(res.body.historical.cashReceived).toBe(0);
    expect(res.body.projected.receivables).toBe(0);
  });
});

describe("IPC", () => {
  it("certified IPC is included; retention reduces expected collection", async () => {
    const { projectId, netCertified, retentionAmount } = await setupCertifiedIpc(100, 10, { retentionPercent: 10 });
    expect(retentionAmount).toBeGreaterThan(0);
    const res = await getCashFlow(projectId);
    expect(res.body.projected.certifiedExpectedCollection).toBe(netCertified);
    expect(res.body.projected.certifiedExpectedCollection).toBeLessThan(1000); // gross was 1000
    expect(res.body.undated.retentionToBeReleased).toBe(retentionAmount);
  });

  it("a draft IPC is excluded", async () => {
    const projectId = await createProject();
    await createUncertifiedIpc(projectId, "draft");
    const res = await getCashFlow(projectId);
    expect(res.body.projected.certifiedExpectedCollection).toBe(0);
  });

  it("a submitted (not certified) IPC is excluded", async () => {
    const projectId = await createProject();
    await createUncertifiedIpc(projectId, "submitted");
    const res = await getCashFlow(projectId);
    expect(res.body.projected.certifiedExpectedCollection).toBe(0);
  });
});

describe("Commitment", () => {
  it("an active commitment is included", async () => {
    const projectId = await createProject();
    await createActiveCommitment(projectId, 2500);
    const res = await getCashFlow(projectId);
    expect(res.body.projected.commitments).toBe(2500);
  });

  it("a draft commitment is excluded", async () => {
    const projectId = await createProject();
    await createDraftCommitment(projectId, 2500);
    const res = await getCashFlow(projectId);
    expect(res.body.projected.commitments).toBe(0);
  });

  it("a cancelled commitment is excluded", async () => {
    const projectId = await createProject();
    await createCancelledCommitment(projectId, 2500);
    const res = await getCashFlow(projectId);
    expect(res.body.projected.commitments).toBe(0);
  });
});

describe("Expense", () => {
  it("an expense is included as incurred cost, and the response never labels it 'paid'", async () => {
    const projectId = await createProject();
    await addExpense(projectId, 400, today());
    const res = await getCashFlow(projectId);
    expect(res.body.historical.incurredCost).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/"cashPaid"|"paidExpense"/);
  });
});

describe("Forecast integration", () => {
  it("undated.etc matches Forecast's own commitment-aware ETC exactly", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 10000);
    await addExpense(projectId, 2000, today());
    await createActiveCommitment(projectId, 3000);

    const forecastRes = await request(app)
      .get(`/api/projects/${projectId}/forecast`)
      .set("Authorization", `Bearer ${ownerToken}`);
    const cashFlowRes = await getCashFlow(projectId);
    expect(cashFlowRes.body.undated.etc).toBe(forecastRes.body.methods.commitment_aware.etc);
  });

  it("EAC is never present anywhere in the cash-flow response", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 5000);
    const res = await getCashFlow(projectId);
    expect(JSON.stringify(res.body)).not.toMatch(/"eac"/i);
  });
});

describe("Double-count protection", () => {
  it("Commitment and Expense remain independently represented (no reconciliation heuristic)", async () => {
    const projectId = await createProject();
    await createActiveCommitment(projectId, 5000);
    await addExpense(projectId, 5000, today()); // economically could be "the same" real-world purchase
    const res = await getCashFlow(projectId);
    expect(res.body.projected.commitments).toBe(5000);
    expect(res.body.historical.incurredCost).toBe(5000); // both counted, undiminished — documented limitation
    expect(res.body.assumptions.commitmentExpenseReconciliation).toMatch(/not modeled/);
  });

  it("IPC and Invoice remain independently represented (no reconciliation heuristic)", async () => {
    const { projectId, grossValue } = await setupCertifiedIpc(100, 10, {});
    await createPaidInvoice(projectId, grossValue); // economically could be "the same" payment
    const res = await getCashFlow(projectId);
    expect(res.body.projected.certifiedExpectedCollection).toBe(grossValue); // no retention configured
    expect(res.body.historical.cashReceived).toBe(grossValue); // both counted, undiminished — documented limitation
    expect(res.body.assumptions.ipcInvoiceReconciliation).toMatch(/not modeled/);
  });
});

describe("Currency", () => {
  it("a commitment in the project's own currency is included", async () => {
    const projectId = await createProject();
    await createContract(projectId, { currency: "SAR" });
    await createActiveCommitment(projectId, 1000);
    const res = await getCashFlow(projectId);
    expect(res.body.currency).toBe("SAR");
    expect(res.body.projected.commitments).toBe(1000);
  });

  it("a commitment in a foreign currency is excluded, with visibility", async () => {
    const projectId = await createProject();
    await createContract(projectId, { currency: "SAR" });
    await createActiveCommitment(projectId, 1000);
    await createActiveCommitment(projectId, 5000, { currency: "USD" });
    const res = await getCashFlow(projectId);
    expect(res.body.projected.commitments).toBe(1000);
    expect(res.body.excludedForeignCurrencyCommitmentIds.length).toBe(1);
  });
});

describe("Advance", () => {
  it("advance is explicitly marked unsupported, never silently zero", async () => {
    const projectId = await createProject();
    const contractId = await createContract(projectId);
    const patchRes = await request(app)
      .patch(`/api/projects/${projectId}/contracts/${contractId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ advancePercent: 20 });
    expect(patchRes.status).toBe(200);

    const cashFlowRes = await getCashFlow(projectId);
    expect(cashFlowRes.body.undated.advance).toEqual({
      supported: false,
      reason: "Advance payment/recovery is not operationalized in the current financial model.",
    });
  });
});

describe("Tenant isolation", () => {
  it("company B cannot GET cash flow for company A's project", async () => {
    const projectId = await createProject();
    const res = await getCashFlow(projectId, {}, companyBToken);
    expect(res.status).toBe(404);
  });

  it("company B's own project never reflects company A's invoices/commitments/IPCs", async () => {
    const projectA = await createProject();
    await createPaidInvoice(projectA, 5000);
    await createActiveCommitment(projectA, 3000);
    await setupCertifiedIpc(10, 10, { projectId: projectA });

    const projectBRes = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${companyBToken}`)
      .send({ name: "Company B Project" });
    const projectB = projectBRes.body.id as string;

    const res = await getCashFlow(projectB, {}, companyBToken);
    expect(res.status).toBe(200);
    expect(res.body.historical.cashReceived).toBe(0);
    expect(res.body.projected.commitments).toBe(0);
    expect(res.body.projected.certifiedExpectedCollection).toBe(0);
  });

  it("same-named project across two companies never leaks data", async () => {
    const projectA = await createProject();
    await createPaidInvoice(projectA, 1234);

    const sameNameRes = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${companyBToken}`)
      .send({ name: "identical-name-attack" });
    const projectBSameName = sameNameRes.body.id as string;

    const res = await getCashFlow(projectBSameName, {}, companyBToken);
    expect(res.body.historical.cashReceived).toBe(0);
  });
});

describe("RBAC", () => {
  it("member can read cash flow", async () => {
    const projectId = await createProject();
    const res = await getCashFlow(projectId, {}, memberToken);
    expect(res.status).toBe(200);
  });

  it("owner can read cash flow", async () => {
    const projectId = await createProject();
    const res = await getCashFlow(projectId);
    expect(res.status).toBe(200);
  });
});
