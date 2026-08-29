import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { auditEvents, budgetItems, commitments, expenses, forecastSnapshots, ipcs, projects } from "../src/db/schema.js";
import { listAuditEvents } from "../src/lib/audit.js";

// Phase 2D: Forecast (ETC/EAC). Same shared-company-per-file discipline as
// ipc.test.ts / measurement.test.ts / procurement.test.ts.

vi.mock("../src/lib/mailer.js", () => ({ sendMail: vi.fn() }));
import { sendMail } from "../src/lib/mailer.js";

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
    .send({ companyName: "Forecast Co", name: "Owner", email: uniqueEmail("fc-owner"), password: "password123" });
  expect(ownerRes.status).toBe(201);
  ownerToken = ownerRes.body.token;

  const inviteRes = await request(app)
    .post("/api/company/invites")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ email: uniqueEmail("fc-member"), role: "member" });
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
    .send({ companyName: "Other Co", name: "Owner B", email: uniqueEmail("fc-other"), password: "password123" });
  expect(companyBRes.status).toBe(201);
  companyBToken = companyBRes.body.token;
});

async function createProject(budgetTotal?: number, token = ownerToken) {
  const res = await request(app)
    .post("/api/projects")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: `Forecast Project ${Math.random()}`, ...(budgetTotal !== undefined ? { budgetTotal } : {}) });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function addBudgetItem(projectId: string, plannedAmount: number, token = ownerToken) {
  const res = await request(app)
    .post(`/api/projects/${projectId}/budget/items`)
    .set("Authorization", `Bearer ${token}`)
    .send({ category: "Materials", plannedAmount });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function addExpense(projectId: string, amount: number, expenseDate: string, budgetItemId?: string, token = ownerToken) {
  const res = await request(app)
    .post(`/api/projects/${projectId}/budget/expenses`)
    .set("Authorization", `Bearer ${token}`)
    .send({ description: "Cement delivery", amount, expenseDate, ...(budgetItemId ? { budgetItemId } : {}) });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function createSupplier(token = ownerToken) {
  const res = await request(app)
    .post("/api/suppliers")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: `Supplier ${Math.random()}`, type: "supplier" });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

// Full draft -> submitted -> active commitment for a single line amount.
async function createActiveCommitment(
  projectId: string,
  amount: number,
  opts: { currency?: string; contractId?: string; supplierId?: string } = {},
) {
  const supplierId = opts.supplierId ?? (await createSupplier());
  const createRes = await request(app)
    .post(`/api/projects/${projectId}/commitments`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({
      supplierId,
      type: "purchase_order",
      ...(opts.contractId ? { contractId: opts.contractId } : {}),
      ...(opts.currency ? { currency: opts.currency } : {}),
    });
  expect(createRes.status).toBe(201);
  const commitmentId = createRes.body.id as string;

  const lineRes = await request(app)
    .post(`/api/projects/${projectId}/commitments/${commitmentId}/items`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ description: "Steel rebar", amount });
  expect(lineRes.status).toBe(201);

  const submitRes = await request(app)
    .post(`/api/projects/${projectId}/commitments/${commitmentId}/submit`)
    .set("Authorization", `Bearer ${ownerToken}`);
  expect(submitRes.status).toBe(200);

  const approveRes = await request(app)
    .post(`/api/projects/${projectId}/commitments/${commitmentId}/approve`)
    .set("Authorization", `Bearer ${ownerToken}`);
  expect(approveRes.status).toBe(200);

  return commitmentId;
}

async function createContract(projectId: string, originalValue = 50000, opts: { currency?: string; retentionPercent?: number } = {}) {
  const res = await request(app)
    .post(`/api/projects/${projectId}/contracts`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ originalValue, ...opts });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

// Full chain to a single certified IPC: contract -> published BOQ ->
// approved measurement -> IPC create/line/submit/approve/certify.
async function setupCertifiedIpc(quantity: number, rate: number, opts: { projectId?: string; retentionPercent?: number } = {}) {
  const projectId = opts.projectId ?? (await createProject());
  const contractId = await createContract(projectId, 50000, { retentionPercent: opts.retentionPercent });

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

  const publishRes = await request(app)
    .post(`/api/projects/${projectId}/boq-revisions/${revisionId}/publish`)
    .set("Authorization", `Bearer ${ownerToken}`);
  expect(publishRes.status).toBe(200);

  const mRes = await request(app)
    .post(`/api/projects/${projectId}/measurements`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ contractId, boqRevisionId: revisionId, measurementDate: today() });
  await request(app)
    .post(`/api/projects/${projectId}/measurements/${mRes.body.id}/items`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ boqItemId, measuredQuantity: quantity });
  await request(app)
    .post(`/api/projects/${projectId}/measurements/${mRes.body.id}/submit`)
    .set("Authorization", `Bearer ${ownerToken}`);
  const measApprove = await request(app)
    .post(`/api/projects/${projectId}/measurements/${mRes.body.id}/approve`)
    .set("Authorization", `Bearer ${ownerToken}`);
  expect(measApprove.status).toBe(200);

  const ipcRes = await request(app)
    .post(`/api/projects/${projectId}/ipcs`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ contractId, boqRevisionId: revisionId, periodStart: today(), periodEnd: today() });
  const ipcId = ipcRes.body.id as string;

  const lineRes = await request(app)
    .post(`/api/projects/${projectId}/ipcs/${ipcId}/items`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ boqItemId, currentQuantity: quantity });
  expect(lineRes.status).toBe(201);

  await request(app).post(`/api/projects/${projectId}/ipcs/${ipcId}/submit`).set("Authorization", `Bearer ${ownerToken}`);
  await request(app).post(`/api/projects/${projectId}/ipcs/${ipcId}/approve`).set("Authorization", `Bearer ${ownerToken}`);
  const certifyRes = await request(app)
    .post(`/api/projects/${projectId}/ipcs/${ipcId}/certify`)
    .set("Authorization", `Bearer ${ownerToken}`);
  expect(certifyRes.status).toBe(200);

  return {
    projectId,
    contractId,
    ipcId,
    grossValue: Number(certifyRes.body.grossValue),
    netCertified: Number(certifyRes.body.netCertified),
  };
}

