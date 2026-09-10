import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { eq, and } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import {
  auditEvents,
  budgetAlerts,
  budgetItems,
  commitments,
  commitmentLines,
  expenses,
  forecastSnapshots,
  invoices,
  payrollPeriods,
  laborAllocations,
  nitaqatComplianceRecords,
  zatcaEgsUnits,
} from "../src/db/schema.js";

// MIDAD Phase E — Proactive Budget Overrun Alerts. Covers all 4 implemented
// rules (budget_consumption_threshold, forecast_over_budget,
// actual_commitments_over_budget, cost_code_risk), the OPEN->ACKNOWLEDGED->
// RESOLVED lifecycle with server-owned actor/timestamp fields, dedup/
// concurrency, tenant isolation, mass-assignment protection, financial-truth
// regression, and audit. Rules 5 (burn rate) and 6 (consumption vs.
// progress) are intentionally NOT implemented — see lib/budgetAlerts.ts's
// own file-level comment for why — and are asserted to never appear.

vi.mock("../src/lib/mailer.js", () => ({ sendMail: vi.fn() }));
import { sendMail } from "../src/lib/mailer.js";

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

let ownerToken: string;
let memberToken: string;
let companyBToken: string;
let portalToken: string;

beforeAll(async () => {
  await resetDb();

  const ownerRes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Budget Alerts Co", name: "Owner", email: uniqueEmail("ba-owner"), password: "password123" });
  expect(ownerRes.status).toBe(201);
  ownerToken = ownerRes.body.token;

  const inviteRes = await request(app)
    .post("/api/company/invites")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ email: uniqueEmail("ba-member"), role: "member" });
  const mailCall = (sendMail as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
  const inviteToken = (mailCall[2] as string).match(/token=([a-f0-9]{40,80})/)![1];
  const acceptRes = await request(app)
    .post("/api/auth/accept-invite")
    .send({ token: inviteToken, name: "Member", password: "memberpass123" });
  expect(acceptRes.status).toBe(201);
  memberToken = acceptRes.body.token;

  const companyBRes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Other Co", name: "Owner B", email: uniqueEmail("ba-other"), password: "password123" });
  companyBToken = companyBRes.body.token;

  const portalEmail = uniqueEmail("ba-portal-client");
  await request(app)
    .post("/api/client-portal-users")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ name: "عميل", email: portalEmail, password: "clientpass123" });
  const portalLogin = await request(app).post("/api/portal/auth/login").send({ email: portalEmail, password: "clientpass123" });
  portalToken = portalLogin.body.token;
});

async function createProject(token = ownerToken) {
  const res = await request(app)
    .post("/api/projects")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: `Budget Alert Project ${Math.random()}` });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function addBudgetItem(projectId: string, plannedAmount: number, costCodeId?: string, token = ownerToken) {
  const res = await request(app)
    .post(`/api/projects/${projectId}/budget/items`)
    .set("Authorization", `Bearer ${token}`)
    .send({ category: "Materials", plannedAmount });
  expect(res.status).toBe(201);
  const itemId = res.body.id as string;
  if (costCodeId) {
    // budget.ts's PATCH item schema is category/plannedAmount only — this
    // codebase's budgetItems.costCodeId is set via direct DB write in tests
    // (no route sets it post-creation), matching how forecast.test.ts's own
    // fixtures work with fields the create route doesn't expose either.
    await db.update(budgetItems).set({ costCodeId }).where(eq(budgetItems.id, itemId));
  }
  return itemId;
}

async function addExpense(projectId: string, amount: number, expenseDate: string, opts: { budgetItemId?: string; costCodeId?: string } = {}) {
  const res = await request(app)
    .post(`/api/projects/${projectId}/budget/expenses`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ description: "Cost", amount, expenseDate, ...(opts.budgetItemId ? { budgetItemId: opts.budgetItemId } : {}) });
  expect(res.status).toBe(201);
  if (opts.costCodeId) {
    await db.update(expenses).set({ costCodeId: opts.costCodeId }).where(eq(expenses.id, res.body.id));
  }
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

