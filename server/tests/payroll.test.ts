import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { auditEvents } from "../src/db/schema.js";

// MIDAD Phase A3 — Payroll Periods + Payroll Records. Same shared-company-
// per-file discipline as employees.test.ts/ipc.test.ts. Covers both
// resources together (like ipc.test.ts covers ipc+lines) because most of
// the interesting behavior is their interaction: a period's status
// governs whether its records can be mutated at all.

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
let companyBEmployeeId: string;

beforeAll(async () => {
  await resetDb();

  const ownerRes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Payroll Test Co", name: "Owner", email: uniqueEmail("pr-owner"), password: "password123" });
  expect(ownerRes.status).toBe(201);
  ownerToken = ownerRes.body.token;

  const inviteRes = await request(app)
    .post("/api/company/invites")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ email: uniqueEmail("pr-member"), role: "member" });
  expect(inviteRes.status).toBe(201);
  const mailCall = (sendMail as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
  const inviteToken = (mailCall[2] as string).match(/token=([a-f0-9]{40,80})/)![1];
  const acceptRes = await request(app)
    .post("/api/auth/accept-invite")
    .send({ token: inviteToken, name: "Member", password: "memberpass123" });
  expect(acceptRes.status).toBe(201);
  memberToken = acceptRes.body.token;

  const companyBRes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Other Payroll Co", name: "Owner B", email: uniqueEmail("pr-other"), password: "password123" });
  expect(companyBRes.status).toBe(201);
  companyBToken = companyBRes.body.token;

  const empRes = await request(app)
    .post("/api/employees")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ name: "أحمد الشمري", employeeNumber: "EMP-1" });
  expect(empRes.status).toBe(201);
  employeeId = empRes.body.id;

  const empBRes = await request(app)
    .post("/api/employees")
    .set("Authorization", `Bearer ${companyBToken}`)
    .send({ name: "موظف الشركة الأخرى", employeeNumber: "EMP-1" });
  expect(empBRes.status).toBe(201);
  companyBEmployeeId = empBRes.body.id;
});

function createPeriod(body: Record<string, unknown>, token = ownerToken) {
  return request(app).post("/api/payroll-periods").set("Authorization", `Bearer ${token}`).send(body);
}
function listPeriods(token = ownerToken) {
  return request(app).get("/api/payroll-periods").set("Authorization", `Bearer ${token}`);
}
function getPeriod(id: string, token = ownerToken) {
  return request(app).get(`/api/payroll-periods/${id}`).set("Authorization", `Bearer ${token}`);
}
function updatePeriod(id: string, body: Record<string, unknown>, token = ownerToken) {
  return request(app).patch(`/api/payroll-periods/${id}`).set("Authorization", `Bearer ${token}`).send(body);
}
function submitPeriod(id: string, token = ownerToken) {
  return request(app).post(`/api/payroll-periods/${id}/submit`).set("Authorization", `Bearer ${token}`);
}
function approvePeriod(id: string, token = ownerToken) {
  return request(app).post(`/api/payroll-periods/${id}/approve`).set("Authorization", `Bearer ${token}`);
}
function rejectPeriod(id: string, body: Record<string, unknown>, token = ownerToken) {
  return request(app).post(`/api/payroll-periods/${id}/reject`).set("Authorization", `Bearer ${token}`).send(body);
}

function createRecord(body: Record<string, unknown>, token = ownerToken) {
  return request(app).post("/api/payroll-records").set("Authorization", `Bearer ${token}`).send(body);
}
function listRecords(query = "", token = ownerToken) {
  return request(app).get(`/api/payroll-records${query}`).set("Authorization", `Bearer ${token}`);
}
function getRecord(id: string, token = ownerToken) {
  return request(app).get(`/api/payroll-records/${id}`).set("Authorization", `Bearer ${token}`);
}
function updateRecord(id: string, body: Record<string, unknown>, token = ownerToken) {
  return request(app).patch(`/api/payroll-records/${id}`).set("Authorization", `Bearer ${token}`).send(body);
}

