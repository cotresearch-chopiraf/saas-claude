import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { eq, and } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import {
  employees,
  payrollPeriods,
  payrollRecords,
  laborAllocations,
  laborCostPostings,
  payrollImportBatches,
  payrollImportRows,
  expenses,
  costCodes,
  projects,
  files,
} from "../src/db/schema.js";
import { pgErrorInfo } from "../src/lib/pgError.js";
import { isPermittedRole } from "../src/lib/permissions.js";

// Phase A, Slice A1 — schema foundation only (no routes, no UI exist yet;
// see the Phase A discovery report). These tests exercise the new tables
// directly at the DB layer, the only way to prove a schema-only slice's
// constraints actually hold — a real company/user is still created via
// the real HTTP register flow (never a hand-rolled row), matching every
// other test file's setup discipline, since password hashing/JWT issuance
// only exist behind that route.

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

let companyId: string;
let userId: string;
let projectId: string;

beforeAll(async () => {
  await resetDb();
  const res = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Labor Cost Co", name: "Owner", email: uniqueEmail("labor"), password: "password123" });
  expect(res.status).toBe(201);
  companyId = res.body.company.id;
  userId = res.body.user.id;

  const projectRes = await request(app)
    .post("/api/projects")
    .set("Authorization", `Bearer ${res.body.token}`)
    .send({ name: "Labor Cost Project" });
  expect(projectRes.status).toBe(201);
  projectId = projectRes.body.id;
});

async function insertEmployee(overrides: Partial<typeof employees.$inferInsert> = {}) {
  const [row] = await db
    .insert(employees)
    .values({
      companyId,
      employeeNumber: `EMP-${Math.random().toString(36).slice(2)}`,
      name: "أحمد محمد",
      createdBy: userId,
      ...overrides,
    })
    .returning();
  return row;
}

describe("employees table", () => {
  it("inserts with only the minimal required fields, userId left unset", async () => {
    const row = await insertEmployee();
    expect(row.status).toBe("active");
    expect(row.userId).toBeNull();
  });

  it("optionally links to a users row via userId — never automatic, never required", async () => {
    const row = await insertEmployee({ userId, employeeNumber: `EMP-LINKED-${Date.now()}` });
    expect(row.userId).toBe(userId);
  });

  it("enforces a unique employeeNumber per company", async () => {
    const number = `EMP-DUP-${Date.now()}`;
    await insertEmployee({ employeeNumber: number });
    await expect(insertEmployee({ employeeNumber: number })).rejects.toSatisfy((err: unknown) => {
      return pgErrorInfo(err).code === "23505";
    });
  });

  it("rejects a companyId that does not exist (FK enforced)", async () => {
    await expect(
      insertEmployee({ companyId: "00000000-0000-0000-0000-000000000000", employeeNumber: `EMP-BADCO-${Date.now()}` }),
    ).rejects.toSatisfy((err: unknown) => pgErrorInfo(err).code === "23503");
  });
});

describe("payroll_periods table", () => {
  it("defaults to draft status", async () => {
    const [row] = await db
      .insert(payrollPeriods)
      .values({ companyId, periodStart: "2026-01-01", periodEnd: "2026-01-31", createdBy: userId })
      .returning();
    expect(row.status).toBe("draft");
    expect(row.submittedAt).toBeNull();
    expect(row.approvedAt).toBeNull();
    expect(row.postedAt).toBeNull();
  });

  it("enforces one period per (company, periodStart, periodEnd)", async () => {
    await db.insert(payrollPeriods).values({ companyId, periodStart: "2026-02-01", periodEnd: "2026-02-28", createdBy: userId });
    await expect(
      db.insert(payrollPeriods).values({ companyId, periodStart: "2026-02-01", periodEnd: "2026-02-28", createdBy: userId }),
    ).rejects.toSatisfy((err: unknown) => pgErrorInfo(err).code === "23505");
  });
});

describe("payroll_records table (WPS record)", () => {
  it("defaults sourceType=manual and verificationStatus=unverified — never claims official/verified data", async () => {
    const employee = await insertEmployee();
    const [period] = await db
      .insert(payrollPeriods)
      .values({ companyId, periodStart: "2026-03-01", periodEnd: "2026-03-31", createdBy: userId })
      .returning();
    const [record] = await db
      .insert(payrollRecords)
      .values({
        companyId,
        payrollPeriodId: period.id,
        employeeId: employee.id,
        grossAmount: "5000.00",
        netAmount: "4500.00",
        createdBy: userId,
      })
      .returning();
    expect(record.sourceType).toBe("manual");
    expect(record.verificationStatus).toBe("unverified");
    expect(record.importBatchId).toBeNull();
  });

  it("enforces exactly one record per employee per payroll period", async () => {
    const employee = await insertEmployee();
    const [period] = await db
      .insert(payrollPeriods)
      .values({ companyId, periodStart: "2026-04-01", periodEnd: "2026-04-30", createdBy: userId })
      .returning();
    await db.insert(payrollRecords).values({
      companyId,
      payrollPeriodId: period.id,
      employeeId: employee.id,
      grossAmount: "5000.00",
      netAmount: "4500.00",
      createdBy: userId,
    });
    await expect(
      db.insert(payrollRecords).values({
        companyId,
        payrollPeriodId: period.id,
        employeeId: employee.id,
        grossAmount: "6000.00",
        netAmount: "5500.00",
        createdBy: userId,
      }),
    ).rejects.toSatisfy((err: unknown) => pgErrorInfo(err).code === "23505");
  });
});

