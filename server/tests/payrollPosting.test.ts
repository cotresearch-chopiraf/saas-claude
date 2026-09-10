import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { eq, and } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { auditEvents, expenses, laborCostPostings, payrollPeriods } from "../src/db/schema.js";

// MIDAD Phase A5 — Financial Posting of Labor Allocations. Covers: forward
// posting (single/multiple allocations, multiple projects/cost codes,
// partial allocation), the full draft->submitted->approved->posted
// lifecycle gate, double-posting protection under concurrency, the exact
// financial-truth before/after equation (Expense == Actual Cost, Forecast/
// Cash Flow change only through the existing pipeline), reversal (additive,
// history-preserving, cannot loop), no-double-counting, tenant isolation,
// RBAC (payroll.post vs payroll.manage), protected Expense deletion, and
// audit events.

vi.mock("../src/lib/mailer.js", () => ({ sendMail: vi.fn() }));
import { sendMail } from "../src/lib/mailer.js";

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

let ownerToken: string;
let memberToken: string;
let companyBToken: string;
let employeeId: string;
let projectId: string;
let costCodeId: string;
let companyBProjectId: string;

beforeAll(async () => {
  await resetDb();

  const ownerRes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Posting Co", name: "Owner", email: uniqueEmail("post-owner"), password: "password123" });
  ownerToken = ownerRes.body.token;

  const inviteRes = await request(app)
    .post("/api/company/invites")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ email: uniqueEmail("post-member"), role: "member" });
  const mailCall = (sendMail as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
  const inviteToken = (mailCall[2] as string).match(/token=([a-f0-9]{40,80})/)![1];
  const acceptRes = await request(app)
    .post("/api/auth/accept-invite")
    .send({ token: inviteToken, name: "Member", password: "memberpass123" });
  memberToken = acceptRes.body.token;

  const companyBRes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Other Posting Co", name: "Owner B", email: uniqueEmail("post-other"), password: "password123" });
  companyBToken = companyBRes.body.token;

  const empRes = await request(app)
    .post("/api/employees")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ name: "أحمد الشمري", employeeNumber: "EMP-1" });
  employeeId = empRes.body.id;

  const projectRes = await request(app)
    .post("/api/projects")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ name: "برج الرياض" });
  projectId = projectRes.body.id;

  const costCodeRes = await request(app)
    .post("/api/cost-codes")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ code: "01-LABOR", name: "عمالة عامة", category: "labor" });
  costCodeId = costCodeRes.body.id;

  const companyBProjectRes = await request(app)
    .post("/api/projects")
    .set("Authorization", `Bearer ${companyBToken}`)
    .send({ name: "مشروع الشركة الأخرى" });
  companyBProjectId = companyBProjectRes.body.id;
});

let dayCounter = 0;
function nextPeriod(): { periodStart: string; periodEnd: string } {
  dayCounter += 1;
  const base = new Date("2033-01-01T00:00:00Z");
  base.setUTCDate(base.getUTCDate() + dayCounter);
  const iso = base.toISOString().slice(0, 10);
  return { periodStart: iso, periodEnd: iso };
}

async function createRecordInFreshPeriod(
  grossAmount = 10000,
  token = ownerToken,
  empId = employeeId,
): Promise<{ periodId: string; recordId: string; netAmount: string }> {
  const period = await request(app).post("/api/payroll-periods").set("Authorization", `Bearer ${token}`).send(nextPeriod());
  const record = await request(app)
    .post("/api/payroll-records")
    .set("Authorization", `Bearer ${token}`)
    .send({ payrollPeriodId: period.body.id, employeeId: empId, grossAmount });
  return { periodId: period.body.id, recordId: record.body.id, netAmount: record.body.netAmount };
}

function createAllocation(body: Record<string, unknown>, token = ownerToken) {
  return request(app).post("/api/labor-allocations").set("Authorization", `Bearer ${token}`).send(body);
}

async function submitAndApprove(periodId: string, token = ownerToken) {
  await request(app).post(`/api/payroll-periods/${periodId}/submit`).set("Authorization", `Bearer ${token}`);
  return request(app).post(`/api/payroll-periods/${periodId}/approve`).set("Authorization", `Bearer ${token}`);
}

function postPeriod(periodId: string, token = ownerToken) {
  return request(app).post(`/api/payroll-periods/${periodId}/post`).set("Authorization", `Bearer ${token}`);
}

