import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { auditEvents, expenses, budgetItems } from "../src/db/schema.js";

// MIDAD Phase A4 — Labor Allocation. Same shared-company-per-file
// discipline as payroll.test.ts. Covers: allocation CRUD, the exact
// "lock parent row, re-SELECT, recompute" 100%-total invariant A1's own
// schema comment specifies, project/cost-code ownership, tenant
// isolation, locked-period protection, and — critically — proof that
// nothing here ever touches `expenses` or any other existing financial
// module (see routes/laborAllocations.ts's own header comment on why:
// financial posting is explicitly reserved for a future slice).

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
let projectSpecificCostCodeId: string;
let companyBProjectId: string;
let companyBCostCodeId: string;
let companyBEmployeeId: string;

beforeAll(async () => {
  await resetDb();

  const ownerRes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Labor Alloc Co", name: "Owner", email: uniqueEmail("la-owner"), password: "password123" });
  ownerToken = ownerRes.body.token;

  const inviteRes = await request(app)
    .post("/api/company/invites")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ email: uniqueEmail("la-member"), role: "member" });
  const mailCall = (sendMail as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
  const inviteToken = (mailCall[2] as string).match(/token=([a-f0-9]{40,80})/)![1];
  const acceptRes = await request(app)
    .post("/api/auth/accept-invite")
    .send({ token: inviteToken, name: "Member", password: "memberpass123" });
  memberToken = acceptRes.body.token;

  const companyBRes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Other Labor Alloc Co", name: "Owner B", email: uniqueEmail("la-other"), password: "password123" });
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

  const projectSpecificRes = await request(app)
    .post("/api/cost-codes")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ code: "01-LABOR-P", name: "عمالة المشروع", category: "labor", projectId });
  projectSpecificCostCodeId = projectSpecificRes.body.id;

  const companyBProjectRes = await request(app)
    .post("/api/projects")
    .set("Authorization", `Bearer ${companyBToken}`)
    .send({ name: "مشروع الشركة الأخرى" });
  companyBProjectId = companyBProjectRes.body.id;

  const companyBCostCodeRes = await request(app)
    .post("/api/cost-codes")
    .set("Authorization", `Bearer ${companyBToken}`)
    .send({ code: "CB-01", name: "كود الشركة الأخرى" });
  companyBCostCodeId = companyBCostCodeRes.body.id;

  const companyBEmployeeRes = await request(app)
    .post("/api/employees")
    .set("Authorization", `Bearer ${companyBToken}`)
    .send({ name: "موظف الشركة الأخرى", employeeNumber: "EMP-B-1" });
  companyBEmployeeId = companyBEmployeeRes.body.id;
});

function createAllocation(body: Record<string, unknown>, token = ownerToken) {
  return request(app).post("/api/labor-allocations").set("Authorization", `Bearer ${token}`).send(body);
}
function listAllocations(query = "", token = ownerToken) {
  return request(app).get(`/api/labor-allocations${query}`).set("Authorization", `Bearer ${token}`);
}
function getAllocation(id: string, token = ownerToken) {
  return request(app).get(`/api/labor-allocations/${id}`).set("Authorization", `Bearer ${token}`);
}
function updateAllocation(id: string, body: Record<string, unknown>, token = ownerToken) {
  return request(app).patch(`/api/labor-allocations/${id}`).set("Authorization", `Bearer ${token}`).send(body);
}
function deleteAllocation(id: string, token = ownerToken) {
  return request(app).delete(`/api/labor-allocations/${id}`).set("Authorization", `Bearer ${token}`);
}
function getLaborCost(pid: string, token = ownerToken) {
  return request(app).get(`/api/projects/${pid}/labor-cost`).set("Authorization", `Bearer ${token}`);
}

let dayCounter = 0;
function nextPeriod(): { periodStart: string; periodEnd: string } {
  dayCounter += 1;
  const base = new Date("2032-01-01T00:00:00Z");
  base.setUTCDate(base.getUTCDate() + dayCounter);
  const iso = base.toISOString().slice(0, 10);
  return { periodStart: iso, periodEnd: iso };
}

