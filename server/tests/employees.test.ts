import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { auditEvents } from "../src/db/schema.js";

// MIDAD Phase A2 — Employees CRUD. Same shared-company-per-file discipline
// as customers.test.ts, which this file mirrors closely (same domain
// shape: company-wide master data, no delete endpoint, owner-gated
// mutations, member-open reads) — plus the employee-specific invariants
// this domain adds: a per-company unique employeeNumber (backstopped by a
// DB unique index, not just app-level validation) and a status lifecycle
// used in place of deletion.

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
    .send({ companyName: "Employee Test Co", name: "Owner", email: uniqueEmail("emp-owner"), password: "password123" });
  expect(ownerRes.status).toBe(201);
  ownerToken = ownerRes.body.token;

  const inviteRes = await request(app)
    .post("/api/company/invites")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ email: uniqueEmail("emp-member"), role: "member" });
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
    .send({ companyName: "Other Employee Co", name: "Owner B", email: uniqueEmail("emp-other"), password: "password123" });
  expect(companyBRes.status).toBe(201);
  companyBToken = companyBRes.body.token;
});

function createEmployee(body: Record<string, unknown>, token = ownerToken) {
  return request(app).post("/api/employees").set("Authorization", `Bearer ${token}`).send(body);
}
function listEmployees(token = ownerToken) {
  return request(app).get("/api/employees").set("Authorization", `Bearer ${token}`);
}
function getEmployee(id: string, token = ownerToken) {
  return request(app).get(`/api/employees/${id}`).set("Authorization", `Bearer ${token}`);
}
function updateEmployee(id: string, body: Record<string, unknown>, token = ownerToken) {
  return request(app).patch(`/api/employees/${id}`).set("Authorization", `Bearer ${token}`).send(body);
}

let empCounter = 0;
function nextEmployeeNumber(): string {
  empCounter += 1;
  return `EMP-${empCounter}`;
}