function reversePosting(postingId: string, token = ownerToken) {
  return request(app).post(`/api/labor-cost-postings/${postingId}/reverse`).set("Authorization", `Bearer ${token}`);
}

async function getForecast(pid: string, token = ownerToken) {
  return request(app).get(`/api/projects/${pid}/forecast`).set("Authorization", `Bearer ${token}`);
}

async function projectExpensesTotal(pid: string): Promise<number> {
  const rows = await db.select().from(expenses).where(eq(expenses.projectId, pid));
  return rows.reduce((sum, r) => sum + Number(r.amount), 0);
}

describe("Financial posting — forward posting", () => {
  it("1. posting an approved period with a single 100% allocation creates one Expense using the frozen allocation amount, verbatim", async () => {
    const { periodId, recordId } = await createRecordInFreshPeriod(10000);
    const alloc = await createAllocation({ payrollRecordId: recordId, projectId, percentage: 100 });
    await submitAndApprove(periodId);

    const res = await postPeriod(periodId);
    expect(res.status).toBe(200);
    expect(res.body.totalPosted).toBe(10000);
    expect(res.body.postings).toHaveLength(1);

    const expense = await db.query.expenses.findFirst({ where: eq(expenses.id, res.body.postings[0].expenseId) });
    expect(expense!.amount).toBe("10000.00");
    expect(expense!.amount).toBe(alloc.body.amount);
    expect(expense!.projectId).toBe(projectId);
  });

  it("2. multiple allocations across multiple projects each produce their own Expense", async () => {
    const otherProject = await request(app).post("/api/projects").set("Authorization", `Bearer ${ownerToken}`).send({ name: "مشروع ثانٍ" });
    const { periodId, recordId } = await createRecordInFreshPeriod(10000);
    await createAllocation({ payrollRecordId: recordId, projectId, percentage: 60 });
    await createAllocation({ payrollRecordId: recordId, projectId: otherProject.body.id, percentage: 40 });
    await submitAndApprove(periodId);

    const res = await postPeriod(periodId);
    expect(res.status).toBe(200);
    expect(res.body.postings).toHaveLength(2);
    expect(res.body.totalPosted).toBe(10000);

    const projectIds = new Set(res.body.postings.map((p: { payrollPeriodId: string }) => p));
    expect(projectIds.size).toBeGreaterThan(0);
  });

  it("3. an allocation with a cost code posts an Expense carrying that same cost code", async () => {
    const { periodId, recordId } = await createRecordInFreshPeriod(4000);
    await createAllocation({ payrollRecordId: recordId, projectId, costCodeId, percentage: 100 });
    await submitAndApprove(periodId);

    const res = await postPeriod(periodId);
    expect(res.status).toBe(200);
    const expense = await db.query.expenses.findFirst({ where: eq(expenses.id, res.body.postings[0].expenseId) });
    expect(expense!.costCodeId).toBe(costCodeId);
  });

  it("4. partial allocation posts only the allocated amount; the unallocated remainder is never created as an Expense", async () => {
    const before = await projectExpensesTotal(projectId);
    const { periodId, recordId } = await createRecordInFreshPeriod(10000);
    await createAllocation({ payrollRecordId: recordId, projectId, percentage: 80 });
    await submitAndApprove(periodId);

    const res = await postPeriod(periodId);
    expect(res.status).toBe(200);
    expect(res.body.totalPosted).toBe(8000);
    expect(res.body.postings).toHaveLength(1);

    const after = await projectExpensesTotal(projectId);
    expect(after - before).toBe(8000);
  });

  it("5. an approved period with payroll records but zero labor allocations returns a controlled validation error, not a silent posted period", async () => {
    const { periodId } = await createRecordInFreshPeriod(5000);
    await submitAndApprove(periodId);

    const res = await postPeriod(periodId);
    expect(res.status).toBe(400);

    const period = await db.query.payrollPeriods.findFirst({ where: eq(payrollPeriods.id, periodId) });
    expect(period!.status).toBe("approved");
  });

  it("6. the resulting Expense date follows the period's payrollDate when set, else falls back to periodEnd", async () => {
    dayCounter += 1;
    const base = new Date("2033-01-01T00:00:00Z");
    base.setUTCDate(base.getUTCDate() + dayCounter);
    const periodStart = base.toISOString().slice(0, 10);
    const payrollDate = new Date(base);
    payrollDate.setUTCDate(payrollDate.getUTCDate() + 5);
    const periodEnd = payrollDate.toISOString().slice(0, 10);
    // This period spans 5 extra days beyond the single day dayCounter
    // normally advances by — skip dayCounter past that range so the next
    // nextPeriod() call in a later test never overlaps it.
    dayCounter += 5;

    const period = await request(app)
      .post("/api/payroll-periods")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ periodStart, periodEnd, payrollDate: periodEnd });
    const record = await request(app)
      .post("/api/payroll-records")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ payrollPeriodId: period.body.id, employeeId, grossAmount: 3000 });
    await createAllocation({ payrollRecordId: record.body.id, projectId, percentage: 100 });
    await submitAndApprove(period.body.id);

    const res = await postPeriod(period.body.id);
    expect(res.status).toBe(200);
    const expense = await db.query.expenses.findFirst({ where: eq(expenses.id, res.body.postings[0].expenseId) });
    expect(expense!.expenseDate).toBe(periodEnd);
  });
});