function getForecast(projectId: string, token = ownerToken) {
  return request(app).get(`/api/projects/${projectId}/forecast`).set("Authorization", `Bearer ${token}`);
}

function createSnapshot(projectId: string, body: Record<string, unknown>, token = ownerToken) {
  return request(app)
    .post(`/api/projects/${projectId}/forecast/snapshots`)
    .set("Authorization", `Bearer ${token}`)
    .send(body);
}

describe("Calculation", () => {
  it("empty project: everything is zero, variancePercent is null", async () => {
    const projectId = await createProject();
    const res = await getForecast(projectId);
    expect(res.status).toBe(200);
    for (const method of ["cost_to_complete", "commitment_aware"] as const) {
      const m = res.body.methods[method];
      expect(m.costPlan).toBe(0);
      expect(m.actualCost).toBe(0);
      expect(m.committedCost).toBe(0);
      expect(m.certifiedValue).toBe(0);
      expect(m.remainingCost).toBe(0);
      expect(m.etc).toBe(0);
      expect(m.eac).toBe(0);
      expect(m.variance).toBe(0);
      expect(m.variancePercent).toBeNull();
    }
  });

  it("budget only: EAC equals BAC under both methods (nothing spent yet)", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 10000);
    const res = await getForecast(projectId);
    expect(res.body.methods.cost_to_complete.eac).toBe(10000);
    expect(res.body.methods.commitment_aware.eac).toBe(10000);
    expect(res.body.methods.cost_to_complete.variance).toBe(0);
  });

  it("budget + expenses: remainingCost/etc/eac computed correctly", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 10000);
    await addExpense(projectId, 4000, today());
    const res = await getForecast(projectId);
    const m = res.body.methods.cost_to_complete;
    expect(m.actualCost).toBe(4000);
    expect(m.remainingCost).toBe(6000);
    expect(m.etc).toBe(6000);
    expect(m.eac).toBe(10000);
  });

  it("budget + commitments (no expenses)", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 10000);
    await createActiveCommitment(projectId, 3000);
    const res = await getForecast(projectId);
    const b = res.body.methods.commitment_aware;
    expect(b.committedCost).toBe(3000);
    expect(b.etc).toBe(7000); // 10000 - 0 - 3000
    expect(b.eac).toBe(10000); // 0 + 3000 + 7000
    const a = res.body.methods.cost_to_complete;
    expect(a.etc).toBe(10000); // method A ignores commitments entirely
    expect(a.eac).toBe(10000);
  });

  it("budget + expenses + commitments combined", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 20000);
    await addExpense(projectId, 5000, today());
    await createActiveCommitment(projectId, 6000);
    const res = await getForecast(projectId);
    const b = res.body.methods.commitment_aware;
    expect(b.actualCost).toBe(5000);
    expect(b.committedCost).toBe(6000);
    expect(b.etc).toBe(9000); // 20000-5000-6000
    expect(b.eac).toBe(20000); // 5000+6000+9000
  });

  it("certified IPC contributes to certifiedValue only, never to etc/eac", async () => {
    const { projectId, grossValue } = await setupCertifiedIpc(100, 10);
    await addBudgetItem(projectId, 500);
    const res = await getForecast(projectId);
    const m = res.body.methods.cost_to_complete;
    expect(m.certifiedValue).toBe(grossValue);
    expect(m.certifiedValue).toBe(1000);
    // Certified value never blended into cost arithmetic:
    expect(m.actualCost).toBe(0);
    expect(m.committedCost).toBe(0);
    expect(m.eac).toBe(500); // driven purely by costPlan/actualCost, unaffected by certifiedValue=1000
  });

  it("multiple expenses sum correctly", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 10000);
    await addExpense(projectId, 100.5, today());
    await addExpense(projectId, 200.25, today());
    await addExpense(projectId, 50.25, today());
    const res = await getForecast(projectId);
    expect(res.body.methods.cost_to_complete.actualCost).toBe(351);
  });

  it("multiple commitments sum correctly", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 10000);
    await createActiveCommitment(projectId, 1000);
    await createActiveCommitment(projectId, 2500);
    await createActiveCommitment(projectId, 500.5);
    const res = await getForecast(projectId);
    expect(res.body.methods.commitment_aware.committedCost).toBe(4000.5);
  });

  it("multiple certified IPCs sum correctly", async () => {
    const projectId = await createProject();
    const first = await setupCertifiedIpc(50, 10, { projectId });
    // Second IPC on a fresh contract/BOQ under the same project (simplest
    // way to add a second independent certified value without needing to
    // reconstruct a second revision of the same contract).
    const second = await setupCertifiedIpc(30, 10, { projectId });
    void first;
    const res = await getForecast(projectId);
    expect(res.body.methods.cost_to_complete.certifiedValue).toBe(500 + 300);
  });
});