describe("Employee entity (Phase A2)", () => {
  it("1. an owner can list employees (empty initially)", async () => {
    const res = await listEmployees();
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("2. an owner can create an employee with minimal required data", async () => {
    const res = await createEmployee({ name: "أحمد الشمري", employeeNumber: nextEmployeeNumber() });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe("أحمد الشمري");
    expect(res.body.status).toBe("active");
    expect(res.body.companyId).toBeTruthy();
    expect(res.body.jobTitle).toBeNull();
    expect(res.body.hireDate).toBeNull();
  });

  it("3. a created employee appears in the list", async () => {
    const created = await createEmployee({ name: "موظف القائمة", employeeNumber: nextEmployeeNumber() });
    const list = await listEmployees();
    expect(list.body.some((e: { id: string }) => e.id === created.body.id)).toBe(true);
  });

  it("4. a member can list employees (read is member-open)", async () => {
    const res = await listEmployees(memberToken);
    expect(res.status).toBe(200);
  });

  it("5. a member CANNOT create an employee (workforce.manage is owner-only)", async () => {
    const res = await createEmployee({ name: "محاولة عضو", employeeNumber: nextEmployeeNumber() }, memberToken);
    expect(res.status).toBe(403);
  });

  it("6. creation rejects a missing name / missing employee number", async () => {
    const noName = await createEmployee({ employeeNumber: nextEmployeeNumber() });
    expect(noName.status).toBe(400);
    const noNumber = await createEmployee({ name: "بدون رقم" });
    expect(noNumber.status).toBe(400);
  });

  it("7. creation rejects an invalid email format", async () => {
    const res = await createEmployee({ name: "بريد غير صالح", employeeNumber: nextEmployeeNumber(), email: "not-an-email" });
    expect(res.status).toBe(400);
  });

  it("8. an owner can set jobTitle/hireDate/email/phone on creation", async () => {
    const res = await createEmployee({
      name: "موظف كامل البيانات",
      employeeNumber: nextEmployeeNumber(),
      jobTitle: "مهندس موقع",
      hireDate: "2026-01-15",
      email: "worker@example.com",
      phone: "0501234567",
    });
    expect(res.status).toBe(201);
    expect(res.body.jobTitle).toBe("مهندس موقع");
    expect(res.body.hireDate).toBe("2026-01-15");
    expect(res.body.email).toBe("worker@example.com");
    expect(res.body.phone).toBe("0501234567");
  });

  it("9. duplicate employeeNumber within the same company is rejected cleanly (409, no raw DB error)", async () => {
    const num = nextEmployeeNumber();
    const first = await createEmployee({ name: "الأول", employeeNumber: num });
    expect(first.status).toBe(201);
    const second = await createEmployee({ name: "الثاني بنفس الرقم", employeeNumber: num });
    expect(second.status).toBe(409);
    expect(JSON.stringify(second.body)).not.toMatch(/duplicate key|constraint|23505|stack|SQL/i);
  });

  it("10. the same employeeNumber is allowed across two different companies (uniqueness is per-company)", async () => {
    const num = nextEmployeeNumber();
    const first = await createEmployee({ name: "شركة أولى", employeeNumber: num });
    expect(first.status).toBe(201);
    const second = await createEmployee({ name: "شركة أخرى", employeeNumber: num }, companyBToken);
    expect(second.status).toBe(201);
  });

  it("11. concurrent creation with the same employeeNumber: exactly one succeeds", async () => {
    const num = nextEmployeeNumber();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => createEmployee({ name: "سباق", employeeNumber: num })),
    );
    const succeeded = results.filter((r) => r.status === 201);
    const conflicted = results.filter((r) => r.status === 409);
    expect(succeeded).toHaveLength(1);
    expect(conflicted).toHaveLength(4);

    const list = await listEmployees();
    const matching = list.body.filter((e: { employeeNumber: string }) => e.employeeNumber === num);
    expect(matching).toHaveLength(1);
  });

  it("12. an owner can update an employee's contact/job fields", async () => {
    const created = await createEmployee({ name: "موظف للتعديل", employeeNumber: nextEmployeeNumber() });
    const res = await updateEmployee(created.body.id, { jobTitle: "مشرف", phone: "0500000000" });
    expect(res.status).toBe(200);
    expect(res.body.jobTitle).toBe("مشرف");
    expect(res.body.phone).toBe("0500000000");
  });

  it("13. a member cannot update an employee", async () => {
    const created = await createEmployee({ name: "موظف محمي", employeeNumber: nextEmployeeNumber() });
    const res = await updateEmployee(created.body.id, { jobTitle: "x" }, memberToken);
    expect(res.status).toBe(403);
  });

  it("14. updating employeeNumber to one already used in the company is rejected cleanly (409)", async () => {
    const numA = nextEmployeeNumber();
    const numB = nextEmployeeNumber();
    await createEmployee({ name: "موظف أ", employeeNumber: numA });
    const b = await createEmployee({ name: "موظف ب", employeeNumber: numB });
    const res = await updateEmployee(b.body.id, { employeeNumber: numA });
    expect(res.status).toBe(409);
  });

  it("15. an owner can deactivate then reactivate an employee (lifecycle is deterministic)", async () => {
    const created = await createEmployee({ name: "موظف للتعطيل", employeeNumber: nextEmployeeNumber() });
    const deactivated = await updateEmployee(created.body.id, { status: "inactive" });
    expect(deactivated.status).toBe(200);
    expect(deactivated.body.status).toBe("inactive");

    // Inactive is not silently promoted back to active by an unrelated update.
    const unrelatedUpdate = await updateEmployee(created.body.id, { jobTitle: "لا علاقة بالحالة" });
    expect(unrelatedUpdate.body.status).toBe("inactive");

    const reactivated = await updateEmployee(created.body.id, { status: "active" });
    expect(reactivated.status).toBe(200);
    expect(reactivated.body.status).toBe("active");
  });

  it("16. repeated deactivation is idempotent in effect (stays inactive, no error)", async () => {
    const created = await createEmployee({ name: "تعطيل متكرر", employeeNumber: nextEmployeeNumber() });
    await updateEmployee(created.body.id, { status: "inactive" });
    const again = await updateEmployee(created.body.id, { status: "inactive" });
    expect(again.status).toBe(200);
    expect(again.body.status).toBe("inactive");
  });

  it("17. GET /:id returns the employee", async () => {
    const created = await createEmployee({ name: "موظف للعرض", employeeNumber: nextEmployeeNumber() });
    const res = await getEmployee(created.body.id);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(created.body.id);
  });

  it("18. tenant isolation: a foreign company's list never includes this company's employees", async () => {
    await createEmployee({ name: "موظف خاص بالشركة الأولى", employeeNumber: nextEmployeeNumber() });
    const res = await listEmployees(companyBToken);
    const names = res.body.map((e: { name: string }) => e.name);
    expect(names).not.toContain("موظف خاص بالشركة الأولى");
  });

  it("19. tenant isolation: a foreign company cannot GET this company's employee by id (direct ID manipulation)", async () => {
    const created = await createEmployee({ name: "موظف محمي من شركة أخرى", employeeNumber: nextEmployeeNumber() });
    const res = await getEmployee(created.body.id, companyBToken);
    expect(res.status).toBe(404);
  });

  it("20. tenant isolation: a foreign company cannot PATCH this company's employee (direct ID manipulation)", async () => {
    const created = await createEmployee({ name: "موظف محمي من التعديل", employeeNumber: nextEmployeeNumber() });
    const res = await updateEmployee(created.body.id, { name: "تعديل خبيث" }, companyBToken);
    expect(res.status).toBe(404);

    const stillOriginal = await getEmployee(created.body.id);
    expect(stillOriginal.body.name).toBe("موظف محمي من التعديل");
  });

  it("21. tenant isolation: a foreign company cannot deactivate this company's employee", async () => {
    const created = await createEmployee({ name: "موظف لن يُعطَّل من الخارج", employeeNumber: nextEmployeeNumber() });
    const res = await updateEmployee(created.body.id, { status: "inactive" }, companyBToken);
    expect(res.status).toBe(404);

    const stillActive = await getEmployee(created.body.id);
    expect(stillActive.body.status).toBe("active");
  });

  it("22. a nonexistent employee id returns 404 on GET and PATCH", async () => {
    const getRes = await getEmployee("00000000-0000-0000-0000-000000000000");
    expect(getRes.status).toBe(404);
    const patchRes = await updateEmployee("00000000-0000-0000-0000-000000000000", { name: "x" });
    expect(patchRes.status).toBe(404);
  });

  it("23. unauthenticated requests are rejected on every route", async () => {
    const listRes = await request(app).get("/api/employees");
    expect(listRes.status).toBe(401);
    const createRes = await request(app).post("/api/employees").send({ name: "x", employeeNumber: "x" });
    expect(createRes.status).toBe(401);
  });

  it("24. no DELETE route exists on this resource — historical references can never be destroyed this way", async () => {
    const created = await createEmployee({ name: "موظف بلا حذف", employeeNumber: nextEmployeeNumber() });
    const res = await request(app).delete(`/api/employees/${created.body.id}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(404);
    const stillThere = await getEmployee(created.body.id);
    expect(stillThere.status).toBe(200);
  });

  it("25. employee creation, update, activation and deactivation are all audited distinctly", async () => {
    const created = await createEmployee({ name: "موظف مدقّق", employeeNumber: nextEmployeeNumber() });
    await updateEmployee(created.body.id, { jobTitle: "محدَّث" });
    await updateEmployee(created.body.id, { status: "inactive" });
    await updateEmployee(created.body.id, { status: "active" });

    const events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, created.body.id) });
    const actions = events.map((e) => e.action);
    expect(actions).toContain("employee.created");
    expect(actions).toContain("employee.updated");
    expect(actions).toContain("employee.deactivated");
    expect(actions).toContain("employee.activated");
    // Every audited event carries this company's id (tenant-scoped trail).
    expect(events.every((e) => e.companyId)).toBe(true);
  });
});