async function createActiveCommitment(projectId: string, amount: number, costCodeId?: string) {
  const supplierId = await createSupplier();
  const createRes = await request(app)
    .post(`/api/projects/${projectId}/commitments`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ supplierId, type: "purchase_order" });
  const commitmentId = createRes.body.id as string;

  const lineRes = await request(app)
    .post(`/api/projects/${projectId}/commitments/${commitmentId}/items`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ description: "Line", amount });
  expect(lineRes.status).toBe(201);
  if (costCodeId) {
    await db.update(commitmentLines).set({ costCodeId }).where(eq(commitmentLines.id, lineRes.body.id));
  }

  await request(app).post(`/api/projects/${projectId}/commitments/${commitmentId}/submit`).set("Authorization", `Bearer ${ownerToken}`);
  const approveRes = await request(app)
    .post(`/api/projects/${projectId}/commitments/${commitmentId}/approve`)
    .set("Authorization", `Bearer ${ownerToken}`);
  expect(approveRes.status).toBe(200);
  return commitmentId;
}

async function createCostCode() {
  const res = await request(app)
    .post("/api/cost-codes")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ code: `CC-${Math.random().toString(36).slice(2, 8)}`, name: "Concrete Works" });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

function evaluate(body: Record<string, unknown> = {}, token = ownerToken) {
  return request(app).post("/api/budget-alerts/evaluate").set("Authorization", `Bearer ${token}`).send(body);
}
function listAlerts(query: Record<string, string> = {}, token = ownerToken) {
  const qs = new URLSearchParams(query).toString();
  return request(app).get(`/api/budget-alerts${qs ? `?${qs}` : ""}`).set("Authorization", `Bearer ${token}`);
}
function getAlert(id: string, token = ownerToken) {
  return request(app).get(`/api/budget-alerts/${id}`).set("Authorization", `Bearer ${token}`);
}
function acknowledge(id: string, token = ownerToken) {
  return request(app).post(`/api/budget-alerts/${id}/acknowledge`).set("Authorization", `Bearer ${token}`);
}
function resolve(id: string, token = ownerToken) {
  return request(app).post(`/api/budget-alerts/${id}/resolve`).set("Authorization", `Bearer ${token}`);
}

async function alertsFor(projectId: string, ruleCode: string, token = ownerToken) {
  const res = await listAlerts({ projectId }, token);
  return (res.body as Array<Record<string, unknown>>).filter((a) => a.ruleCode === ruleCode);
}

describe("Rule 1 — Budget Consumption Threshold", () => {
  it("1. below threshold -> no alert", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 10000);
    await addExpense(projectId, 1000, today());
    await evaluate({ projectId });
    expect(await alertsFor(projectId, "budget_consumption_threshold")).toHaveLength(0);
  });

  it("2. INFO threshold crossed -> INFO", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 10000);
    await addExpense(projectId, 8000, today()); // 80%
    await evaluate({ projectId });
    const hits = await alertsFor(projectId, "budget_consumption_threshold");
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("info");
    expect(hits[0].metricValue).toBe("80.00");
  });

  it("3. WARNING threshold crossed -> WARNING", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 10000);
    await addExpense(projectId, 9000, today()); // 90%
    await evaluate({ projectId });
    const hits = await alertsFor(projectId, "budget_consumption_threshold");
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("warning");
  });

  it("4. CRITICAL threshold crossed -> CRITICAL", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 10000);
    await addExpense(projectId, 10500, today()); // 105%
    await evaluate({ projectId });
    const hits = await alertsFor(projectId, "budget_consumption_threshold");
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("critical");
  });

  it("5. same evaluation twice -> no duplicate", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 10000);
    await addExpense(projectId, 9500, today());
    await evaluate({ projectId });
    await evaluate({ projectId });
    await evaluate({ projectId });
    expect(await alertsFor(projectId, "budget_consumption_threshold")).toHaveLength(1);
  });

  it("6. threshold escalation creates a new alert per tier reached", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 10000);
    await addExpense(projectId, 8000, today()); // 80% -> INFO
    await evaluate({ projectId });
    await addExpense(projectId, 1200, today()); // now 92% -> WARNING
    await evaluate({ projectId });

    const hits = await alertsFor(projectId, "budget_consumption_threshold");
    expect(hits).toHaveLength(2);
    const severities = hits.map((h) => h.severity).sort();
    expect(severities).toEqual(["info", "warning"]);
  });

  it("7. zero budget handled safely — no crash, no alert", async () => {
    const projectId = await createProject();
    await addExpense(projectId, 500, today());
    const res = await evaluate({ projectId });
    expect(res.status).toBe(200);
    expect(await alertsFor(projectId, "budget_consumption_threshold")).toHaveLength(0);
  });

  it("8. missing budget (no budgetItems at all) skips the rule entirely", async () => {
    const projectId = await createProject();
    const res = await evaluate({ projectId });
    expect(res.status).toBe(200);
    expect(res.body.createdCount).toBe(0);
  });
});