describe("labor_allocations table", () => {
  let periodCounter = 0;

  async function setupRecord() {
    const employee = await insertEmployee();
    // Each call needs its own period — payroll_periods_company_period_unique
    // rejects a second (companyId, periodStart, periodEnd) match, and this
    // helper is called once per test within this describe block.
    const day = String(1 + periodCounter++).padStart(2, "0");
    const [period] = await db
      .insert(payrollPeriods)
      .values({ companyId, periodStart: `2026-05-${day}`, periodEnd: `2026-05-${day}`, createdBy: userId })
      .returning();
    const [record] = await db
      .insert(payrollRecords)
      .values({ companyId, payrollPeriodId: period.id, employeeId: employee.id, grossAmount: "10000.00", netAmount: "9000.00", createdBy: userId })
      .returning();
    return record;
  }

  it("allocates a payroll record's resolved amount to a project, cost code optional", async () => {
    const record = await setupRecord();
    const [row] = await db
      .insert(laborAllocations)
      .values({ companyId, payrollRecordId: record.id, projectId, percentage: "70.00", amount: "6300.00", createdBy: userId })
      .returning();
    expect(row.costCodeId).toBeNull();
    expect(row.amount).toBe("6300.00");
  });

  it("rejects a project that does not exist (cross-tenant/invalid project cannot be allocated to)", async () => {
    const record = await setupRecord();
    await expect(
      db.insert(laborAllocations).values({
        companyId,
        payrollRecordId: record.id,
        projectId: "00000000-0000-0000-0000-000000000000",
        amount: "1000.00",
        createdBy: userId,
      }),
    ).rejects.toSatisfy((err: unknown) => pgErrorInfo(err).code === "23503");
  });

  it("supports a costCodeId tag for cost-code-level labor cost grouping", async () => {
    const record = await setupRecord();
    const [costCode] = await db
      .insert(costCodes)
      .values({ companyId, code: "01-LABOR", name: "Labor", category: "labor" })
      .returning();
    const [row] = await db
      .insert(laborAllocations)
      .values({ companyId, payrollRecordId: record.id, projectId, costCodeId: costCode.id, amount: "2000.00", createdBy: userId })
      .returning();
    expect(row.costCodeId).toBe(costCode.id);
  });
});

describe("expenses.costCodeId — the Phase A extension point into existing Actual Cost", () => {
  it("stays nullable — every pre-existing manual expense flow is unaffected", async () => {
    const [row] = await db
      .insert(expenses)
      .values({ projectId, description: "Materials", amount: "100.00", expenseDate: "2026-01-01" })
      .returning();
    expect(row.costCodeId).toBeNull();
  });

  it("can be set directly, without requiring a budgetItemId — proves labor cost can be tagged by cost code alone", async () => {
    const [costCode] = await db
      .insert(costCodes)
      .values({ companyId, code: "02-LABOR", name: "Site Labor", category: "labor" })
      .returning();
    const [row] = await db
      .insert(expenses)
      .values({ projectId, costCodeId: costCode.id, description: "Labor cost", amount: "3000.00", expenseDate: "2026-01-01" })
      .returning();
    expect(row.costCodeId).toBe(costCode.id);
    expect(row.budgetItemId).toBeNull();
  });
});