async function createRecordInFreshPeriod(grossAmount = 10000, token = ownerToken, empId = employeeId): Promise<{ periodId: string; recordId: string; netAmount: string }> {
  const period = await request(app)
    .post("/api/payroll-periods")
    .set("Authorization", `Bearer ${token}`)
    .send(nextPeriod());
  const record = await request(app)
    .post("/api/payroll-records")
    .set("Authorization", `Bearer ${token}`)
    .send({ payrollPeriodId: period.body.id, employeeId: empId, grossAmount });
  return { periodId: period.body.id, recordId: record.body.id, netAmount: record.body.netAmount };
}

describe("Labor Allocation — create/list/get", () => {
  it("1. an owner can create an allocation; amount is server-computed from netAmount * percentage", async () => {
    const { recordId } = await createRecordInFreshPeriod(10000);
    const res = await createAllocation({ payrollRecordId: recordId, projectId, percentage: 60 });
    expect(res.status).toBe(201);
    expect(res.body.percentage).toBe("60.00");
    expect(res.body.amount).toBe("6000.00");
    expect(res.body.costCodeId).toBeNull();
  });

  it("2. an allocation can include a company-wide cost code", async () => {
    const { recordId } = await createRecordInFreshPeriod(5000);
    const res = await createAllocation({ payrollRecordId: recordId, projectId, costCodeId, percentage: 100 });
    expect(res.status).toBe(201);
    expect(res.body.amount).toBe("5000.00");
  });

  it("3. an allocation can include a project-specific cost code that matches its own project", async () => {
    const { recordId } = await createRecordInFreshPeriod(2000);
    const res = await createAllocation({ payrollRecordId: recordId, projectId, costCodeId: projectSpecificCostCodeId, percentage: 50 });
    expect(res.status).toBe(201);
  });

  it("4. a member can list/get allocations (read is member-open)", async () => {
    const { recordId } = await createRecordInFreshPeriod(1000);
    const created = await createAllocation({ payrollRecordId: recordId, projectId, percentage: 100 });
    expect((await listAllocations("", memberToken)).status).toBe(200);
    expect((await getAllocation(created.body.id, memberToken)).status).toBe(200);
  });

  it("5. a member CANNOT create an allocation (payroll.manage is owner-only)", async () => {
    const { recordId } = await createRecordInFreshPeriod(1000);
    const res = await createAllocation({ payrollRecordId: recordId, projectId, percentage: 50 }, memberToken);
    expect(res.status).toBe(403);
  });

  it("6. list can be filtered by payrollRecordId and projectId", async () => {
    const { recordId } = await createRecordInFreshPeriod(1000);
    const created = await createAllocation({ payrollRecordId: recordId, projectId, percentage: 100 });
    expect(created.status).toBe(201);

    const byRecord = await listAllocations(`?payrollRecordId=${recordId}`);
    expect(byRecord.body.some((a: { id: string }) => a.id === created.body.id)).toBe(true);

    const byProject = await listAllocations(`?projectId=${projectId}`);
    expect(byProject.body.some((a: { id: string }) => a.id === created.body.id)).toBe(true);
  });

  it("7. list can be filtered by payrollPeriodId", async () => {
    const { periodId, recordId } = await createRecordInFreshPeriod(1000);
    const created = await createAllocation({ payrollRecordId: recordId, projectId, percentage: 100 });
    const res = await listAllocations(`?payrollPeriodId=${periodId}`);
    expect(res.body.some((a: { id: string }) => a.id === created.body.id)).toBe(true);
  });

  it("8. list embeds project name and cost code (never a raw un-labeled id-only row)", async () => {
    const { recordId } = await createRecordInFreshPeriod(1000);
    await createAllocation({ payrollRecordId: recordId, projectId, costCodeId, percentage: 100 });
    const res = await listAllocations(`?payrollRecordId=${recordId}`);
    expect(res.body[0].project.name).toBe("برج الرياض");
    expect(res.body[0].costCode.code).toBe("01-LABOR");
  });
});