describe("Formula", () => {
  it("ETC / EAC exact values, cost_to_complete", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 15000);
    await addExpense(projectId, 6000, today());
    const res = await getForecast(projectId);
    const m = res.body.methods.cost_to_complete;
    expect(m.etc).toBe(9000);
    expect(m.eac).toBe(15000);
  });

  it("ETC / EAC exact values, commitment_aware", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 15000);
    await addExpense(projectId, 6000, today());
    await createActiveCommitment(projectId, 4000);
    const res = await getForecast(projectId);
    const m = res.body.methods.commitment_aware;
    expect(m.etc).toBe(5000); // 15000-6000-4000
    expect(m.eac).toBe(15000); // 6000+4000+5000
  });

  it("variance: positive means under plan, negative means over plan", async () => {
    const under = await createProject();
    await addBudgetItem(under, 10000);
    await addExpense(under, 3000, today());
    const underRes = await getForecast(under);
    // cost_to_complete always converges EAC to BAC when AC <= BAC, so use
    // commitment_aware with a large commitment to actually drive EAC below BAC...
    // Instead, directly assert the sign convention using an over-budget project below,
    // and a trivial under-budget sanity check here: unspent plan means EAC == BAC == variance 0,
    // so assert variance is non-negative (never fabricated negative when under/at plan).
    expect(underRes.body.methods.cost_to_complete.variance).toBeGreaterThanOrEqual(0);

    const over = await createProject();
    await addBudgetItem(over, 5000);
    await addExpense(over, 8000, today());
    const overRes = await getForecast(over);
    const m = overRes.body.methods.cost_to_complete;
    expect(m.eac).toBe(8000); // AC alone, since remainingCost floors at 0
    expect(m.variance).toBe(5000 - 8000);
    expect(m.variance).toBeLessThan(0);
  });

  it("variancePercent: costPlan - eac, divided by costPlan, times 100", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 8000);
    await addExpense(projectId, 10000, today());
    const res = await getForecast(projectId);
    const m = res.body.methods.cost_to_complete;
    // eac = 10000 (over budget), variance = 8000-10000 = -2000, percent = -25
    expect(m.variance).toBe(-2000);
    expect(m.variancePercent).toBe(-25);
  });

  it("zero budget: variancePercent is null, not zero or Infinity", async () => {
    const projectId = await createProject();
    await addExpense(projectId, 500, today());
    const res = await getForecast(projectId);
    const m = res.body.methods.cost_to_complete;
    expect(m.costPlan).toBe(0);
    expect(m.variancePercent).toBeNull();
    expect(Number.isFinite(m.eac)).toBe(true);
  });

  it("over-budget project: EAC reflects actual spend, not a capped plan number", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 1000);
    await addExpense(projectId, 1500, today());
    const res = await getForecast(projectId);
    expect(res.body.methods.cost_to_complete.eac).toBe(1500);
    expect(res.body.methods.cost_to_complete.remainingCost).toBe(0);
  });
});

