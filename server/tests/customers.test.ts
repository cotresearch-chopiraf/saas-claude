import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { auditEvents } from "../src/db/schema.js";

// MIDAD Phase A' — Customer entity. Same shared-company-per-file discipline
// as subcontractIpc.test.ts / projectDocuments.test.ts. Also exercises the
// additive projects.customerId link, proving clientName (pre-existing
// free-text field) remains fully independent and untouched.

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
    .send({ companyName: "Customer Test Co", name: "Owner", email: uniqueEmail("cust-owner"), password: "password123" });
  expect(ownerRes.status).toBe(201);
  ownerToken = ownerRes.body.token;

  const inviteRes = await request(app)
    .post("/api/company/invites")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ email: uniqueEmail("cust-member"), role: "member" });
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
    .send({ companyName: "Other Customer Co", name: "Owner B", email: uniqueEmail("cust-other"), password: "password123" });
  expect(companyBRes.status).toBe(201);
  companyBToken = companyBRes.body.token;
});

function createCustomer(body: Record<string, unknown>, token = ownerToken) {
  return request(app).post("/api/customers").set("Authorization", `Bearer ${token}`).send(body);
}
function listCustomers(token = ownerToken) {
  return request(app).get("/api/customers").set("Authorization", `Bearer ${token}`);
}
function getCustomer(id: string, token = ownerToken) {
  return request(app).get(`/api/customers/${id}`).set("Authorization", `Bearer ${token}`);
}
function updateCustomer(id: string, body: Record<string, unknown>, token = ownerToken) {
  return request(app).patch(`/api/customers/${id}`).set("Authorization", `Bearer ${token}`).send(body);
}
function createProject(body: Record<string, unknown>, token = ownerToken) {
  return request(app).post("/api/projects").set("Authorization", `Bearer ${token}`).send(body);
}
function updateProject(id: string, body: Record<string, unknown>, token = ownerToken) {
  return request(app).patch(`/api/projects/${id}`).set("Authorization", `Bearer ${token}`).send(body);
}