let dayCounter = 0;
function nextPeriod(): { periodStart: string; periodEnd: string } {
  // Each call gets a fresh, non-overlapping single-day range far in the
  // future — avoids collisions with the overlap check AND the DB unique
  // constraint across the many tests in this file.
  dayCounter += 1;
  const base = new Date("2030-01-01T00:00:00Z");
  base.setUTCDate(base.getUTCDate() + dayCounter);
  const iso = base.toISOString().slice(0, 10);
  return { periodStart: iso, periodEnd: iso };
}

describe("Payroll Period", () => {
  it("1. an owner can list periods (empty initially)", async () => {
    const res = await listPeriods();
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("2. an owner can create a period with minimal required data", async () => {
    const { periodStart, periodEnd } = nextPeriod();
    const res = await createPeriod({ periodStart, periodEnd });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("draft");
    expect(res.body.periodStart).toBe(periodStart);
  });

  it("3. a member can list/get periods (read is member-open)", async () => {
    const period = await createPeriod(nextPeriod());
    const list = await listPeriods(memberToken);
    expect(list.status).toBe(200);
    const get = await getPeriod(period.body.id, memberToken);
    expect(get.status).toBe(200);
  });

  it("4. a member CANNOT create a period (payroll.manage is owner-only)", async () => {
    const res = await createPeriod(nextPeriod(), memberToken);
    expect(res.status).toBe(403);
  });

  it("5. creation rejects missing/invalid dates and start > end", async () => {
    const missing = await createPeriod({ periodEnd: "2030-06-01" });
    expect(missing.status).toBe(400);
    const badFormat = await createPeriod({ periodStart: "01-06-2030", periodEnd: "2030-06-01" });
    expect(badFormat.status).toBe(400);
    const inverted = await createPeriod({ periodStart: "2030-06-10", periodEnd: "2030-06-01" });
    expect(inverted.status).toBe(400);
  });

  it("6. exact-duplicate period range is rejected cleanly (409, DB-backstopped)", async () => {
    const range = nextPeriod();
    const first = await createPeriod(range);
    expect(first.status).toBe(201);
    const second = await createPeriod(range);
    expect(second.status).toBe(409);
    expect(JSON.stringify(second.body)).not.toMatch(/duplicate key|constraint|23505|stack|SQL/i);
  });

  it("7. an overlapping (non-identical) period range is rejected", async () => {
    dayCounter += 1;
    const base = new Date("2031-01-01T00:00:00Z");
    base.setUTCDate(base.getUTCDate() + dayCounter);
    const start = base.toISOString().slice(0, 10);
    const endDate = new Date(base);
    endDate.setUTCDate(endDate.getUTCDate() + 5);
    const end = endDate.toISOString().slice(0, 10);
    const first = await createPeriod({ periodStart: start, periodEnd: end });
    expect(first.status).toBe(201);

    const overlapStart = new Date(base);
    overlapStart.setUTCDate(overlapStart.getUTCDate() + 2);
    const second = await createPeriod({ periodStart: overlapStart.toISOString().slice(0, 10), periodEnd: end });
    expect(second.status).toBe(409);
    dayCounter += 10;
  });

  it("8. an owner can update a draft period's dates/notes", async () => {
    const period = await createPeriod(nextPeriod());
    const res = await updatePeriod(period.body.id, { notes: "ملاحظة تجريبية" });
    expect(res.status).toBe(200);
    expect(res.body.notes).toBe("ملاحظة تجريبية");
  });

  it("9. a member cannot update a period", async () => {
    const period = await createPeriod(nextPeriod());
    const res = await updatePeriod(period.body.id, { notes: "x" }, memberToken);
    expect(res.status).toBe(403);
  });

  it("10. cannot submit a period with zero payroll records", async () => {
    const period = await createPeriod(nextPeriod());
    const res = await submitPeriod(period.body.id);
    expect(res.status).toBe(400);
  });

  it("11. full lifecycle: draft -> submitted -> approved", async () => {
    const period = await createPeriod(nextPeriod());
    await createRecord({ payrollPeriodId: period.body.id, employeeId, grossAmount: 5000 });

    const submitted = await submitPeriod(period.body.id);
    expect(submitted.status).toBe(200);
    expect(submitted.body.status).toBe("submitted");

    const approved = await approvePeriod(period.body.id);
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe("approved");
  });

  it("12. submitted -> rejected returns the period to an editable state", async () => {
    const period = await createPeriod(nextPeriod());
    await createRecord({ payrollPeriodId: period.body.id, employeeId, grossAmount: 4000 });
    await submitPeriod(period.body.id);

    const rejected = await rejectPeriod(period.body.id, { reason: "بيانات خاطئة" });
    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe("rejected");
    expect(rejected.body.rejectionReason).toBe("بيانات خاطئة");

    // Editable again after rejection.
    const resubmitted = await submitPeriod(period.body.id);
    expect(resubmitted.status).toBe(200);
  });

  it("13. reject requires a reason", async () => {
    const period = await createPeriod(nextPeriod());
    await createRecord({ payrollPeriodId: period.body.id, employeeId, grossAmount: 1000 });
    await submitPeriod(period.body.id);
    const res = await rejectPeriod(period.body.id, {});
    expect(res.status).toBe(400);
  });

  it("14. approve/reject reject a period that is not currently submitted", async () => {
    const period = await createPeriod(nextPeriod());
    const approveRes = await approvePeriod(period.body.id);
    expect(approveRes.status).toBe(409);
    const rejectRes = await rejectPeriod(period.body.id, { reason: "x" });
    expect(rejectRes.status).toBe(409);
  });

  it("15. a nonexistent period id returns 404 on GET/PATCH/submit/approve/reject", async () => {
    const id = "00000000-0000-0000-0000-000000000000";
    expect((await getPeriod(id)).status).toBe(404);
    expect((await updatePeriod(id, { notes: "x" })).status).toBe(404);
    expect((await submitPeriod(id)).status).toBe(404);
    expect((await approvePeriod(id)).status).toBe(404);
    expect((await rejectPeriod(id, { reason: "x" })).status).toBe(404);
  });

  it("16. unauthenticated requests are rejected on every route", async () => {
    expect((await request(app).get("/api/payroll-periods")).status).toBe(401);
    expect((await request(app).post("/api/payroll-periods").send({})).status).toBe(401);
  });
});

describe("Payroll Period locking", () => {
  it("17-22. once submitted, records cannot be added or edited; server rejects direct API updates even for an owner", async () => {
    const period = await createPeriod(nextPeriod());
    const record = await createRecord({ payrollPeriodId: period.body.id, employeeId, grossAmount: 3000, deductionsAmount: 200 });
    expect(record.status).toBe(201);

    // Editable while draft.
    const editWhileDraft = await updateRecord(record.body.id, { grossAmount: 3500 });
    expect(editWhileDraft.status).toBe(200);
    expect(editWhileDraft.body.netAmount).toBe("3300.00");

    const submitted = await submitPeriod(period.body.id);
    expect(submitted.status).toBe(200);

    // Locked: cannot edit the existing record.
    const editAfterLock = await updateRecord(record.body.id, { grossAmount: 9999 });
    expect(editAfterLock.status).toBe(409);

    // Locked: cannot add a new record either.
    const secondEmployee = await request(app)
      .post("/api/employees")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "موظف ثانٍ", employeeNumber: `EMP-LOCK-${Date.now()}` });
    const addAfterLock = await createRecord({ payrollPeriodId: period.body.id, employeeId: secondEmployee.body.id, grossAmount: 1000 });
    expect(addAfterLock.status).toBe(409);

    // Locked: cannot update the period's own dates either.
    const patchPeriodAfterLock = await updatePeriod(period.body.id, { notes: "محاولة تعديل" });
    expect(patchPeriodAfterLock.status).toBe(409);

    // Confirm nothing actually changed underneath.
    const stillOriginal = await getRecord(record.body.id);
    expect(stillOriginal.body.grossAmount).toBe("3500.00");
  });

  it("23. approved periods stay locked too", async () => {
    const period = await createPeriod(nextPeriod());
    const record = await createRecord({ payrollPeriodId: period.body.id, employeeId, grossAmount: 2000 });
    await submitPeriod(period.body.id);
    await approvePeriod(period.body.id);

    const editAfterApprove = await updateRecord(record.body.id, { grossAmount: 1 });
    expect(editAfterApprove.status).toBe(409);
  });
});