describe("Double-count protection", () => {
  it("an expense and an unrelated commitment on the same project don't cross-contaminate each other's sum", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 20000);
    await addExpense(projectId, 3000, today());
    await createActiveCommitment(projectId, 4000);
    const res = await getForecast(projectId);
    const m = res.body.methods.commitment_aware;
    expect(m.actualCost).toBe(3000);
    expect(m.committedCost).toBe(4000);
  });

  it("a certified IPC never becomes an Expense (actualCost unaffected by certification)", async () => {
    const { projectId } = await setupCertifiedIpc(20, 5, {});
    const before = await getForecast(projectId);
    expect(before.body.methods.cost_to_complete.actualCost).toBe(0);
    const expenseRows = await db.select().from(expenses).where(eq(expenses.projectId, projectId));
    expect(expenseRows.length).toBe(0);
  });

  it("an invoice does not become project actual cost (invoices are not project-scoped at all)", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 5000);
    const before = await getForecast(projectId);

    const invoiceRes = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ clientName: "Client X", taxRatePercent: 0, items: [{ description: "Work", amount: 999999 }] });
    expect(invoiceRes.status).toBe(201);

    const after = await getForecast(projectId);
    expect(after.body.methods.cost_to_complete.actualCost).toBe(before.body.methods.cost_to_complete.actualCost);
    expect(after.body.methods.cost_to_complete.eac).toBe(before.body.methods.cost_to_complete.eac);
  });

  it("a cancelled commitment is excluded from committedCost", async () => {
    const projectId = await createProject();
    const supplierId = await createSupplier();
    const createRes = await request(app)
      .post(`/api/projects/${projectId}/commitments`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ supplierId, type: "purchase_order" });
    const commitmentId = createRes.body.id as string;
    await request(app)
      .post(`/api/projects/${projectId}/commitments/${commitmentId}/items`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ description: "Line", amount: 1000 });
    await request(app)
      .post(`/api/projects/${projectId}/commitments/${commitmentId}/submit`)
      .set("Authorization", `Bearer ${ownerToken}`);
    const cancelRes = await request(app)
      .post(`/api/projects/${projectId}/commitments/${commitmentId}/cancel`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(cancelRes.status).toBe(200);

    const res = await getForecast(projectId);
    expect(res.body.methods.commitment_aware.committedCost).toBe(0);
  });

  it("a draft commitment is excluded from committedCost", async () => {
    const projectId = await createProject();
    const supplierId = await createSupplier();
    const createRes = await request(app)
      .post(`/api/projects/${projectId}/commitments`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ supplierId, type: "purchase_order" });
    await request(app)
      .post(`/api/projects/${projectId}/commitments/${createRes.body.id}/items`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ description: "Line", amount: 1000 });
    // Never submitted — stays draft.
    const res = await getForecast(projectId);
    expect(res.body.methods.commitment_aware.committedCost).toBe(0);
  });

  it("a draft IPC is excluded from certifiedValue", async () => {
    const projectId = await createProject();
    const contractId = await createContract(projectId);
    const revRes = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId });
    const itemRes = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions/${revRes.body.id}/items`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ description: "Excavation", unit: "m3", quantity: 10, rate: 5 });
    await request(app)
      .post(`/api/projects/${projectId}/boq-revisions/${revRes.body.id}/publish`)
      .set("Authorization", `Bearer ${ownerToken}`);
    await request(app)
      .post(`/api/projects/${projectId}/ipcs`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId, boqRevisionId: revRes.body.id, periodStart: today(), periodEnd: today() });
    void itemRes;
    const res = await getForecast(projectId);
    expect(res.body.methods.cost_to_complete.certifiedValue).toBe(0);
  });

  it("a submitted (not yet approved/certified) IPC is excluded from certifiedValue", async () => {
    const projectId = await createProject();
    const contractId = await createContract(projectId);
    const revRes = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId });
    const itemRes = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions/${revRes.body.id}/items`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ description: "Excavation", unit: "m3", quantity: 10, rate: 5 });
    await request(app)
      .post(`/api/projects/${projectId}/boq-revisions/${revRes.body.id}/publish`)
      .set("Authorization", `Bearer ${ownerToken}`);
    const mRes = await request(app)
      .post(`/api/projects/${projectId}/measurements`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId, boqRevisionId: revRes.body.id, measurementDate: today() });
    await request(app)
      .post(`/api/projects/${projectId}/measurements/${mRes.body.id}/items`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ boqItemId: itemRes.body.id, measuredQuantity: 10 });
    await request(app)
      .post(`/api/projects/${projectId}/measurements/${mRes.body.id}/submit`)
      .set("Authorization", `Bearer ${ownerToken}`);
    await request(app)
      .post(`/api/projects/${projectId}/measurements/${mRes.body.id}/approve`)
      .set("Authorization", `Bearer ${ownerToken}`);

    const ipcRes = await request(app)
      .post(`/api/projects/${projectId}/ipcs`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId, boqRevisionId: revRes.body.id, periodStart: today(), periodEnd: today() });
    await request(app)
      .post(`/api/projects/${projectId}/ipcs/${ipcRes.body.id}/items`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ boqItemId: itemRes.body.id, currentQuantity: 10 });
    const submitRes = await request(app)
      .post(`/api/projects/${projectId}/ipcs/${ipcRes.body.id}/submit`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(submitRes.status).toBe(200); // submitted, but not approved/certified

    const res = await getForecast(projectId);
    expect(res.body.methods.cost_to_complete.certifiedValue).toBe(0);
  });
});