describe("Customer entity (Phase A')", () => {
  it("1. an owner can list customers (empty initially)", async () => {
    const res = await listCustomers();
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("2. an owner can create a customer with minimal required data", async () => {
    const res = await createCustomer({ name: "شركة الرياض للمقاولات" });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe("شركة الرياض للمقاولات");
    expect(res.body.status).toBe("active");
    expect(res.body.companyId).toBeTruthy();
  });

  it("3. a created customer appears in the list", async () => {
    const created = await createCustomer({ name: "عميل القائمة" });
    const list = await listCustomers();
    expect(list.body.some((c: { id: string }) => c.id === created.body.id)).toBe(true);
  });

  it("4. a member can list customers (read is member-open)", async () => {
    const res = await listCustomers(memberToken);
    expect(res.status).toBe(200);
  });

  it("5. a member CANNOT create a customer (customer.manage is owner-only)", async () => {
    const res = await createCustomer({ name: "محاولة عضو" }, memberToken);
    expect(res.status).toBe(403);
  });

  it("6. an owner can update a customer's contact fields", async () => {
    const created = await createCustomer({ name: "عميل للتعديل" });
    const res = await updateCustomer(created.body.id, { contactName: "أحمد", phone: "0500000000" });
    expect(res.status).toBe(200);
    expect(res.body.contactName).toBe("أحمد");
    expect(res.body.phone).toBe("0500000000");
  });

  it("7. a member cannot update a customer", async () => {
    const created = await createCustomer({ name: "عميل محمي" });
    const res = await updateCustomer(created.body.id, { contactName: "x" }, memberToken);
    expect(res.status).toBe(403);
  });

  it("8. an owner can toggle a customer's status", async () => {
    const created = await createCustomer({ name: "عميل للتعطيل" });
    const res = await updateCustomer(created.body.id, { status: "inactive" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("inactive");
  });

  it("9. GET /:id returns the customer with an empty projects array when none are linked", async () => {
    const created = await createCustomer({ name: "عميل بدون مشاريع" });
    const res = await getCustomer(created.body.id);
    expect(res.status).toBe(200);
    expect(res.body.projects).toEqual([]);
  });

  it("10. GET /:id returns linked projects (unified profile requirement)", async () => {
    const customer = await createCustomer({ name: "عميل بمشاريع" });
    const project = await createProject({ name: "مشروع مرتبط", customerId: customer.body.id });
    expect(project.status).toBe(201);

    const res = await getCustomer(customer.body.id);
    expect(res.status).toBe(200);
    expect(res.body.projects).toHaveLength(1);
    expect(res.body.projects[0].id).toBe(project.body.id);
    expect(res.body.projects[0].name).toBe("مشروع مرتبط");
  });

  it("11. tenant isolation: a foreign company's list never includes this company's customers", async () => {
    await createCustomer({ name: "عميل خاص بالشركة الأولى" });
    const res = await listCustomers(companyBToken);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("12. tenant isolation: a foreign company cannot GET this company's customer by id", async () => {
    const created = await createCustomer({ name: "عميل محمي من شركة أخرى" });
    const res = await getCustomer(created.body.id, companyBToken);
    expect(res.status).toBe(404);
  });

  it("13. tenant isolation: a foreign company cannot PATCH this company's customer", async () => {
    const created = await createCustomer({ name: "عميل محمي من التعديل" });
    const res = await updateCustomer(created.body.id, { name: "تعديل خبيث" }, companyBToken);
    expect(res.status).toBe(404);
  });

  it("14. a nonexistent customer id returns 404 on GET and PATCH", async () => {
    const getRes = await getCustomer("00000000-0000-0000-0000-000000000000");
    expect(getRes.status).toBe(404);
    const patchRes = await updateCustomer("00000000-0000-0000-0000-000000000000", { name: "x" });
    expect(patchRes.status).toBe(404);
  });

  it("15. unauthenticated requests are rejected on every route", async () => {
    const listRes = await request(app).get("/api/customers");
    expect(listRes.status).toBe(401);
    const createRes = await request(app).post("/api/customers").send({ name: "x" });
    expect(createRes.status).toBe(401);
  });

  it("16. no DELETE route exists on this resource", async () => {
    const created = await createCustomer({ name: "عميل بلا حذف" });
    const res = await request(app).delete(`/api/customers/${created.body.id}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(res.status).toBe(404);
    const stillThere = await getCustomer(created.body.id);
    expect(stillThere.status).toBe(200);
  });

  it("17. project creation accepts a valid customerId link", async () => {
    const customer = await createCustomer({ name: "عميل للربط" });
    const res = await createProject({ name: "مشروع بعميل صحيح", customerId: customer.body.id });
    expect(res.status).toBe(201);
    expect(res.body.customerId).toBe(customer.body.id);
  });

  it("18. project creation rejects a foreign/nonexistent customerId (never silently accepted or dropped)", async () => {
    const res = await createProject({ name: "مشروع بعميل غير موجود", customerId: "00000000-0000-0000-0000-000000000000" });
    expect(res.status).toBe(400);
  });

  it("19. omitting customerId leaves it null and never touches clientName", async () => {
    const res = await createProject({ name: "مشروع بدون عميل", clientName: "اسم نصي حر" });
    expect(res.status).toBe(201);
    expect(res.body.customerId).toBeNull();
    expect(res.body.clientName).toBe("اسم نصي حر");
  });

  it("20. an existing project can have a customer linked later via PATCH", async () => {
    const project = await createProject({ name: "مشروع يُربط لاحقاً" });
    const customer = await createCustomer({ name: "عميل للربط اللاحق" });
    const res = await updateProject(project.body.id, { customerId: customer.body.id });
    expect(res.status).toBe(200);
    expect(res.body.customerId).toBe(customer.body.id);
  });

  it("21. a linked customer can be explicitly cleared (set null) via PATCH", async () => {
    const customer = await createCustomer({ name: "عميل للإلغاء" });
    const project = await createProject({ name: "مشروع لإلغاء الربط", customerId: customer.body.id });
    const res = await updateProject(project.body.id, { customerId: null });
    expect(res.status).toBe(200);
    expect(res.body.customerId).toBeNull();
  });

  it("22. clientName and customerId are fully independent — setting one never modifies the other", async () => {
    const customer = await createCustomer({ name: "عميل مستقل" });
    const project = await createProject({ name: "مشروع مستقل", clientName: "نص حر مستقل", customerId: customer.body.id });
    expect(project.body.clientName).toBe("نص حر مستقل");
    expect(project.body.customerId).toBe(customer.body.id);

    const patched = await updateProject(project.body.id, { clientName: "نص محدث" });
    expect(patched.body.clientName).toBe("نص محدث");
    expect(patched.body.customerId).toBe(customer.body.id); // untouched by a clientName-only update
  });

  it("23. customer creation and update are audited", async () => {
    const created = await createCustomer({ name: "عميل مدقّق" });
    await updateCustomer(created.body.id, { contactName: "محدَّث" });

    const events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, created.body.id) });
    const actions = events.map((e) => e.action);
    expect(actions).toContain("customer.created");
    expect(actions).toContain("customer.updated");
  });
});