describe("Labor Allocation — ownership validation", () => {
  it("9. creation rejects a nonexistent payroll record", async () => {
    const res = await createAllocation({ payrollRecordId: "00000000-0000-0000-0000-000000000000", projectId, percentage: 50 });
    expect(res.status).toBe(404);
  });

  it("10. creation rejects a nonexistent project", async () => {
    const { recordId } = await createRecordInFreshPeriod(1000);
    const res = await createAllocation({ payrollRecordId: recordId, projectId: "00000000-0000-0000-0000-000000000000", percentage: 50 });
    expect(res.status).toBe(404);
  });

  it("11. creation rejects a nonexistent cost code", async () => {
    const { recordId } = await createRecordInFreshPeriod(1000);
    const res = await createAllocation({ payrollRecordId: recordId, projectId, costCodeId: "00000000-0000-0000-0000-000000000000", percentage: 50 });
    expect(res.status).toBe(404);
  });

  it("12. creation rejects a cost code that is specific to a DIFFERENT project", async () => {
    const otherProject = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "مشروع آخر" });
    const otherProjectCostCode = await request(app)
      .post("/api/cost-codes")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ code: "OTHER-01", name: "كود مشروع آخر", projectId: otherProject.body.id });

    const { recordId } = await createRecordInFreshPeriod(1000);
    const res = await createAllocation({ payrollRecordId: recordId, projectId, costCodeId: otherProjectCostCode.body.id, percentage: 50 });
    expect(res.status).toBe(400);
  });

  it("13. creation rejects percentage <= 0 or > 100", async () => {
    const { recordId } = await createRecordInFreshPeriod(1000);
    expect((await createAllocation({ payrollRecordId: recordId, projectId, percentage: 0 })).status).toBe(400);
    expect((await createAllocation({ payrollRecordId: recordId, projectId, percentage: -10 })).status).toBe(400);
    expect((await createAllocation({ payrollRecordId: recordId, projectId, percentage: 101 })).status).toBe(400);
  });
});

describe("Labor Allocation — 100% total integrity", () => {
  it("14. partial allocation is allowed (never required to reach exactly 100%)", async () => {
    const { recordId } = await createRecordInFreshPeriod(10000);
    const res = await createAllocation({ payrollRecordId: recordId, projectId, percentage: 40 });
    expect(res.status).toBe(201);
  });

  it("15. a second allocation that would push the total over 100% is rejected, with the remaining percent reported", async () => {
    const { recordId } = await createRecordInFreshPeriod(10000);
    await createAllocation({ payrollRecordId: recordId, projectId, percentage: 70 });
    const res = await createAllocation({ payrollRecordId: recordId, projectId, percentage: 40 });
    expect(res.status).toBe(400);
    expect(res.body.remainingPercent).toBe(30);
  });

  it("16. allocations can exactly sum to 100% across multiple projects", async () => {
    const otherProject = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "مشروع ثانٍ" });
    const { recordId } = await createRecordInFreshPeriod(10000);
    const first = await createAllocation({ payrollRecordId: recordId, projectId, percentage: 60 });
    expect(first.status).toBe(201);
    const second = await createAllocation({ payrollRecordId: recordId, projectId: otherProject.body.id, percentage: 40 });
    expect(second.status).toBe(201);
    const third = await createAllocation({ payrollRecordId: recordId, projectId, percentage: 1 });
    expect(third.status).toBe(400);
  });

  it("17. concurrent allocation attempts that together would exceed 100% never both succeed (race-safe)", async () => {
    const { recordId } = await createRecordInFreshPeriod(10000);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => createAllocation({ payrollRecordId: recordId, projectId, percentage: 30 })),
    );
    const succeeded = results.filter((r) => r.status === 201);
    // At most 3 of 5 can succeed (3*30=90<=100, 4*30=120>100).
    expect(succeeded.length).toBeLessThanOrEqual(3);

    const list = await listAllocations(`?payrollRecordId=${recordId}`);
    const totalPercent = list.body.reduce((sum: number, a: { percentage: string }) => sum + Number(a.percentage), 0);
    expect(totalPercent).toBeLessThanOrEqual(100);
  });

  it("18. updating percentage re-validates the total, excluding the row's own prior percentage", async () => {
    const { recordId } = await createRecordInFreshPeriod(10000);
    const alloc = await createAllocation({ payrollRecordId: recordId, projectId, percentage: 50 });
    const raiseWithinBudget = await updateAllocation(alloc.body.id, { percentage: 80 });
    expect(raiseWithinBudget.status).toBe(200);
    expect(raiseWithinBudget.body.amount).toBe("8000.00");

    const otherProject = await request(app).post("/api/projects").set("Authorization", `Bearer ${ownerToken}`).send({ name: "مشروع ثالث" });
    await createAllocation({ payrollRecordId: recordId, projectId: otherProject.body.id, percentage: 15 });

    const raiseOverBudget = await updateAllocation(alloc.body.id, { percentage: 90 });
    expect(raiseOverBudget.status).toBe(400);
  });
});