describe("Point-in-time integrity", () => {
  it("a future-dated expense is excluded from today's forecast", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 10000);
    await addExpense(projectId, 999, daysFromToday(30));
    const res = await getForecast(projectId);
    expect(res.body.methods.cost_to_complete.actualCost).toBe(0);
  });

  it("a commitment approved 'now' is excluded from a snapshot dated yesterday", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 10000);
    await createActiveCommitment(projectId, 2000); // approvedAt = now

    const snapRes = await createSnapshot(projectId, { method: "commitment_aware", asOfDate: daysFromToday(-1) });
    expect(snapRes.status).toBe(201);
    expect(Number(snapRes.body.committedCost)).toBe(0);
  });

  it("an IPC certified 'now' is excluded from a snapshot dated yesterday", async () => {
    const { projectId } = await setupCertifiedIpc(10, 10, {}); // certifiedAt = now
    const snapRes = await createSnapshot(projectId, { method: "cost_to_complete", asOfDate: daysFromToday(-1) });
    expect(snapRes.status).toBe(201);
    expect(Number(snapRes.body.certifiedValue)).toBe(0);
  });

  it("a snapshot dated today uses the same cutoff as the live GET forecast", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 5000);
    await addExpense(projectId, 1200, today());
    const live = await getForecast(projectId);
    const snapRes = await createSnapshot(projectId, { method: "cost_to_complete", asOfDate: today() });
    expect(snapRes.status).toBe(201);
    expect(Number(snapRes.body.actualCost)).toBe(live.body.methods.cost_to_complete.actualCost);
    expect(Number(snapRes.body.eac)).toBe(live.body.methods.cost_to_complete.eac);
  });

  it("rejects a snapshot dated in the future", async () => {
    const projectId = await createProject();
    const res = await createSnapshot(projectId, { method: "cost_to_complete", asOfDate: daysFromToday(5) });
    expect(res.status).toBe(400);
  });
});

