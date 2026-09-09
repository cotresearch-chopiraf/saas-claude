import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";

// Regression coverage for the Final Pre-Launch Audit's P0/P1 fixes:
//   1. budget.ts — budget.manage RBAC gate + approved-budget-revision
//      immutability guard on the legacy item/expense routes (P0).
//   2. commitments.ts — retentionPercent create + PATCH /terms (P1).
//   3. changeOrders.ts — DELETE RBAC gate + race-safe delete, and the
//      previously-missing audit trail on create/decide/delete (P1).
//   4. invoices.ts/quotes.ts/projects.ts — previously-missing audit events
//      on send/mark-paid/delete (P1).
// Same shared-company-per-file discipline as procurement.test.ts (auth
// endpoints are rate-limited; a real user only registers/invites once).

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
    .send({ companyName: "Launch Audit Co", name: "Owner", email: uniqueEmail("lpa-owner"), password: "password123" });
  expect(ownerRes.status).toBe(201);
  ownerToken = ownerRes.body.token;

  const inviteRes = await request(app)
    .post("/api/company/invites")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ email: uniqueEmail("lpa-member"), role: "member" });
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
    .send({ companyName: "Other Launch Co", name: "Owner B", email: uniqueEmail("lpa-other"), password: "password123" });
  expect(companyBRes.status).toBe(201);
  companyBToken = companyBRes.body.token;
});

async function createProject(token = ownerToken) {
  const res = await request(app)
    .post("/api/projects")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: `Launch Audit Project ${Math.random()}` });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function createBudgetItem(projectId: string, overrides: Record<string, unknown> = {}) {
  const res = await request(app)
    .post(`/api/projects/${projectId}/budget/items`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ category: "أعمال حفر", plannedAmount: 1000, ...overrides });
  expect(res.status).toBe(201);
  return res.body as { id: string };
}

async function createSupplier() {
  const res = await request(app)
    .post("/api/suppliers")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ name: `Supplier ${Math.random()}`, type: "supplier" });
  expect(res.status).toBe(201);
  return res.body as { id: string };
}