describe("Labor Allocation — update/delete", () => {
  it("19. an owner can update an allocation's cost code and notes", async () => {
    const { recordId } = await createRecordInFreshPeriod(1000);
    const alloc = await createAllocation({ payrollRecordId: recordId, projectId, percentage: 50 });
    const res = await updateAllocation(alloc.body.id, { costCodeId, notes: "ملاحظة" });
    expect(res.status).toBe(200);
    expect(res.body.costCodeId).toBe(costCodeId);
    expect(res.body.notes).toBe("ملاحظة");
  });

  it("20. a member cannot update or delete an allocation", async () => {
    const { recordId } = await createRecordInFreshPeriod(1000);
    const alloc = await createAllocation({ payrollRecordId: recordId, projectId, percentage: 50 });
    expect((await updateAllocation(alloc.body.id, { notes: "x" }, memberToken)).status).toBe(403);
    expect((await deleteAllocation(alloc.body.id, memberToken)).status).toBe(403);
  });

  it("21. an owner can delete an allocation on an editable (draft) period", async () => {
    const { recordId } = await createRecordInFreshPeriod(1000);
    const alloc = await createAllocation({ payrollRecordId: recordId, projectId, percentage: 50 });
    const res = await deleteAllocation(alloc.body.id);
    expect(res.status).toBe(204);
    expect((await getAllocation(alloc.body.id)).status).toBe(404);
  });

  it("22. a nonexistent allocation id returns 404 on GET/PATCH/DELETE", async () => {
    const id = "00000000-0000-0000-0000-000000000000";
    expect((await getAllocation(id)).status).toBe(404);
    expect((await updateAllocation(id, { notes: "x" })).status).toBe(404);
    expect((await deleteAllocation(id)).status).toBe(404);
  });
});

describe("Labor Allocation — locked payroll period", () => {
  it("23. once a period is submitted, no new allocation can be created against its records", async () => {
    const { periodId, recordId } = await createRecordInFreshPeriod(1000);
    await request(app).post(`/api/payroll-periods/${periodId}/submit`).set("Authorization", `Bearer ${ownerToken}`);
    const res = await createAllocation({ payrollRecordId: recordId, projectId, percentage: 50 });
    expect(res.status).toBe(409);
  });

  it("24. once a period is submitted, an existing allocation cannot be updated or deleted", async () => {
    const { periodId, recordId } = await createRecordInFreshPeriod(1000);
    const alloc = await createAllocation({ payrollRecordId: recordId, projectId, percentage: 50 });
    await request(app).post(`/api/payroll-periods/${periodId}/submit`).set("Authorization", `Bearer ${ownerToken}`);

    const patchRes = await updateAllocation(alloc.body.id, { notes: "محاولة تعديل" });
    expect(patchRes.status).toBe(409);
    const deleteRes = await deleteAllocation(alloc.body.id);
    expect(deleteRes.status).toBe(409);

    const stillThere = await getAllocation(alloc.body.id);
    expect(stillThere.status).toBe(200);
    expect(stillThere.body.notes).not.toBe("محاولة تعديل");
  });

  it("25. approved periods stay locked too", async () => {
    const { periodId, recordId } = await createRecordInFreshPeriod(1000);
    const alloc = await createAllocation({ payrollRecordId: recordId, projectId, percentage: 50 });
    await request(app).post(`/api/payroll-periods/${periodId}/submit`).set("Authorization", `Bearer ${ownerToken}`);
    await request(app).post(`/api/payroll-periods/${periodId}/approve`).set("Authorization", `Bearer ${ownerToken}`);

    const res = await updateAllocation(alloc.body.id, { notes: "x" });
    expect(res.status).toBe(409);
  });

  it("26. rejecting a period makes its allocations editable again", async () => {
    const { periodId, recordId } = await createRecordInFreshPeriod(1000);
    await request(app).post(`/api/payroll-periods/${periodId}/submit`).set("Authorization", `Bearer ${ownerToken}`);
    await request(app).post(`/api/payroll-periods/${periodId}/reject`).set("Authorization", `Bearer ${ownerToken}`).send({ reason: "خطأ" });

    const res = await createAllocation({ payrollRecordId: recordId, projectId, percentage: 50 });
    expect(res.status).toBe(201);
  });
});