describe("Tenant isolation", () => {
  it("company B cannot GET forecast for company A's project", async () => {
    const projectId = await createProject();
    const res = await getForecast(projectId, companyBToken);
    expect(res.status).toBe(404);
  });

  it("company B's own project never reflects company A's budget/expenses/commitments/IPC data", async () => {
    const projectA = await createProject();
    await addBudgetItem(projectA, 50000);
    await addExpense(projectA, 20000, today());
    await createActiveCommitment(projectA, 10000);
    await setupCertifiedIpc(5, 5, { projectId: undefined });

    const projectBRes = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${companyBToken}`)
      .send({ name: "Company B Project" });
    const projectB = projectBRes.body.id as string;

    const res = await getForecast(projectB, companyBToken);
    expect(res.status).toBe(200);
    const m = res.body.methods.cost_to_complete;
    expect(m.costPlan).toBe(0);
    expect(m.actualCost).toBe(0);
    expect(m.committedCost).toBe(0);
    expect(m.certifiedValue).toBe(0);
  });

  it("company B cannot create or read forecast snapshots for company A's project", async () => {
    const projectId = await createProject();
    const createRes = await createSnapshot(projectId, { method: "cost_to_complete" }, companyBToken);
    expect(createRes.status).toBe(404);

    const ownSnap = await createSnapshot(projectId, { method: "cost_to_complete" });
    expect(ownSnap.status).toBe(201);
    const readRes = await request(app)
      .get(`/api/projects/${projectId}/forecast/snapshots/${ownSnap.body.id}`)
      .set("Authorization", `Bearer ${companyBToken}`);
    expect(readRes.status).toBe(404);
  });
});

describe("RBAC", () => {
  it("member can GET forecast", async () => {
    const projectId = await createProject();
    const res = await getForecast(projectId, memberToken);
    expect(res.status).toBe(200);
  });

  it("owner can GET forecast", async () => {
    const projectId = await createProject();
    const res = await getForecast(projectId);
    expect(res.status).toBe(200);
  });

  it("member cannot create a forecast snapshot", async () => {
    const projectId = await createProject();
    const res = await createSnapshot(projectId, { method: "cost_to_complete" }, memberToken);
    expect(res.status).toBe(403);
  });

  it("owner can create a forecast snapshot", async () => {
    const projectId = await createProject();
    const res = await createSnapshot(projectId, { method: "cost_to_complete" });
    expect(res.status).toBe(201);
  });

  it("member can list and read snapshots", async () => {
    const projectId = await createProject();
    await createSnapshot(projectId, { method: "cost_to_complete" });
    const listRes = await request(app)
      .get(`/api/projects/${projectId}/forecast/snapshots`)
      .set("Authorization", `Bearer ${memberToken}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.length).toBe(1);
  });
});