describe("Payroll Record", () => {
  it("24. net amount is always server-computed as gross - deductions, never trusted from the client", async () => {
    const period = await createPeriod(nextPeriod());
    const res = await createRecord({
      payrollPeriodId: period.body.id,
      employeeId,
      grossAmount: 6000,
      deductionsAmount: 450.5,
      netAmount: 999999, // must be ignored
    });
    expect(res.status).toBe(201);
    expect(res.body.netAmount).toBe("5549.50");
  });

  it("25. deductions cannot exceed gross (net would go negative)", async () => {
    const period = await createPeriod(nextPeriod());
    const res = await createRecord({ payrollPeriodId: period.body.id, employeeId, grossAmount: 100, deductionsAmount: 200 });
    expect(res.status).toBe(400);
  });

  it("26. deductionsAmount defaults to 0 when omitted", async () => {
    const period = await createPeriod(nextPeriod());
    const res = await createRecord({ payrollPeriodId: period.body.id, employeeId, grossAmount: 1000 });
    expect(res.status).toBe(201);
    expect(res.body.deductionsAmount).toBe("0.00");
    expect(res.body.netAmount).toBe("1000.00");
  });

  it("27. creation rejects an employee that does not exist", async () => {
    const period = await createPeriod(nextPeriod());
    const res = await createRecord({
      payrollPeriodId: period.body.id,
      employeeId: "00000000-0000-0000-0000-000000000000",
      grossAmount: 1000,
    });
    expect(res.status).toBe(404);
  });

  it("28. creation rejects a payroll period that does not exist", async () => {
    const res = await createRecord({
      payrollPeriodId: "00000000-0000-0000-0000-000000000000",
      employeeId,
      grossAmount: 1000,
    });
    expect(res.status).toBe(404);
  });

  it("29. creation accepts an inactive employee (historical payroll remains valid)", async () => {
    const emp = await request(app)
      .post("/api/employees")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "موظف غادر", employeeNumber: `EMP-INACTIVE-${Date.now()}` });
    await request(app)
      .patch(`/api/employees/${emp.body.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ status: "inactive" });

    const period = await createPeriod(nextPeriod());
    const res = await createRecord({ payrollPeriodId: period.body.id, employeeId: emp.body.id, grossAmount: 500 });
    expect(res.status).toBe(201);
  });

  it("30. duplicate (employee, period) pair is rejected cleanly (409, DB-backstopped)", async () => {
    const period = await createPeriod(nextPeriod());
    const first = await createRecord({ payrollPeriodId: period.body.id, employeeId, grossAmount: 1000 });
    expect(first.status).toBe(201);
    const second = await createRecord({ payrollPeriodId: period.body.id, employeeId, grossAmount: 2000 });
    expect(second.status).toBe(409);
    expect(JSON.stringify(second.body)).not.toMatch(/duplicate key|constraint|23505|stack|SQL/i);
  });

  it("31. concurrent duplicate-record creation: exactly one succeeds", async () => {
    const period = await createPeriod(nextPeriod());
    const emp = await request(app)
      .post("/api/employees")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "موظف السباق", employeeNumber: `EMP-RACE-${Date.now()}` });

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        createRecord({ payrollPeriodId: period.body.id, employeeId: emp.body.id, grossAmount: 1000 }),
      ),
    );
    const succeeded = results.filter((r) => r.status === 201);
    const conflicted = results.filter((r) => r.status === 409);
    expect(succeeded).toHaveLength(1);
    expect(conflicted).toHaveLength(4);
  });

  it("32. list can be filtered by payrollPeriodId", async () => {
    const periodA = await createPeriod(nextPeriod());
    const periodB = await createPeriod(nextPeriod());
    await createRecord({ payrollPeriodId: periodA.body.id, employeeId, grossAmount: 1000 });

    const emp2 = await request(app)
      .post("/api/employees")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "موظف ب", employeeNumber: `EMP-FILT-${Date.now()}` });
    await createRecord({ payrollPeriodId: periodB.body.id, employeeId: emp2.body.id, grossAmount: 2000 });

    const filtered = await listRecords(`?payrollPeriodId=${periodA.body.id}`);
    expect(filtered.status).toBe(200);
    expect(filtered.body).toHaveLength(1);
    expect(filtered.body[0].payrollPeriodId).toBe(periodA.body.id);
  });

  it("33. list embeds the employee's name and number", async () => {
    const period = await createPeriod(nextPeriod());
    await createRecord({ payrollPeriodId: period.body.id, employeeId, grossAmount: 1000 });
    const res = await listRecords(`?payrollPeriodId=${period.body.id}`);
    expect(res.body[0].employee.name).toBe("أحمد الشمري");
    expect(res.body[0].employee.employeeNumber).toBe("EMP-1");
  });

  it("34. a member cannot create or update a record", async () => {
    const period = await createPeriod(nextPeriod());
    const createRes = await createRecord({ payrollPeriodId: period.body.id, employeeId, grossAmount: 1000 }, memberToken);
    expect(createRes.status).toBe(403);

    const owned = await createRecord({ payrollPeriodId: period.body.id, employeeId, grossAmount: 1000 });
    const updateRes = await updateRecord(owned.body.id, { grossAmount: 1 }, memberToken);
    expect(updateRes.status).toBe(403);
  });

  it("35. a member CAN list/get records (read is member-open)", async () => {
    const period = await createPeriod(nextPeriod());
    const created = await createRecord({ payrollPeriodId: period.body.id, employeeId, grossAmount: 1000 });
    expect((await listRecords("", memberToken)).status).toBe(200);
    expect((await getRecord(created.body.id, memberToken)).status).toBe(200);
  });

  it("36. a nonexistent record id returns 404 on GET/PATCH", async () => {
    const id = "00000000-0000-0000-0000-000000000000";
    expect((await getRecord(id)).status).toBe(404);
    expect((await updateRecord(id, { grossAmount: 1 })).status).toBe(404);
  });
});

describe("Payroll — tenant isolation", () => {
  it("37. cannot create a payroll record using another company's employee", async () => {
    const period = await createPeriod(nextPeriod());
    const res = await createRecord({ payrollPeriodId: period.body.id, employeeId: companyBEmployeeId, grossAmount: 1000 });
    expect(res.status).toBe(404);
  });

  it("38. cannot create a payroll record using another company's payroll period", async () => {
    const periodB = await createPeriod(nextPeriod(), companyBToken);
    const res = await createRecord({ payrollPeriodId: periodB.body.id, employeeId, grossAmount: 1000 });
    expect(res.status).toBe(404);
  });

  it("39. a foreign company's period/record list never includes this company's data", async () => {
    const period = await createPeriod(nextPeriod());
    await createRecord({ payrollPeriodId: period.body.id, employeeId, grossAmount: 1000 });

    const foreignPeriods = await listPeriods(companyBToken);
    expect(foreignPeriods.body.some((p: { id: string }) => p.id === period.body.id)).toBe(false);

    const foreignRecords = await listRecords("", companyBToken);
    expect(foreignRecords.body.some((r: { payrollPeriodId: string }) => r.payrollPeriodId === period.body.id)).toBe(false);
  });

  it("40. a foreign company cannot GET this company's period/record by direct ID", async () => {
    const period = await createPeriod(nextPeriod());
    const record = await createRecord({ payrollPeriodId: period.body.id, employeeId, grossAmount: 1000 });

    expect((await getPeriod(period.body.id, companyBToken)).status).toBe(404);
    expect((await getRecord(record.body.id, companyBToken)).status).toBe(404);
  });

  it("41. a foreign company cannot PATCH this company's period or record (direct ID manipulation)", async () => {
    const period = await createPeriod(nextPeriod());
    const record = await createRecord({ payrollPeriodId: period.body.id, employeeId, grossAmount: 1000 });

    const periodPatch = await updatePeriod(period.body.id, { notes: "تعديل خبيث" }, companyBToken);
    expect(periodPatch.status).toBe(404);
    const recordPatch = await updateRecord(record.body.id, { grossAmount: 1 }, companyBToken);
    expect(recordPatch.status).toBe(404);

    const stillOriginalPeriod = await getPeriod(period.body.id);
    expect(stillOriginalPeriod.body.notes).not.toBe("تعديل خبيث");
    const stillOriginalRecord = await getRecord(record.body.id);
    expect(stillOriginalRecord.body.grossAmount).toBe("1000.00");
  });

  it("42. a foreign company cannot submit/approve/reject this company's period", async () => {
    const period = await createPeriod(nextPeriod());
    await createRecord({ payrollPeriodId: period.body.id, employeeId, grossAmount: 1000 });

    expect((await submitPeriod(period.body.id, companyBToken)).status).toBe(404);
    expect((await approvePeriod(period.body.id, companyBToken)).status).toBe(404);
    expect((await rejectPeriod(period.body.id, { reason: "x" }, companyBToken)).status).toBe(404);

    const stillDraft = await getPeriod(period.body.id);
    expect(stillDraft.body.status).toBe("draft");
  });
});

describe("Payroll — audit trail", () => {
  it("43. period created/updated/submitted/approved/rejected all produce distinct audit events", async () => {
    const period = await createPeriod(nextPeriod());
    await updatePeriod(period.body.id, { notes: "تحديث" });
    await createRecord({ payrollPeriodId: period.body.id, employeeId, grossAmount: 1000 });
    await submitPeriod(period.body.id);
    await rejectPeriod(period.body.id, { reason: "خطأ" });
    await submitPeriod(period.body.id);
    await approvePeriod(period.body.id);

    const events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, period.body.id) });
    const actions = events.map((e) => e.action);
    expect(actions).toContain("payrollPeriod.created");
    expect(actions).toContain("payrollPeriod.updated");
    expect(actions).toContain("payrollPeriod.submitted");
    expect(actions).toContain("payrollPeriod.rejected");
    expect(actions).toContain("payrollPeriod.approved");
  });

  it("44. record created/updated produce distinct audit events", async () => {
    const period = await createPeriod(nextPeriod());
    const record = await createRecord({ payrollPeriodId: period.body.id, employeeId, grossAmount: 1000 });
    await updateRecord(record.body.id, { grossAmount: 1200 });

    const events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, record.body.id) });
    const actions = events.map((e) => e.action);
    expect(actions).toContain("payrollRecord.created");
    expect(actions).toContain("payrollRecord.updated");
  });
});

describe("Payroll — summary computation", () => {
  it("45. GET /:id returns an accurate employeeCount/totalGross/totalDeductions/totalNet summary", async () => {
    const period = await createPeriod(nextPeriod());
    const emp2 = await request(app)
      .post("/api/employees")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "موظف ملخص", employeeNumber: `EMP-SUM-${Date.now()}` });

    await createRecord({ payrollPeriodId: period.body.id, employeeId, grossAmount: 1000, deductionsAmount: 100 });
    await createRecord({ payrollPeriodId: period.body.id, employeeId: emp2.body.id, grossAmount: 2000, deductionsAmount: 50 });

    const res = await getPeriod(period.body.id);
    expect(res.body.summary).toEqual({ employeeCount: 2, totalGross: 3000, totalDeductions: 150, totalNet: 2850 });
    expect(res.body.records).toHaveLength(2);
  });

  it("46. the list endpoint's per-period summary matches GET /:id's summary", async () => {
    const period = await createPeriod(nextPeriod());
    await createRecord({ payrollPeriodId: period.body.id, employeeId, grossAmount: 500, deductionsAmount: 25 });

    const list = await listPeriods();
    const row = list.body.find((p: { id: string }) => p.id === period.body.id);
    expect(row.summary).toEqual({ employeeCount: 1, totalGross: 500, totalDeductions: 25, totalNet: 475 });
  });
});