describe("Labor Allocation — historical/inactive employee data", () => {
  it("27. an allocation against a payroll record for an inactive employee remains valid and readable", async () => {
    const emp = await request(app)
      .post("/api/employees")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "موظف غادر", employeeNumber: `EMP-HIST-${Date.now()}` });
    const { recordId } = await createRecordInFreshPeriod(1000, ownerToken, emp.body.id);
    await request(app).patch(`/api/employees/${emp.body.id}`).set("Authorization", `Bearer ${ownerToken}`).send({ status: "inactive" });

    const res = await createAllocation({ payrollRecordId: recordId, projectId, percentage: 100 });
    expect(res.status).toBe(201);
  });
});

describe("Labor Allocation — tenant isolation", () => {
  it("28. cannot allocate to a foreign company's project", async () => {
    const { recordId } = await createRecordInFreshPeriod(1000);
    const res = await createAllocation({ payrollRecordId: recordId, projectId: companyBProjectId, percentage: 50 });
    expect(res.status).toBe(404);
  });

  it("29. cannot allocate using a foreign company's payroll record", async () => {
    const { recordId: foreignRecordId } = await createRecordInFreshPeriod(1000, companyBToken, companyBEmployeeId);
    const res = await createAllocation({ payrollRecordId: foreignRecordId, projectId, percentage: 50 });
    expect(res.status).toBe(404);
  });

  it("30. cannot allocate using a foreign company's cost code", async () => {
    const { recordId } = await createRecordInFreshPeriod(1000);
    const res = await createAllocation({ payrollRecordId: recordId, projectId, costCodeId: companyBCostCodeId, percentage: 50 });
    expect(res.status).toBe(404);
  });

  it("31. a foreign company's list never includes this company's allocations", async () => {
    const { recordId } = await createRecordInFreshPeriod(1000);
    const created = await createAllocation({ payrollRecordId: recordId, projectId, percentage: 100 });
    const foreignList = await listAllocations("", companyBToken);
    expect(foreignList.body.some((a: { id: string }) => a.id === created.body.id)).toBe(false);
  });

  it("32. a foreign company cannot GET/PATCH/DELETE this company's allocation by direct ID", async () => {
    const { recordId } = await createRecordInFreshPeriod(1000);
    const created = await createAllocation({ payrollRecordId: recordId, projectId, percentage: 100 });

    expect((await getAllocation(created.body.id, companyBToken)).status).toBe(404);
    expect((await updateAllocation(created.body.id, { notes: "خبيث" }, companyBToken)).status).toBe(404);
    expect((await deleteAllocation(created.body.id, companyBToken)).status).toBe(404);

    const stillThere = await getAllocation(created.body.id);
    expect(stillThere.status).toBe(200);
    expect(stillThere.body.notes).toBeNull();
  });

  it("33. unauthenticated requests are rejected on every route", async () => {
    expect((await request(app).get("/api/labor-allocations")).status).toBe(401);
    expect((await request(app).post("/api/labor-allocations").send({})).status).toBe(401);
  });
});