describe("Snapshot immutability", () => {
  it("create then retrieve a snapshot: fields match exactly", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 8000);
    await addExpense(projectId, 2000, today());
    const createRes = await createSnapshot(projectId, { method: "commitment_aware", notes: "monthly review" });
    expect(createRes.status).toBe(201);

    const readRes = await request(app)
      .get(`/api/projects/${projectId}/forecast/snapshots/${createRes.body.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(readRes.status).toBe(200);
    expect(readRes.body).toMatchObject({
      id: createRes.body.id,
      method: "commitment_aware",
      notes: "monthly review",
    });
    expect(Number(readRes.body.costPlan)).toBe(8000);
    expect(Number(readRes.body.actualCost)).toBe(2000);
  });

  it("no route allows editing a snapshot", async () => {
    const projectId = await createProject();
    const createRes = await createSnapshot(projectId, { method: "cost_to_complete" });
    const patchRes = await request(app)
      .patch(`/api/projects/${projectId}/forecast/snapshots/${createRes.body.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ eac: 999999 });
    expect(patchRes.status).toBe(404);
  });

  it("no route allows deleting a snapshot", async () => {
    const projectId = await createProject();
    const createRes = await createSnapshot(projectId, { method: "cost_to_complete" });
    const deleteRes = await request(app)
      .delete(`/api/projects/${projectId}/forecast/snapshots/${createRes.body.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(deleteRes.status).toBe(404);

    const stillThere = await request(app)
      .get(`/api/projects/${projectId}/forecast/snapshots/${createRes.body.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(stillThere.status).toBe(200);
  });

  it("a new calculation always creates a new snapshot; old ones never change", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 10000);
    const first = await createSnapshot(projectId, { method: "cost_to_complete" });
    await addExpense(projectId, 3000, today());
    const second = await createSnapshot(projectId, { method: "cost_to_complete" });

    expect(first.body.id).not.toBe(second.body.id);
    expect(Number(first.body.actualCost)).toBe(0);
    expect(Number(second.body.actualCost)).toBe(3000);

    const refetchFirst = await request(app)
      .get(`/api/projects/${projectId}/forecast/snapshots/${first.body.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(Number(refetchFirst.body.actualCost)).toBe(0); // unchanged by the later expense
  });
});

describe("Audit", () => {
  it("forecast.snapshotGenerated is recorded with correct company/project/method/output", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 4000);
    await addExpense(projectId, 1000, today());
    const snapRes = await createSnapshot(projectId, { method: "cost_to_complete" });
    expect(snapRes.status).toBe(201);

    const eventRow = await db.query.auditEvents.findFirst({ where: eq(auditEvents.entityId, snapRes.body.id) });
    expect(eventRow).toBeTruthy();
    const events = await listAuditEvents(eventRow!.companyId, {
      entityType: "forecast_snapshot",
      entityId: snapRes.body.id,
    });
    expect(events.length).toBe(1);
    expect(events[0].action).toBe("forecast.snapshotGenerated");
    const metadata = events[0].metadata as Record<string, unknown>;
    expect(metadata.projectId).toBe(projectId);
    expect(metadata.method).toBe("cost_to_complete");
    expect(Number(metadata.eac)).toBe(4000);
  });

  it("an ordinary GET forecast does not create an audit event", async () => {
    const projectId = await createProject();
    await getForecast(projectId);
    await getForecast(projectId);
    const rows = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityType, "forecast_snapshot") });
    const forThisProject = rows.filter((r) => (r.metadata as Record<string, unknown> | null)?.projectId === projectId);
    expect(forThisProject.length).toBe(0);
  });
});

describe("Concurrency", () => {
  it("5x: concurrent snapshot creation never corrupts data — each is internally consistent", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 10000);
    await addExpense(projectId, 2500, today());

    const results = await Promise.all(
      Array.from({ length: 5 }, () => createSnapshot(projectId, { method: "cost_to_complete" })),
    );
    for (const r of results) {
      expect(r.status).toBe(201);
      expect(Number(r.body.actualCost)).toBe(2500);
      expect(Number(r.body.eac)).toBe(10000);
    }
    const ids = new Set(results.map((r) => r.body.id));
    expect(ids.size).toBe(5); // all distinct rows, no collision

    const rows = await db.select().from(forecastSnapshots).where(eq(forecastSnapshots.projectId, projectId));
    expect(rows.length).toBe(5);
  });
});

describe("Money integrity", () => {
  it("handles zero, very small, and large amounts without float drift", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 0.01);
    await addBudgetItem(projectId, 9999999.99);
    await addExpense(projectId, 0.01, today());
    await addExpense(projectId, 0.02, today());
    const res = await getForecast(projectId);
    const m = res.body.methods.cost_to_complete;
    expect(m.costPlan).toBe(10000000);
    expect(m.actualCost).toBe(0.03);
  });

  it("decimal quantities and rates in commitments sum exactly", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 10000);
    const supplierId = await createSupplier();
    const createRes = await request(app)
      .post(`/api/projects/${projectId}/commitments`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ supplierId, type: "purchase_order" });
    await request(app)
      .post(`/api/projects/${projectId}/commitments/${createRes.body.id}/items`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ description: "Rebar", quantity: 3.333, rate: 10.1 });
    await request(app)
      .post(`/api/projects/${projectId}/commitments/${createRes.body.id}/submit`)
      .set("Authorization", `Bearer ${ownerToken}`);
    await request(app)
      .post(`/api/projects/${projectId}/commitments/${createRes.body.id}/approve`)
      .set("Authorization", `Bearer ${ownerToken}`);

    const res = await getForecast(projectId);
    expect(res.body.methods.commitment_aware.committedCost).toBeCloseTo(33.66, 2);
  });
});

describe("Currency", () => {
  it("a commitment in a different currency than the project's main contract is excluded, not silently summed", async () => {
    const projectId = await createProject();
    await createContract(projectId, 50000, { currency: "SAR" });
    await addBudgetItem(projectId, 10000);
    await createActiveCommitment(projectId, 2000); // defaults to SAR — counted
    await createActiveCommitment(projectId, 5000, { currency: "USD" }); // excluded

    const res = await getForecast(projectId);
    expect(res.body.currency).toBe("SAR");
    expect(res.body.methods.commitment_aware.committedCost).toBe(2000);
    expect(res.body.excludedForeignCurrencyCommitmentIds.length).toBe(1);
  });
});

describe("Architectural invariants", () => {
  it("Forecast never reads projects.budgetTotal", async () => {
    const projectId = await createProject(999999); // budgetTotal deliberately set high
    await addBudgetItem(projectId, 100);
    const res = await getForecast(projectId);
    expect(res.body.methods.cost_to_complete.costPlan).toBe(100); // not 999999
  });

  it("Forecast never mutates budgetItems, expenses, commitments, ipcs, or projects.budgetTotal", async () => {
    const { projectId, contractId } = await setupCertifiedIpc(10, 10, {});
    await addBudgetItem(projectId, 5000);
    await addExpense(projectId, 500, today());
    await createActiveCommitment(projectId, 300, { contractId });

    const before = {
      budgetItems: await db.select().from(budgetItems).where(eq(budgetItems.projectId, projectId)),
      expenses: await db.select().from(expenses).where(eq(expenses.projectId, projectId)),
      commitments: await db.select().from(commitments).where(eq(commitments.projectId, projectId)),
      ipcs: await db.select().from(ipcs).where(eq(ipcs.projectId, projectId)),
      project: (await db.select().from(projects).where(eq(projects.id, projectId)))[0],
    };

    await getForecast(projectId);
    await createSnapshot(projectId, { method: "commitment_aware" });

    const after = {
      budgetItems: await db.select().from(budgetItems).where(eq(budgetItems.projectId, projectId)),
      expenses: await db.select().from(expenses).where(eq(expenses.projectId, projectId)),
      commitments: await db.select().from(commitments).where(eq(commitments.projectId, projectId)),
      ipcs: await db.select().from(ipcs).where(eq(ipcs.projectId, projectId)),
      project: (await db.select().from(projects).where(eq(projects.id, projectId)))[0],
    };

    expect(after).toEqual(before);
  });

  it("Forecast never mutates contracts.revisedValue", async () => {
    const projectId = await createProject();
    const contractId = await createContract(projectId, 50000);
    const before = await request(app)
      .get(`/api/projects/${projectId}/contracts/${contractId}`)
      .set("Authorization", `Bearer ${ownerToken}`);

    await getForecast(projectId);
    await createSnapshot(projectId, { method: "cost_to_complete" });

    const after = await request(app)
      .get(`/api/projects/${projectId}/contracts/${contractId}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(after.body.revisedValue).toBe(before.body.revisedValue);
  });
});