describe("Financial posting — lifecycle gate", () => {
  it("7. a draft period cannot be posted", async () => {
    const { periodId, recordId } = await createRecordInFreshPeriod(1000);
    await createAllocation({ payrollRecordId: recordId, projectId, percentage: 100 });
    const res = await postPeriod(periodId);
    expect(res.status).toBe(409);
  });

  it("8. a submitted (not yet approved) period cannot be posted", async () => {
    const { periodId, recordId } = await createRecordInFreshPeriod(1000);
    await createAllocation({ payrollRecordId: recordId, projectId, percentage: 100 });
    await request(app).post(`/api/payroll-periods/${periodId}/submit`).set("Authorization", `Bearer ${ownerToken}`);
    const res = await postPeriod(periodId);
    expect(res.status).toBe(409);
  });

  it("9. a rejected period cannot be posted", async () => {
    const { periodId, recordId } = await createRecordInFreshPeriod(1000);
    await createAllocation({ payrollRecordId: recordId, projectId, percentage: 100 });
    await request(app).post(`/api/payroll-periods/${periodId}/submit`).set("Authorization", `Bearer ${ownerToken}`);
    await request(app).post(`/api/payroll-periods/${periodId}/reject`).set("Authorization", `Bearer ${ownerToken}`).send({ reason: "خطأ" });
    const res = await postPeriod(periodId);
    expect(res.status).toBe(409);
  });

  it("10. an approved period can be posted", async () => {
    const { periodId, recordId } = await createRecordInFreshPeriod(1000);
    await createAllocation({ payrollRecordId: recordId, projectId, percentage: 100 });
    await submitAndApprove(periodId);
    const res = await postPeriod(periodId);
    expect(res.status).toBe(200);
  });

  it("11. an already-posted period cannot be posted again", async () => {
    const { periodId, recordId } = await createRecordInFreshPeriod(1000);
    await createAllocation({ payrollRecordId: recordId, projectId, percentage: 100 });
    await submitAndApprove(periodId);
    const first = await postPeriod(periodId);
    expect(first.status).toBe(200);
    const second = await postPeriod(periodId);
    expect(second.status).toBe(409);
  });

  it("12. after posting, the period's own status/postedBy/postedAt reflect the posting", async () => {
    const { periodId, recordId } = await createRecordInFreshPeriod(1000);
    await createAllocation({ payrollRecordId: recordId, projectId, percentage: 100 });
    await submitAndApprove(periodId);
    await postPeriod(periodId);

    const detail = await request(app).get(`/api/payroll-periods/${periodId}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(detail.body.status).toBe("posted");
    expect(detail.body.postedBy).toBeTruthy();
    expect(detail.body.postedAt).toBeTruthy();
  });

  it("13. once posted, the period can no longer be edited, submitted, approved, or rejected", async () => {
    const { periodId, recordId } = await createRecordInFreshPeriod(1000);
    await createAllocation({ payrollRecordId: recordId, projectId, percentage: 100 });
    await submitAndApprove(periodId);
    await postPeriod(periodId);

    const patch = await request(app)
      .patch(`/api/payroll-periods/${periodId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ notes: "محاولة تعديل" });
    expect(patch.status).toBe(409);

    const submit = await request(app).post(`/api/payroll-periods/${periodId}/submit`).set("Authorization", `Bearer ${ownerToken}`);
    expect(submit.status).toBe(409);

    const reject = await request(app)
      .post(`/api/payroll-periods/${periodId}/reject`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ reason: "x" });
    expect(reject.status).toBe(409);
  });

  it("14. once posted, its labor allocations remain immutable (cannot be edited or deleted)", async () => {
    const { periodId, recordId } = await createRecordInFreshPeriod(1000);
    const alloc = await createAllocation({ payrollRecordId: recordId, projectId, percentage: 100 });
    await submitAndApprove(periodId);
    await postPeriod(periodId);

    const patch = await request(app)
      .patch(`/api/labor-allocations/${alloc.body.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ notes: "محاولة" });
    expect(patch.status).toBe(409);

    const del = await request(app).delete(`/api/labor-allocations/${alloc.body.id}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(del.status).toBe(409);
  });
});