describe("labor_cost_postings table — the posting/reversal link (no writer exists yet, A5)", () => {
  it("links a labor allocation to the expenses row its (future) posting creates", async () => {
    const employee = await insertEmployee();
    const [period] = await db
      .insert(payrollPeriods)
      .values({ companyId, periodStart: "2026-06-01", periodEnd: "2026-06-30", createdBy: userId })
      .returning();
    const [record] = await db
      .insert(payrollRecords)
      .values({ companyId, payrollPeriodId: period.id, employeeId: employee.id, grossAmount: "4000.00", netAmount: "3600.00", createdBy: userId })
      .returning();
    const [allocation] = await db
      .insert(laborAllocations)
      .values({ companyId, payrollRecordId: record.id, projectId, amount: "3600.00", createdBy: userId })
      .returning();
    const [expense] = await db
      .insert(expenses)
      .values({ projectId, description: "Labor cost — posted", amount: "3600.00", expenseDate: "2026-06-30" })
      .returning();
    const [posting] = await db
      .insert(laborCostPostings)
      .values({ companyId, payrollPeriodId: period.id, laborAllocationId: allocation.id, expenseId: expense.id, postedBy: userId })
      .returning();
    expect(posting.kind).toBe("posting");
    expect(posting.reversalOfPostingId).toBeNull();
  });

  it("a reversal never mutates the original posting — it is a new row referencing it", async () => {
    const employee = await insertEmployee();
    const [period] = await db
      .insert(payrollPeriods)
      .values({ companyId, periodStart: "2026-07-01", periodEnd: "2026-07-31", createdBy: userId })
      .returning();
    const [record] = await db
      .insert(payrollRecords)
      .values({ companyId, payrollPeriodId: period.id, employeeId: employee.id, grossAmount: "1000.00", netAmount: "900.00", createdBy: userId })
      .returning();
    const [allocation] = await db
      .insert(laborAllocations)
      .values({ companyId, payrollRecordId: record.id, projectId, amount: "900.00", createdBy: userId })
      .returning();
    const [originalExpense] = await db
      .insert(expenses)
      .values({ projectId, description: "Labor cost", amount: "900.00", expenseDate: "2026-07-31" })
      .returning();
    const [originalPosting] = await db
      .insert(laborCostPostings)
      .values({ companyId, payrollPeriodId: period.id, laborAllocationId: allocation.id, expenseId: originalExpense.id, postedBy: userId })
      .returning();

    // Reversal: a NEW negative-amount expense + a NEW posting row of
    // kind="reversal", never an UPDATE/DELETE on the original.
    const [reversalExpense] = await db
      .insert(expenses)
      .values({ projectId, description: "Labor cost — reversal", amount: "-900.00", expenseDate: "2026-08-01" })
      .returning();
    const [reversalPosting] = await db
      .insert(laborCostPostings)
      .values({
        companyId,
        payrollPeriodId: period.id,
        laborAllocationId: allocation.id,
        expenseId: reversalExpense.id,
        kind: "reversal",
        reversalOfPostingId: originalPosting.id,
        postedBy: userId,
      })
      .returning();

    expect(reversalPosting.reversalOfPostingId).toBe(originalPosting.id);
    const stillOriginal = await db.query.laborCostPostings.findFirst({ where: eq(laborCostPostings.id, originalPosting.id) });
    expect(stillOriginal?.kind).toBe("posting");
    const stillOriginalExpense = await db.query.expenses.findFirst({ where: eq(expenses.id, originalExpense.id) });
    expect(stillOriginalExpense?.amount).toBe("900.00");
  });

  it("attempting to delete an expense that a labor posting references is rejected at the DB level (no orphaned posting)", async () => {
    const employee = await insertEmployee();
    const [period] = await db
      .insert(payrollPeriods)
      .values({ companyId, periodStart: "2026-09-01", periodEnd: "2026-09-30", createdBy: userId })
      .returning();
    const [record] = await db
      .insert(payrollRecords)
      .values({ companyId, payrollPeriodId: period.id, employeeId: employee.id, grossAmount: "500.00", netAmount: "450.00", createdBy: userId })
      .returning();
    const [allocation] = await db
      .insert(laborAllocations)
      .values({ companyId, payrollRecordId: record.id, projectId, amount: "450.00", createdBy: userId })
      .returning();
    const [expense] = await db
      .insert(expenses)
      .values({ projectId, description: "Labor cost", amount: "450.00", expenseDate: "2026-09-30" })
      .returning();
    await db.insert(laborCostPostings).values({ companyId, payrollPeriodId: period.id, laborAllocationId: allocation.id, expenseId: expense.id, postedBy: userId });

    await expect(db.delete(expenses).where(eq(expenses.id, expense.id))).rejects.toSatisfy(
      (err: unknown) => pgErrorInfo(err).code === "23503",
    );
  });
});

describe("payroll_import_batches / payroll_import_rows tables", () => {
  it("stages an import batch against a real files row and links rows back to it", async () => {
    const [period] = await db
      .insert(payrollPeriods)
      .values({ companyId, periodStart: "2026-10-01", periodEnd: "2026-10-31", createdBy: userId })
      .returning();
    const [file] = await db
      .insert(files)
      .values({
        companyId,
        storageKey: "payroll-import/test.csv",
        fileName: "payroll.csv",
        mimeType: "text/csv",
        size: 128,
        uploadedBy: userId,
        entityType: "payroll_import",
        entityId: period.id,
      })
      .returning();
    const [batch] = await db
      .insert(payrollImportBatches)
      .values({ companyId, payrollPeriodId: period.id, fileId: file.id, createdBy: userId })
      .returning();
    expect(batch.status).toBe("uploaded");

    const [row] = await db
      .insert(payrollImportRows)
      .values({
        companyId,
        importBatchId: batch.id,
        rowNumber: 1,
        rawData: { employeeNumber: "EMP-001", amount: "3000" },
      })
      .returning();
    expect(row.status).toBe("pending");
    expect(row.resultingPayrollRecordId).toBeNull();
  });
});

describe("Phase A permissions", () => {
  it("registers workforce.manage, payroll.manage, and payroll.post as owner-only", () => {
    expect(isPermittedRole("workforce.manage", "owner")).toBe(true);
    expect(isPermittedRole("workforce.manage", "member")).toBe(false);
    expect(isPermittedRole("payroll.manage", "owner")).toBe(true);
    expect(isPermittedRole("payroll.manage", "member")).toBe(false);
    expect(isPermittedRole("payroll.post", "owner")).toBe(true);
    expect(isPermittedRole("payroll.post", "member")).toBe(false);
  });
});