describe("Rule 2 — Forecast Above Approved Budget", () => {
  it("9. EAC below budget -> no alert", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 10000);
    await addExpense(projectId, 2000, today());
    await evaluate({ projectId });
    expect(await alertsFor(projectId, "forecast_over_budget")).toHaveLength(0);
  });

  it("10. EAC above budget -> alert, severity reflects magnitude", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 10000);
    await addExpense(projectId, 10600, today()); // EAC = 10600, 6% over -> WARNING
    await evaluate({ projectId });
    const hits = await alertsFor(projectId, "forecast_over_budget");
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("warning");

    const projectId2 = await createProject();
    await addBudgetItem(projectId2, 10000);
    await addExpense(projectId2, 12000, today()); // 20% over -> CRITICAL
    await evaluate({ projectId: projectId2 });
    const hits2 = await alertsFor(projectId2, "forecast_over_budget");
    expect(hits2[0].severity).toBe("critical");
  });

  it("11. same evaluation -> no duplicate", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 10000);
    await addExpense(projectId, 11000, today());
    await evaluate({ projectId });
    await evaluate({ projectId });
    expect(await alertsFor(projectId, "forecast_over_budget")).toHaveLength(1);
  });

  it("12. forecast not computable (budget = 0) -> rule skipped", async () => {
    const projectId = await createProject();
    await addExpense(projectId, 5000, today());
    const res = await evaluate({ projectId });
    expect(res.status).toBe(200);
    expect(await alertsFor(projectId, "forecast_over_budget")).toHaveLength(0);
  });
});