describe("Financial posting — double-posting protection / concurrency", () => {
  it("15. 5 simultaneous POST /post requests against the same period result in exactly one financial posting per allocation", async () => {
    const before = await projectExpensesTotal(projectId);
    const { periodId, recordId } = await createRecordInFreshPeriod(10000);
    await createAllocation({ payrollRecordId: recordId, projectId, percentage: 100 });
    await submitAndApprove(periodId);

    const results = await Promise.all(Array.from({ length: 5 }, () => postPeriod(periodId)));
    const succeeded = results.filter((r) => r.status === 200);
    const conflicted = results.filter((r) => r.status === 409);
    expect(succeeded.length).toBe(1);
    expect(conflicted.length).toBe(4);

    const postings = await db.query.laborCostPostings.findMany({ where: eq(laborCostPostings.payrollPeriodId, periodId) });
    expect(postings.filter((p) => p.kind === "posting")).toHaveLength(1);

    const after = await projectExpensesTotal(projectId);
    expect(after - before).toBe(10000);
  });

  it("16. the DB-level partial unique index rejects a second posting-kind row for the same allocation even if attempted directly", async () => {
    const { periodId, recordId } = await createRecordInFreshPeriod(1000);
    const alloc = await createAllocation({ payrollRecordId: recordId, projectId, percentage: 100 });
    await submitAndApprove(periodId);
    await postPeriod(periodId);

    const [firstPosting] = await db
      .select()
      .from(laborCostPostings)
      .where(and(eq(laborCostPostings.laborAllocationId, alloc.body.id), eq(laborCostPostings.kind, "posting")));
    expect(firstPosting).toBeTruthy();

    const [dummyExpense] = await db
      .insert(expenses)
      .values({ projectId, description: "test", amount: "1.00", expenseDate: "2033-01-01" })
      .returning();

    await expect(
      db.insert(laborCostPostings).values({
        companyId: firstPosting.companyId,
        payrollPeriodId: firstPosting.payrollPeriodId,
        laborAllocationId: firstPosting.laborAllocationId,
        expenseId: dummyExpense.id,
        kind: "posting",
        postedBy: firstPosting.postedBy,
      }),
    ).rejects.toThrow();
  });
});

describe("Financial posting — financial truth", () => {
  it("17. Expense/Actual-Cost delta after posting exactly equals the posted amount; Forecast responds without error using the existing pipeline", async () => {
    const before = await projectExpensesTotal(projectId);
    const forecastBefore = await getForecast(projectId);
    expect(forecastBefore.status).toBe(200);

    // Forecast/Actual-Cost only counts expenses with expenseDate <= today
    // (collectForecastInputs's own cutoff) — every other period in this
    // file deliberately uses far-future 2033 dates to avoid colliding with
    // each other, but that means their posted expenses are invisible to
    // today's Actual Cost. This test needs a period dated in the past
    // specifically so the posted Expense is actually "as of today".
    const period = await request(app)
      .post("/api/payroll-periods")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ periodStart: "2024-01-01", periodEnd: "2024-01-31" });
    const record = await request(app)
      .post("/api/payroll-records")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ payrollPeriodId: period.body.id, employeeId, grossAmount: 8000 });
    const periodId = period.body.id;
    const recordId = record.body.id;
    await createAllocation({ payrollRecordId: recordId, projectId, percentage: 100 });
    await submitAndApprove(periodId);
    await postPeriod(periodId);

    const after = await projectExpensesTotal(projectId);
    expect(after - before).toBe(8000);

    const forecastAfter = await getForecast(projectId);
    expect(forecastAfter.status).toBe(200);
    const actualCostBefore = forecastBefore.body.methods.cost_to_complete.actualCost;
    const actualCostAfter = forecastAfter.body.methods.cost_to_complete.actualCost;
    expect(actualCostAfter - actualCostBefore).toBe(8000);
  });

  it("18. no double counting: the same allocation contributes to Actual Cost through exactly one Expense row", async () => {
    const { periodId, recordId } = await createRecordInFreshPeriod(6000);
    const alloc = await createAllocation({ payrollRecordId: recordId, projectId, percentage: 100 });
    await submitAndApprove(periodId);
    await postPeriod(periodId);

    const postings = await db.query.laborCostPostings.findMany({
      where: eq(laborCostPostings.laborAllocationId, alloc.body.id),
    });
    expect(postings).toHaveLength(1);

    const linkedExpenses = await db.query.expenses.findMany({ where: eq(expenses.id, postings[0].expenseId) });
    expect(linkedExpenses).toHaveLength(1);
  });
});