describe("budget.ts — budget.manage RBAC gate (P0)", () => {
  it("a member is rejected (403) on every mutation route", async () => {
    const projectId = await createProject();
    const item = await createBudgetItem(projectId);

    const create = await request(app)
      .post(`/api/projects/${projectId}/budget/items`)
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ category: "بند آخر", plannedAmount: 500 });
    expect(create.status).toBe(403);

    const patch = await request(app)
      .patch(`/api/projects/${projectId}/budget/items/${item.id}`)
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ plannedAmount: 2000 });
    expect(patch.status).toBe(403);

    const del = await request(app)
      .delete(`/api/projects/${projectId}/budget/items/${item.id}`)
      .set("Authorization", `Bearer ${memberToken}`);
    expect(del.status).toBe(403);

    const expense = await request(app)
      .post(`/api/projects/${projectId}/budget/expenses`)
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ description: "مصروف", amount: 50, expenseDate: "2026-01-01" });
    expect(expense.status).toBe(403);
  });

  it("an owner can still perform every mutation", async () => {
    const projectId = await createProject();
    const item = await createBudgetItem(projectId);

    const patch = await request(app)
      .patch(`/api/projects/${projectId}/budget/items/${item.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ plannedAmount: 1500 });
    expect(patch.status).toBe(200);
    expect(patch.body.plannedAmount).toBe("1500.00");

    const del = await request(app)
      .delete(`/api/projects/${projectId}/budget/items/${item.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(del.status).toBe(204);
  });

  it("blocks PATCH/DELETE on a budget item that belongs to an approved budget revision", async () => {
    const projectId = await createProject();
    const item = await createBudgetItem(projectId);

    const revision = await request(app)
      .post(`/api/projects/${projectId}/budget-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ reason: "مراجعة اختبار" });
    expect(revision.status).toBe(201);
    const revisionId = revision.body.id as string;

    const assign = await request(app)
      .post(`/api/projects/${projectId}/budget-revisions/${revisionId}/items/${item.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({});
    expect(assign.status).toBe(200);

    const approve = await request(app)
      .post(`/api/projects/${projectId}/budget-revisions/${revisionId}/approve`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(approve.status).toBe(200);
    expect(approve.body.status).toBe("approved");

    const patch = await request(app)
      .patch(`/api/projects/${projectId}/budget/items/${item.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ plannedAmount: 9999 });
    expect(patch.status).toBe(409);

    const del = await request(app)
      .delete(`/api/projects/${projectId}/budget/items/${item.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(del.status).toBe(409);

    // Confirm it genuinely wasn't touched, not just that the response was 409.
    const summary = await request(app)
      .get(`/api/projects/${projectId}/budget`)
      .set("Authorization", `Bearer ${ownerToken}`);
    const stillThere = summary.body.items.find((i: { id: string }) => i.id === item.id);
    expect(stillThere).toBeDefined();
    expect(stillThere.plannedAmount).toBe("1000.00");
  });
});

describe("commitments.ts — retentionPercent write path (P1)", () => {
  it("is settable at creation for a subcontract commitment", async () => {
    const projectId = await createProject();
    const supplier = await createSupplier();

    const res = await request(app)
      .post(`/api/projects/${projectId}/commitments`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ supplierId: supplier.id, type: "subcontract", retentionPercent: 10 });
    expect(res.status).toBe(201);

    // POST / only RETURNING's a minimal row (id/number/status/createdAt),
    // not the full commitment — so read back the persisted value via GET
    // to prove the retentionPercent actually reached the database, rather
    // than asserting on a field the create response was never meant to echo.
    const get = await request(app)
      .get(`/api/projects/${projectId}/commitments/${res.body.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(get.body.retentionPercent).toBe("10.00");
  });

  it("PATCH /terms updates retentionPercent while draft, and is blocked once submitted", async () => {
    const projectId = await createProject();
    const supplier = await createSupplier();

    const create = await request(app)
      .post(`/api/projects/${projectId}/commitments`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ supplierId: supplier.id, type: "subcontract" });
    expect(create.status).toBe(201);
    const commitmentId = create.body.id as string;

    const patch = await request(app)
      .patch(`/api/projects/${projectId}/commitments/${commitmentId}/terms`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ retentionPercent: 5 });
    expect(patch.status).toBe(200);
    expect(patch.body.retentionPercent).toBe("5.00");

    const get1 = await request(app)
      .get(`/api/projects/${projectId}/commitments/${commitmentId}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(get1.body.retentionPercent).toBe("5.00");

    // A member cannot set it (commitment.manage is owner-only).
    const memberPatch = await request(app)
      .patch(`/api/projects/${projectId}/commitments/${commitmentId}/terms`)
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ retentionPercent: 20 });
    expect(memberPatch.status).toBe(403);

    // Add a line and submit — terms should become immutable afterward.
    const line = await request(app)
      .post(`/api/projects/${projectId}/commitments/${commitmentId}/items`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ description: "بند", amount: 1000 });
    expect(line.status).toBe(201);

    const submit = await request(app)
      .post(`/api/projects/${projectId}/commitments/${commitmentId}/submit`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(submit.status).toBe(200);

    const afterSubmit = await request(app)
      .patch(`/api/projects/${projectId}/commitments/${commitmentId}/terms`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ retentionPercent: 15 });
    expect(afterSubmit.status).toBe(409);
  });

  it("rejects a cross-tenant terms update (company B cannot touch company A's commitment)", async () => {
    const projectId = await createProject();
    const supplier = await createSupplier();
    const create = await request(app)
      .post(`/api/projects/${projectId}/commitments`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ supplierId: supplier.id, type: "subcontract" });
    const commitmentId = create.body.id as string;

    const res = await request(app)
      .patch(`/api/projects/${projectId}/commitments/${commitmentId}/terms`)
      .set("Authorization", `Bearer ${companyBToken}`)
      .send({ retentionPercent: 50 });
    expect(res.status).toBe(404);
  });
});

describe("changeOrders.ts — DELETE RBAC gate, race-safe delete, and audit trail (P1)", () => {
  async function createChangeOrder(projectId: string, token = ownerToken) {
    const res = await request(app)
      .post(`/api/projects/${projectId}/change-orders`)
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "تغيير", amountDelta: 500 });
    expect(res.status).toBe(201);
    return res.body.id as string;
  }

  it("create stays member-open (matches Measurement/Task precedent)", async () => {
    const projectId = await createProject();
    const res = await request(app)
      .post(`/api/projects/${projectId}/change-orders`)
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ title: "اقتراح من عضو", amountDelta: 200 });
    expect(res.status).toBe(201);
  });

  it("a member is rejected (403) when deleting a pending change order", async () => {
    const projectId = await createProject();
    const changeOrderId = await createChangeOrder(projectId);
    const res = await request(app)
      .delete(`/api/projects/${projectId}/change-orders/${changeOrderId}`)
      .set("Authorization", `Bearer ${memberToken}`);
    expect(res.status).toBe(403);
  });

  it("an owner can delete a pending change order, and it is rejected once approved", async () => {
    const projectId = await createProject();
    const changeOrderId = await createChangeOrder(projectId);

    const approve = await request(app)
      .patch(`/api/projects/${projectId}/change-orders/${changeOrderId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ status: "approved" });
    expect(approve.status).toBe(200);

    const del = await request(app)
      .delete(`/api/projects/${projectId}/change-orders/${changeOrderId}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(del.status).toBe(409);

    const pendingId = await createChangeOrder(projectId);
    const delPending = await request(app)
      .delete(`/api/projects/${projectId}/change-orders/${pendingId}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(delPending.status).toBe(204);
  });

  it("records audit events for create, decide, and delete (not just logger output)", async () => {
    const projectId = await createProject();
    const changeOrderId = await createChangeOrder(projectId);

    await request(app)
      .patch(`/api/projects/${projectId}/change-orders/${changeOrderId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ status: "rejected" });

    const rejectedId = changeOrderId;
    const secondOrderId = await createChangeOrder(projectId);
    await request(app)
      .delete(`/api/projects/${projectId}/change-orders/${secondOrderId}`)
      .set("Authorization", `Bearer ${ownerToken}`);

    const events = await request(app)
      .get("/api/audit-events?entityType=change_order&limit=50")
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(events.status).toBe(200);
    const actions = events.body.events.map((e: { action: string; entityId: string }) => e.action);
    expect(actions).toContain("changeOrder.created");
    expect(actions).toContain("changeOrder.decided");
    expect(actions).toContain("changeOrder.deleted");
    expect(events.body.events.some((e: { entityId: string }) => e.entityId === rejectedId)).toBe(true);
  });
});