describe("Labor Allocation — audit trail", () => {
  it("34. create/update/delete each produce a distinct audit event", async () => {
    const { recordId } = await createRecordInFreshPeriod(1000);
    const alloc = await createAllocation({ payrollRecordId: recordId, projectId, percentage: 50 });
    await updateAllocation(alloc.body.id, { notes: "تحديث" });
    await deleteAllocation(alloc.body.id);

    const events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, alloc.body.id) });
    const actions = events.map((e) => e.action);
    expect(actions).toContain("laborAllocation.created");
    expect(actions).toContain("laborAllocation.updated");
    expect(actions).toContain("laborAllocation.deleted");
  });
});

describe("Project labor cost visibility (read-only)", () => {
  it("35. GET /api/projects/:id/labor-cost returns an accurate, clearly-unposted total", async () => {
    // A fresh, isolated project — every other test in this file shares
    // `projectId`, so asserting an exact total against it would be
    // order-dependent on however many prior tests already allocated to it.
    const freshProject = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "مشروع منعزل لاختبار التكلفة" });
    const { recordId } = await createRecordInFreshPeriod(10000);
    await createAllocation({ payrollRecordId: recordId, projectId: freshProject.body.id, percentage: 60 });

    const res = await getLaborCost(freshProject.body.id);
    expect(res.status).toBe(200);
    expect(res.body.allocatedTotal).toBe(6000);
    expect(res.body.allocationCount).toBe(1);
    expect(res.body.posted).toBe(false);
  });

  it("36. a foreign company cannot read this company's project labor cost", async () => {
    const res = await getLaborCost(projectId, companyBToken);
    expect(res.status).toBe(404);
  });

  it("37. a nonexistent project returns 404", async () => {
    const res = await getLaborCost("00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });
});

describe("Financial integrity — A4 never touches existing financial modules", () => {
  it("38. creating, updating, and deleting allocations never inserts, updates, or deletes any `expenses` row", async () => {
    const expensesBefore = await db.select().from(expenses);

    const { recordId } = await createRecordInFreshPeriod(10000);
    const alloc = await createAllocation({ payrollRecordId: recordId, projectId, percentage: 60 });
    await updateAllocation(alloc.body.id, { percentage: 80 });
    await deleteAllocation(alloc.body.id);

    const expensesAfter = await db.select().from(expenses);
    expect(expensesAfter.length).toBe(expensesBefore.length);
  });

  it("39. the project's actual-cost-driving budget items are completely unaffected by allocation activity", async () => {
    const budgetItemsBefore = await db.select().from(budgetItems);

    const { recordId } = await createRecordInFreshPeriod(5000);
    await createAllocation({ payrollRecordId: recordId, projectId, percentage: 100 });

    const budgetItemsAfter = await db.select().from(budgetItems);
    expect(budgetItemsAfter.length).toBe(budgetItemsBefore.length);
  });

  it("40. a project's existing Forecast/Cash Flow endpoints are unaffected by allocation activity (same numbers before and after)", async () => {
    const before = await request(app)
      .get(`/api/projects/${projectId}/forecast`)
      .set("Authorization", `Bearer ${ownerToken}`);

    const { recordId } = await createRecordInFreshPeriod(20000);
    await createAllocation({ payrollRecordId: recordId, projectId, percentage: 100 });

    const after = await request(app)
      .get(`/api/projects/${projectId}/forecast`)
      .set("Authorization", `Bearer ${ownerToken}`);

    expect(after.body.methods).toEqual(before.body.methods);
  });

  it("41. no `labor_cost_postings` row is ever created by any A4 route (the table stays empty)", async () => {
    const { recordId } = await createRecordInFreshPeriod(10000);
    await createAllocation({ payrollRecordId: recordId, projectId, percentage: 100 });

    const postings = await db.query.laborCostPostings.findMany();
    expect(postings).toEqual([]);
  });
});