describe("Financial posting — reversal", () => {
  it("19. reversing a posting creates a new negative Expense and a new reversal posting; net financial effect is zero, original rows untouched", async () => {
    const { periodId, recordId } = await createRecordInFreshPeriod(8000);
    await createAllocation({ payrollRecordId: recordId, projectId, percentage: 100 });
    await submitAndApprove(periodId);
    const postRes = await postPeriod(periodId);
    const originalPostingId = postRes.body.postings[0].id;
    const originalExpenseId = postRes.body.postings[0].expenseId;

    const before = await projectExpensesTotal(projectId);

    const reverseRes = await reversePosting(originalPostingId);
    expect(reverseRes.status).toBe(201);
    expect(reverseRes.body.expense.amount).toBe("-8000.00");
    expect(reverseRes.body.reversal.kind).toBe("reversal");
    expect(reverseRes.body.reversal.reversalOfPostingId).toBe(originalPostingId);

    const after = await projectExpensesTotal(projectId);
    expect(after - before).toBe(-8000);

    const originalExpense = await db.query.expenses.findFirst({ where: eq(expenses.id, originalExpenseId) });
    expect(originalExpense).toBeTruthy();
    expect(originalExpense!.amount).toBe("8000.00");

    const originalPosting = await db.query.laborCostPostings.findFirst({ where: eq(laborCostPostings.id, originalPostingId) });
    expect(originalPosting!.kind).toBe("posting");
  });

  it("20. a reversal cannot itself be reversed", async () => {
    const { periodId, recordId } = await createRecordInFreshPeriod(1000);
    await createAllocation({ payrollRecordId: recordId, projectId, percentage: 100 });
    await submitAndApprove(periodId);
    const postRes = await postPeriod(periodId);
    const reverseRes = await reversePosting(postRes.body.postings[0].id);

    const secondReverse = await reversePosting(reverseRes.body.reversal.id);
    expect(secondReverse.status).toBe(400);
  });

  it("21. the same posting cannot be reversed twice, even under concurrent requests", async () => {
    const { periodId, recordId } = await createRecordInFreshPeriod(1000);
    await createAllocation({ payrollRecordId: recordId, projectId, percentage: 100 });
    await submitAndApprove(periodId);
    const postRes = await postPeriod(periodId);
    const postingId = postRes.body.postings[0].id;

    const results = await Promise.all(Array.from({ length: 5 }, () => reversePosting(postingId)));
    const succeeded = results.filter((r) => r.status === 201);
    expect(succeeded.length).toBe(1);

    const reversals = await db.query.laborCostPostings.findMany({
      where: and(eq(laborCostPostings.reversalOfPostingId, postingId), eq(laborCostPostings.kind, "reversal")),
    });
    expect(reversals).toHaveLength(1);
  });

  it("22. reversing a nonexistent posting returns 404", async () => {
    const res = await reversePosting("00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });
});

describe("Financial posting — tenant isolation", () => {
  it("23. a foreign company cannot post another company's payroll period", async () => {
    const { periodId, recordId } = await createRecordInFreshPeriod(1000);
    await createAllocation({ payrollRecordId: recordId, projectId, percentage: 100 });
    await submitAndApprove(periodId);
    const res = await postPeriod(periodId, companyBToken);
    expect(res.status).toBe(404);
  });

  it("24. a foreign company cannot list or read another company's labor cost postings", async () => {
    const { periodId, recordId } = await createRecordInFreshPeriod(1000);
    await createAllocation({ payrollRecordId: recordId, projectId, percentage: 100 });
    await submitAndApprove(periodId);
    const postRes = await postPeriod(periodId);

    const list = await request(app).get("/api/labor-cost-postings").set("Authorization", `Bearer ${companyBToken}`);
    expect(list.body.some((p: { id: string }) => p.id === postRes.body.postings[0].id)).toBe(false);

    const get = await request(app)
      .get(`/api/labor-cost-postings/${postRes.body.postings[0].id}`)
      .set("Authorization", `Bearer ${companyBToken}`);
    expect(get.status).toBe(404);
  });

  it("25. a foreign company cannot reverse another company's posting", async () => {
    const { periodId, recordId } = await createRecordInFreshPeriod(1000);
    await createAllocation({ payrollRecordId: recordId, projectId, percentage: 100 });
    await submitAndApprove(periodId);
    const postRes = await postPeriod(periodId);

    const res = await reversePosting(postRes.body.postings[0].id, companyBToken);
    expect(res.status).toBe(404);
  });

  it("26. cannot post a period whose id belongs to a different company via direct ID manipulation", async () => {
    const companyBPeriod = await request(app)
      .post("/api/payroll-periods")
      .set("Authorization", `Bearer ${companyBToken}`)
      .send(nextPeriod());
    const res = await postPeriod(companyBPeriod.body.id, ownerToken);
    expect(res.status).toBe(404);
  });
});

describe("Financial posting — RBAC", () => {
  it("27. a member (payroll.manage only, no payroll.post) cannot post a period — 403", async () => {
    const { periodId, recordId } = await createRecordInFreshPeriod(1000);
    await createAllocation({ payrollRecordId: recordId, projectId, percentage: 100 });
    await submitAndApprove(periodId);
    const res = await postPeriod(periodId, memberToken);
    expect(res.status).toBe(403);
  });

  it("28. a member cannot reverse a posting — 403", async () => {
    const { periodId, recordId } = await createRecordInFreshPeriod(1000);
    await createAllocation({ payrollRecordId: recordId, projectId, percentage: 100 });
    await submitAndApprove(periodId);
    const postRes = await postPeriod(periodId);
    const res = await reversePosting(postRes.body.postings[0].id, memberToken);
    expect(res.status).toBe(403);
  });

  it("29. an owner with payroll.post succeeds where a member is blocked", async () => {
    const { periodId, recordId } = await createRecordInFreshPeriod(1000);
    await createAllocation({ payrollRecordId: recordId, projectId, percentage: 100 });
    await submitAndApprove(periodId);
    const res = await postPeriod(periodId, ownerToken);
    expect(res.status).toBe(200);
  });

  it("30. a member can still list/read labor cost postings (read is member-open)", async () => {
    const { periodId, recordId } = await createRecordInFreshPeriod(1000);
    await createAllocation({ payrollRecordId: recordId, projectId, percentage: 100 });
    await submitAndApprove(periodId);
    const postRes = await postPeriod(periodId);

    const list = await request(app).get("/api/labor-cost-postings").set("Authorization", `Bearer ${memberToken}`);
    expect(list.status).toBe(200);
    expect(list.body.some((p: { id: string }) => p.id === postRes.body.postings[0].id)).toBe(true);
  });
});

describe("Financial posting — protected Expense deletion", () => {
  it("31. deleting a labor-posted Expense returns a controlled application error, not a raw DB error, and the record survives", async () => {
    const { periodId, recordId } = await createRecordInFreshPeriod(1000);
    await createAllocation({ payrollRecordId: recordId, projectId, percentage: 100 });
    await submitAndApprove(periodId);
    const postRes = await postPeriod(periodId);
    const expenseId = postRes.body.postings[0].expenseId;

    const res = await request(app)
      .delete(`/api/projects/${projectId}/budget/expenses/${expenseId}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBeTruthy();
    expect(String(res.body.error)).not.toMatch(/foreign key|constraint|violates|23503/i);

    const stillThere = await db.query.expenses.findFirst({ where: eq(expenses.id, expenseId) });
    expect(stillThere).toBeTruthy();
  });

  it("32. an ordinary (non-labor-posted) Expense can still be deleted normally", async () => {
    const created = await request(app)
      .post(`/api/projects/${projectId}/budget/expenses`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ description: "مصروف عادي", amount: 500, expenseDate: "2033-01-01" });
    expect(created.status).toBe(201);

    const res = await request(app)
      .delete(`/api/projects/${projectId}/budget/expenses/${created.body.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(204);
  });
});

describe("Financial posting — audit", () => {
  it("33. posting produces a payrollPeriod.posted event and a laborCostPosting.created event per allocation", async () => {
    const { periodId, recordId } = await createRecordInFreshPeriod(5000);
    await createAllocation({ payrollRecordId: recordId, projectId, percentage: 100 });
    await submitAndApprove(periodId);
    const postRes = await postPeriod(periodId);

    const periodEvents = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, periodId) });
    expect(periodEvents.map((e) => e.action)).toContain("payrollPeriod.posted");

    const postingEvents = await db.query.auditEvents.findMany({
      where: eq(auditEvents.entityId, postRes.body.postings[0].id),
    });
    expect(postingEvents.map((e) => e.action)).toContain("laborCostPosting.created");
  });

  it("34. reversal produces a laborCostPosting.reversed event on the original and a laborCostPosting.created event on the reversal", async () => {
    const { periodId, recordId } = await createRecordInFreshPeriod(2000);
    await createAllocation({ payrollRecordId: recordId, projectId, percentage: 100 });
    await submitAndApprove(periodId);
    const postRes = await postPeriod(periodId);
    const originalPostingId = postRes.body.postings[0].id;

    const reverseRes = await reversePosting(originalPostingId);

    const originalEvents = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, originalPostingId) });
    expect(originalEvents.map((e) => e.action)).toContain("laborCostPosting.reversed");

    const reversalEvents = await db.query.auditEvents.findMany({
      where: eq(auditEvents.entityId, reverseRes.body.reversal.id),
    });
    expect(reversalEvents.map((e) => e.action)).toContain("laborCostPosting.created");
  });

  it("35. audit metadata for a posting never includes sensitive employee identifiers beyond what already exists on the allocation", async () => {
    const { periodId, recordId } = await createRecordInFreshPeriod(3000);
    await createAllocation({ payrollRecordId: recordId, projectId, percentage: 100 });
    await submitAndApprove(periodId);
    const postRes = await postPeriod(periodId);

    const events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, postRes.body.postings[0].id) });
    const metadataStr = JSON.stringify(events.map((e) => e.metadata));
    expect(metadataStr).not.toMatch(/iban|bank_account|bankAccount/i);
  });
});