describe("Rule 3 — Actual + Commitments Above Budget", () => {
  it("13. exposure below budget -> no alert", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 20000);
    await addExpense(projectId, 5000, today());
    await createActiveCommitment(projectId, 3000);
    await evaluate({ projectId });
    expect(await alertsFor(projectId, "actual_commitments_over_budget")).toHaveLength(0);
  });

  it("14. exposure above budget -> CRITICAL alert", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 20000);
    await addExpense(projectId, 15000, today());
    await createActiveCommitment(projectId, 6000); // exposure = 21000 > 20000
    await evaluate({ projectId });
    const hits = await alertsFor(projectId, "actual_commitments_over_budget");
    expect(hits).toHaveLength(1);
    expect(hits[0].severity).toBe("critical");
    expect(hits[0].metricValue).toBe("1000.00");
  });

  it("15. same evaluation -> no duplicate", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 10000);
    await addExpense(projectId, 12000, today());
    await evaluate({ projectId });
    await evaluate({ projectId });
    expect(await alertsFor(projectId, "actual_commitments_over_budget")).toHaveLength(1);
  });

  it("16. exposure dropping back below budget never mutates the existing alert's historical snapshot", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 10000);
    const expenseId = await addExpense(projectId, 12000, today());
    await evaluate({ projectId });
    const before = (await alertsFor(projectId, "actual_commitments_over_budget"))[0];

    // Reduce exposure back under budget (delete the driving expense).
    await request(app)
      .delete(`/api/projects/${projectId}/budget/expenses/${expenseId}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    await evaluate({ projectId });

    const after = (await alertsFor(projectId, "actual_commitments_over_budget"))[0];
    expect(after.id).toBe(before.id);
    expect(after.actualAmount).toBe(before.actualAmount); // frozen snapshot, unchanged
    expect(after.status).toBe("open"); // never silently auto-resolved
  });
});

describe("Rule 4 — Cost Code Risk", () => {
  it("17. cost-code risk generated where an authoritative budget mapping exists", async () => {
    const projectId = await createProject();
    const costCodeId = await createCostCode();
    await addBudgetItem(projectId, 5000, costCodeId);
    await addExpense(projectId, 4700, today(), { costCodeId }); // 94% -> WARNING
    await evaluate({ projectId });
    const hits = await alertsFor(projectId, "cost_code_risk");
    expect(hits).toHaveLength(1);
    expect(hits[0].costCodeId).toBe(costCodeId);
    expect(hits[0].severity).toBe("warning");
  });

  it("18. correct project/cost-code association in the alert record", async () => {
    const projectId = await createProject();
    const costCodeId = await createCostCode();
    await addBudgetItem(projectId, 1000, costCodeId);
    await addExpense(projectId, 1100, today(), { costCodeId });
    await evaluate({ projectId });
    const alert = (await alertsFor(projectId, "cost_code_risk"))[0];
    const full = await getAlert(alert.id as string);
    expect(full.body.projectId).toBe(projectId);
    expect(full.body.costCodeId).toBe(costCodeId);
  });

  it("19. a cost code's spend under a DIFFERENT project never contributes to this project's cost-code risk", async () => {
    const costCodeId = await createCostCode(); // company-wide canonical code
    const projectA = await createProject();
    const projectB = await createProject();
    await addBudgetItem(projectA, 1000, costCodeId);
    await addExpense(projectA, 900, today(), { costCodeId }); // 90% on project A only

    await addBudgetItem(projectB, 5000, costCodeId); // project B has its own budget, no spend
    await evaluate({ projectId: projectB });
    expect(await alertsFor(projectB, "cost_code_risk")).toHaveLength(0);

    await evaluate({ projectId: projectA });
    expect(await alertsFor(projectA, "cost_code_risk")).toHaveLength(1);
  });

  it("20. a cost code with no budget mapped in this project never produces a false alert", async () => {
    const projectId = await createProject();
    const costCodeId = await createCostCode();
    // Expense tagged to the cost code, but NO budgetItem maps it here.
    await addExpense(projectId, 5000, today(), { costCodeId });
    const res = await evaluate({ projectId });
    expect(res.status).toBe(200);
    expect(await alertsFor(projectId, "cost_code_risk")).toHaveLength(0);
  });
});

describe("Rules intentionally not implemented (5, 6)", () => {
  it("no burn_rate or consumption_ahead_of_progress alert is ever produced, regardless of data shape", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 10000);
    for (let i = 0; i < 5; i++) {
      await addExpense(projectId, 1500, today());
    }
    await evaluate({ projectId });
    const res = await listAlerts({ projectId });
    const ruleCodes = new Set((res.body as Array<Record<string, unknown>>).map((a) => a.ruleCode));
    expect(ruleCodes.has("burn_rate")).toBe(false);
    expect(ruleCodes.has("consumption_ahead_of_progress")).toBe(false);
  });
});

describe("Lifecycle", () => {
  async function openAlert() {
    const projectId = await createProject();
    await addBudgetItem(projectId, 10000);
    await addExpense(projectId, 9500, today());
    await evaluate({ projectId });
    const alert = (await alertsFor(projectId, "budget_consumption_threshold"))[0];
    return alert.id as string;
  }

  it("29. OPEN -> ACKNOWLEDGED works", async () => {
    const id = await openAlert();
    const res = await acknowledge(id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("acknowledged");
  });

  it("30. ACKNOWLEDGED -> RESOLVED works", async () => {
    const id = await openAlert();
    await acknowledge(id);
    const res = await resolve(id);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("resolved");
  });

  it("31. invalid lifecycle transition rejected (acknowledging an already-resolved alert)", async () => {
    const id = await openAlert();
    await acknowledge(id);
    await resolve(id);
    const res = await acknowledge(id);
    expect(res.status).toBe(409);
  });

  it("32/33. acknowledgedByUserId/acknowledgedAt are server-generated, never spoofable", async () => {
    const id = await openAlert();
    const res = await request(app)
      .post(`/api/budget-alerts/${id}/acknowledge`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ acknowledgedByUserId: "11111111-1111-1111-1111-111111111111", acknowledgedAt: "2000-01-01T00:00:00.000Z" });
    expect(res.status).toBe(200);
    expect(res.body.acknowledgedByUserId).not.toBe("11111111-1111-1111-1111-111111111111");
    expect(new Date(res.body.acknowledgedAt).getFullYear()).toBeGreaterThan(2020);
  });

  it("34/35. resolvedByUserId/resolvedAt are server-generated, never spoofable", async () => {
    const id = await openAlert();
    await acknowledge(id);
    const res = await request(app)
      .post(`/api/budget-alerts/${id}/resolve`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ resolvedByUserId: "11111111-1111-1111-1111-111111111111", resolvedAt: "2000-01-01T00:00:00.000Z" });
    expect(res.status).toBe(200);
    expect(res.body.resolvedByUserId).not.toBe("11111111-1111-1111-1111-111111111111");
    expect(new Date(res.body.resolvedAt).getFullYear()).toBeGreaterThan(2020);
  });

  it("36. a resolved alert's trigger snapshot remains historically intact even as live data changes", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 10000);
    await addExpense(projectId, 9500, today());
    await evaluate({ projectId });
    const id = (await alertsFor(projectId, "budget_consumption_threshold"))[0].id as string;
    const beforeResolve = (await getAlert(id)).body;
    await resolve(id);

    await addExpense(projectId, 5000, today()); // live data changes drastically
    await evaluate({ projectId });

    const afterLiveChange = (await getAlert(id)).body;
    expect(afterLiveChange.metricValue).toBe(beforeResolve.metricValue);
    expect(afterLiveChange.actualAmount).toBe(beforeResolve.actualAmount);
    expect(afterLiveChange.status).toBe("resolved");
  });
});

describe("Security", () => {
  async function seededAlert() {
    const projectId = await createProject();
    await addBudgetItem(projectId, 10000);
    await addExpense(projectId, 9500, today());
    await evaluate({ projectId });
    const alert = (await alertsFor(projectId, "budget_consumption_threshold"))[0];
    return { projectId, alertId: alert.id as string };
  }

  it("37. unauthenticated read rejected", async () => {
    const res = await request(app).get("/api/budget-alerts");
    expect(res.status).toBe(401);
  });

  it("38. unauthenticated evaluation rejected", async () => {
    const res = await request(app).post("/api/budget-alerts/evaluate").send({});
    expect(res.status).toBe(401);
  });

  it("39. unauthenticated acknowledge rejected", async () => {
    const { alertId } = await seededAlert();
    const res = await request(app).post(`/api/budget-alerts/${alertId}/acknowledge`);
    expect(res.status).toBe(401);
  });

  it("40. unauthenticated resolve rejected", async () => {
    const { alertId } = await seededAlert();
    const res = await request(app).post(`/api/budget-alerts/${alertId}/resolve`);
    expect(res.status).toBe(401);
  });

  it("41. cross-tenant alert read rejected", async () => {
    const { alertId } = await seededAlert();
    const res = await getAlert(alertId, companyBToken);
    expect(res.status).toBe(404);
  });

  it("42. cross-tenant acknowledge rejected", async () => {
    const { alertId } = await seededAlert();
    const res = await acknowledge(alertId, companyBToken);
    expect(res.status).toBe(404);
  });

  it("43. cross-tenant resolve rejected", async () => {
    const { alertId } = await seededAlert();
    const res = await resolve(alertId, companyBToken);
    expect(res.status).toBe(404);
  });

  it("44. cross-tenant evaluation rejected", async () => {
    const { projectId } = await seededAlert();
    const res = await evaluate({ projectId }, companyBToken);
    expect(res.status).toBe(404);
  });

  it("45/46/47/49. frontend cannot supply financial values, spoof severity, ruleCode, or detectedAt on evaluate (rejected outright)", async () => {
    const projectId = await createProject();
    const res = await evaluate({
      projectId,
      budget: 10000000,
      actual: 1,
      severity: "critical",
      ruleCode: "actual_commitments_over_budget",
      detectedAt: "2000-01-01T00:00:00.000Z",
    });
    expect(res.status).toBe(400); // .strict() rejects any unknown key
  });

  it("48. frontend cannot spoof project/company ownership on evaluate", async () => {
    const projectA = await createProject(); // company A (ownerToken)
    const res = await evaluate({ projectId: projectA }, companyBToken); // company B tries to evaluate it
    expect(res.status).toBe(404);
  });

  it("50. frontend cannot spoof the audit actor for acknowledge/resolve", async () => {
    const { alertId } = await seededAlert();
    await request(app)
      .post(`/api/budget-alerts/${alertId}/acknowledge`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ actorUserId: "11111111-1111-1111-1111-111111111111" });
    const event = await db.query.auditEvents.findFirst({
      where: and(eq(auditEvents.entityId, alertId), eq(auditEvents.action, "budgetAlert.acknowledged")),
    });
    expect(event!.actorUserId).not.toBe("11111111-1111-1111-1111-111111111111");
  });

  it("51. Client Portal identity cannot access budget alerts", async () => {
    const res = await request(app).get("/api/budget-alerts").set("Authorization", `Bearer ${portalToken}`);
    expect(res.status).toBe(401);
  });

  it("52. no financial data leakage across tenants in the list", async () => {
    await seededAlert();
    const res = await listAlerts({}, companyBToken);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });
});

describe("Financial-truth regression — nothing else is modified by Budget Alerts", () => {
  it("53-63. Budget/Actual/Commitments/Forecast/CashFlow/Payroll/LaborCost/IPC/Invoices/ZATCA/Nitaqat-GOSI all unchanged", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 10000);
    await addExpense(projectId, 9500, today());
    await createActiveCommitment(projectId, 200);

    const before = {
      budgetItems: await db.select().from(budgetItems).where(eq(budgetItems.projectId, projectId)),
      expenses: await db.select().from(expenses).where(eq(expenses.projectId, projectId)),
      commitments: await db.select().from(commitments).where(eq(commitments.projectId, projectId)),
      forecastSnapshots: await db.select().from(forecastSnapshots), // Forecast: never persists via Budget Alerts
      cashFlow: await request(app).get(`/api/projects/${projectId}/cash-flow`).set("Authorization", `Bearer ${ownerToken}`).then((r) => r.body),
      payrollPeriods: await db.select().from(payrollPeriods),
      laborAllocations: await db.select().from(laborAllocations),
      invoices: await db.select().from(invoices),
      zatcaEgsUnits: await db.select().from(zatcaEgsUnits),
      nitaqat: await db.select().from(nitaqatComplianceRecords),
    };

    await evaluate({ projectId });
    const alertId = (await alertsFor(projectId, "budget_consumption_threshold"))[0]?.id as string | undefined;
    if (alertId) {
      await acknowledge(alertId);
      await resolve(alertId);
    }

    const after = {
      budgetItems: await db.select().from(budgetItems).where(eq(budgetItems.projectId, projectId)),
      expenses: await db.select().from(expenses).where(eq(expenses.projectId, projectId)),
      commitments: await db.select().from(commitments).where(eq(commitments.projectId, projectId)),
      forecastSnapshots: await db.select().from(forecastSnapshots),
      cashFlow: await request(app).get(`/api/projects/${projectId}/cash-flow`).set("Authorization", `Bearer ${ownerToken}`).then((r) => r.body),
      payrollPeriods: await db.select().from(payrollPeriods),
      laborAllocations: await db.select().from(laborAllocations),
      invoices: await db.select().from(invoices),
      zatcaEgsUnits: await db.select().from(zatcaEgsUnits),
      nitaqat: await db.select().from(nitaqatComplianceRecords),
    };

    expect(after).toEqual(before);
  });
});

describe("Audit", () => {
  it("64. alert creation is audited", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 10000);
    await addExpense(projectId, 9500, today());
    await evaluate({ projectId });
    const alertId = (await alertsFor(projectId, "budget_consumption_threshold"))[0].id as string;
    const event = await db.query.auditEvents.findFirst({
      where: and(eq(auditEvents.entityId, alertId), eq(auditEvents.action, "budgetAlert.created")),
    });
    expect(event).toBeTruthy();
  });

  it("65. acknowledge is audited", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 10000);
    await addExpense(projectId, 9500, today());
    await evaluate({ projectId });
    const alertId = (await alertsFor(projectId, "budget_consumption_threshold"))[0].id as string;
    await acknowledge(alertId);
    const event = await db.query.auditEvents.findFirst({
      where: and(eq(auditEvents.entityId, alertId), eq(auditEvents.action, "budgetAlert.acknowledged")),
    });
    expect(event).toBeTruthy();
  });

  it("66. resolve is audited", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 10000);
    await addExpense(projectId, 9500, today());
    await evaluate({ projectId });
    const alertId = (await alertsFor(projectId, "budget_consumption_threshold"))[0].id as string;
    await acknowledge(alertId);
    await resolve(alertId);
    const event = await db.query.auditEvents.findFirst({
      where: and(eq(auditEvents.entityId, alertId), eq(auditEvents.action, "budgetAlert.resolved")),
    });
    expect(event).toBeTruthy();
  });

  it("67. repeated evaluation with no new alert never creates duplicate audit spam", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 10000);
    await addExpense(projectId, 9500, today());
    await evaluate({ projectId });
    await evaluate({ projectId });
    await evaluate({ projectId });

    const alertId = (await alertsFor(projectId, "budget_consumption_threshold"))[0].id as string;
    const events = await db.query.auditEvents.findMany({
      where: and(eq(auditEvents.entityId, alertId), eq(auditEvents.action, "budgetAlert.created")),
    });
    expect(events).toHaveLength(1);
  });
});

describe("RBAC", () => {
  it("member can read alerts and trigger evaluation", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 10000);
    await addExpense(projectId, 9500, today());
    expect((await evaluate({ projectId }, memberToken)).status).toBe(200);
    expect((await listAlerts({ projectId }, memberToken)).status).toBe(200);
  });

  it("member cannot acknowledge or resolve (owner-only budgetAlert.manage)", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 10000);
    await addExpense(projectId, 9500, today());
    await evaluate({ projectId });
    const alertId = (await alertsFor(projectId, "budget_consumption_threshold"))[0].id as string;
    expect((await acknowledge(alertId, memberToken)).status).toBe(403);
    expect((await resolve(alertId, memberToken)).status).toBe(403);
  });

  it("owner can acknowledge and resolve", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 10000);
    await addExpense(projectId, 9500, today());
    await evaluate({ projectId });
    const alertId = (await alertsFor(projectId, "budget_consumption_threshold"))[0].id as string;
    expect((await acknowledge(alertId)).status).toBe(200);
    expect((await resolve(alertId)).status).toBe(200);
  });
});

describe("Concurrency", () => {
  it("simultaneous evaluate() calls never create duplicate alerts for the same dedup state", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 10000);
    await addExpense(projectId, 9500, today());

    const results = await Promise.all(Array.from({ length: 6 }, () => evaluate({ projectId })));
    for (const r of results) expect(r.status).toBe(200);

    const rows = await db.select().from(budgetAlerts).where(eq(budgetAlerts.projectId, projectId));
    const openConsumptionAlerts = rows.filter((r) => r.ruleCode === "budget_consumption_threshold");
    expect(openConsumptionAlerts).toHaveLength(1);
  });
});

describe("No generic PATCH exists", () => {
  it("PATCH /api/budget-alerts/:id is not a route (404/405, never a mutation)", async () => {
    const projectId = await createProject();
    await addBudgetItem(projectId, 10000);
    await addExpense(projectId, 9500, today());
    await evaluate({ projectId });
    const alertId = (await alertsFor(projectId, "budget_consumption_threshold"))[0].id as string;
    const res = await request(app)
      .patch(`/api/budget-alerts/${alertId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ severity: "critical" });
    expect([404, 405]).toContain(res.status);
  });
});