describe("Missing audit trail on financial mutations (P1)", () => {
  it("invoice send/mark-paid write audit events", async () => {
    const create = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ clientName: "عميل الفحص", items: [{ description: "بند", amount: 100 }] });
    expect(create.status).toBe(201);
    const invoiceId = create.body.id as string;

    const send = await request(app)
      .patch(`/api/invoices/${invoiceId}/send`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(send.status).toBe(200);

    const markPaid = await request(app)
      .patch(`/api/invoices/${invoiceId}/mark-paid`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(markPaid.status).toBe(200);

    const events = await request(app)
      .get("/api/audit-events?entityType=invoice&limit=50")
      .set("Authorization", `Bearer ${ownerToken}`);
    const own = events.body.events.filter((e: { entityId: string }) => e.entityId === invoiceId);
    const actions = own.map((e: { action: string }) => e.action);
    expect(actions).toContain("invoice.sent");
    expect(actions).toContain("invoice.markedPaid");
  });

  it("quote send writes an audit event", async () => {
    const create = await request(app)
      .post("/api/quotes")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ clientName: "عميل", projectName: "مشروع", items: [{ description: "بند", amount: 100 }] });
    expect(create.status).toBe(201);
    const quoteId = create.body.id as string;

    const send = await request(app)
      .patch(`/api/quotes/${quoteId}/send`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(send.status).toBe(200);

    const events = await request(app)
      .get("/api/audit-events?entityType=quote&limit=50")
      .set("Authorization", `Bearer ${ownerToken}`);
    const own = events.body.events.filter((e: { entityId: string }) => e.entityId === quoteId);
    expect(own.some((e: { action: string }) => e.action === "quote.sent")).toBe(true);
  });

  it("project deletion writes an audit event", async () => {
    const projectId = await createProject();
    const del = await request(app)
      .delete(`/api/projects/${projectId}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(del.status).toBe(204);

    const events = await request(app)
      .get("/api/audit-events?entityType=project&limit=50")
      .set("Authorization", `Bearer ${ownerToken}`);
    const own = events.body.events.filter((e: { entityId: string }) => e.entityId === projectId);
    expect(own.some((e: { action: string }) => e.action === "project.deleted")).toBe(true);
  });
});