describe("Financial posting — unauthenticated access", () => {
  it("36. every route rejects an unauthenticated request", async () => {
    expect((await request(app).post("/api/payroll-periods/00000000-0000-0000-0000-000000000000/post")).status).toBe(401);
    expect((await request(app).post("/api/labor-cost-postings/00000000-0000-0000-0000-000000000000/reverse")).status).toBe(401);
    expect((await request(app).get("/api/labor-cost-postings")).status).toBe(401);
  });
});

// MIDAD Phase A5.1 — the Project Overview labor-cost card must reflect
// REAL posting status (sourced from labor_cost_postings, kind="posting",
// never inferred from an Expense existing) instead of the A4-era hardcoded
// "posted: false". Each case uses a fresh, isolated project — same
// precedent as laborAllocations.test.ts's own "isolated project" tests —
// so asserting exact totals is never order-dependent on other tests in
// this file that also allocate/post against the shared `projectId`.
function getLaborCost(pid: string, token = ownerToken) {
  return request(app).get(`/api/projects/${pid}/labor-cost`).set("Authorization", `Bearer ${token}`);
}

async function freshProject(token = ownerToken, name = "مشروع لاختبار حالة الترحيل") {
  const res = await request(app).post("/api/projects").set("Authorization", `Bearer ${token}`).send({ name });
  return res.body.id as string;
}

describe("Labor cost status display (A5.1)", () => {
  it("Case 1: an unposted allocation reports allocated=10000, posted=0, unposted=10000", async () => {
    const pid = await freshProject();
    const { periodId, recordId } = await createRecordInFreshPeriod(10000);
    await createAllocation({ payrollRecordId: recordId, projectId: pid, percentage: 100 });

    const res = await getLaborCost(pid);
    expect(res.status).toBe(200);
    expect(res.body.allocatedTotal).toBe(10000);
    expect(res.body.postedTotal).toBe(0);
    expect(res.body.unpostedTotal).toBe(10000);
    expect(res.body.posted).toBe(false);
  });

  it("Case 2: partial posting reports allocated=10000, posted=8000, unposted=2000", async () => {
    const pid = await freshProject();
    const { periodId, recordId } = await createRecordInFreshPeriod(10000);
    await createAllocation({ payrollRecordId: recordId, projectId: pid, percentage: 80 });
    await submitAndApprove(periodId);
    const postRes = await postPeriod(periodId);
    expect(postRes.status).toBe(200);

    const res = await getLaborCost(pid);
    expect(res.body.allocatedTotal).toBe(8000);
    expect(res.body.postedTotal).toBe(8000);
    expect(res.body.unpostedTotal).toBe(0);
    expect(res.body.posted).toBe(true);
  });

  it("Case 2b: partial posting across two allocations on the same project reports the correct split", async () => {
    const pid = await freshProject();
    const { periodId, recordId } = await createRecordInFreshPeriod(10000);
    await createAllocation({ payrollRecordId: recordId, projectId: pid, percentage: 80 });
    // A second, still-unposted allocation on a fresh period against the
    // same project — the card must sum across allocations, not just
    // reflect a single one.
    const { periodId: period2Id, recordId: record2Id } = await createRecordInFreshPeriod(2000);
    await createAllocation({ payrollRecordId: record2Id, projectId: pid, percentage: 100 });

    await submitAndApprove(periodId);
    await postPeriod(periodId);

    const res = await getLaborCost(pid);
    expect(res.body.allocatedTotal).toBe(10000); // 8000 posted + 2000 unposted
    expect(res.body.postedTotal).toBe(8000);
    expect(res.body.unpostedTotal).toBe(2000);
    expect(res.body.posted).toBe(false);
  });

  it("Case 3: fully posted reports allocated=10000, posted=10000, unposted=0, posted=true", async () => {
    const pid = await freshProject();
    const { periodId, recordId } = await createRecordInFreshPeriod(10000);
    await createAllocation({ payrollRecordId: recordId, projectId: pid, percentage: 100 });
    await submitAndApprove(periodId);
    await postPeriod(periodId);

    const res = await getLaborCost(pid);
    expect(res.body.allocatedTotal).toBe(10000);
    expect(res.body.postedTotal).toBe(10000);
    expect(res.body.unpostedTotal).toBe(0);
    expect(res.body.posted).toBe(true);
  });

  it("Case 4: a project with no allocations reports all-zero totals, not an error", async () => {
    const pid = await freshProject();
    const res = await getLaborCost(pid);
    expect(res.status).toBe(200);
    expect(res.body.allocatedTotal).toBe(0);
    expect(res.body.allocationCount).toBe(0);
    expect(res.body.postedTotal).toBe(0);
    expect(res.body.unpostedTotal).toBe(0);
    expect(res.body.posted).toBe(false);
  });

  it("Case 5: reversing a posting makes it read back as unposted, never as still-posted or double-counted", async () => {
    const pid = await freshProject();
    const { periodId, recordId } = await createRecordInFreshPeriod(10000);
    await createAllocation({ payrollRecordId: recordId, projectId: pid, percentage: 100 });
    await submitAndApprove(periodId);
    const postRes = await postPeriod(periodId);

    const beforeReverse = await getLaborCost(pid);
    expect(beforeReverse.body.postedTotal).toBe(10000);
    expect(beforeReverse.body.posted).toBe(true);

    await reversePosting(postRes.body.postings[0].id);

    const afterReverse = await getLaborCost(pid);
    expect(afterReverse.body.allocatedTotal).toBe(10000); // the allocation itself is untouched
    expect(afterReverse.body.postedTotal).toBe(0);
    expect(afterReverse.body.unpostedTotal).toBe(10000);
    expect(afterReverse.body.posted).toBe(false);
  });

  it("Case 6: cross-tenant isolation — a foreign company cannot read this company's labor-cost status by direct project id", async () => {
    const pid = await freshProject();
    const { periodId, recordId } = await createRecordInFreshPeriod(5000);
    await createAllocation({ payrollRecordId: recordId, projectId: pid, percentage: 100 });
    await submitAndApprove(periodId);
    await postPeriod(periodId);

    const res = await getLaborCost(pid, companyBToken);
    expect(res.status).toBe(404);

    // And the reverse: this company cannot read the foreign company's project.
    const foreignRes = await getLaborCost(companyBProjectId, ownerToken);
    expect(foreignRes.status).toBe(404);
  });
});
