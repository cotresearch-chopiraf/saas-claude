import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { auditEvents, idempotencyKeys } from "../src/db/schema.js";
import { withIdempotency, IdempotencyLeaseLostError } from "../src/lib/idempotency.js";

// Slice AA Scope E — opt-in Idempotency-Key support for invoice/quote
// creation. Five-scenario matrix per the slice's own requirement: first
// request, exact retry, concurrent retry, conflicting payload, cross-tenant
// isolation.

vi.mock("../src/lib/mailer.js", () => ({ sendMail: vi.fn() }));

const app = buildApp();

let tokenA: string;
let tokenB: string;
let companyIdA: string;

beforeAll(async () => {
  await resetDb();
  const a = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Idem Co A", name: "Owner A", email: "idem-owner-a@test.com", password: "password123" });
  tokenA = a.body.token;
  companyIdA = a.body.company.id;

  const b = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Idem Co B", name: "Owner B", email: "idem-owner-b@test.com", password: "password123" });
  tokenB = b.body.token;
});

function invoicePayload(overrides: Partial<{ clientName: string }> = {}) {
  return { clientName: "Idem Client", items: [{ description: "Item", amount: 500 }], ...overrides };
}

function quotePayload(overrides: Partial<{ clientName: string }> = {}) {
  return {
    clientName: "Idem Client",
    projectName: "Idem Project",
    items: [{ description: "Item", amount: 500 }],
    ...overrides,
  };
}

async function createProject(token: string) {
  const res = await request(app)
    .post("/api/projects")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: `Idem Project ${Math.random()}`, budgetTotal: 50000 });
  return res.body.id as string;
}

function expensePayload(overrides: Partial<{ description: string }> = {}) {
  return { description: "Idem Expense", amount: 250, expenseDate: "2026-01-01", ...overrides };
}

async function createSupplier(token: string) {
  const res = await request(app)
    .post("/api/suppliers")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: `Idem Supplier ${Math.random()}`, type: "supplier" });
  return res.body.id as string;
}

function commitmentPayload(supplierId: string, overrides: Partial<{ type: string; description: string }> = {}) {
  return { supplierId, type: "purchase_order", ...overrides };
}

describe("Idempotency: invoice creation", () => {
  it("first request creates an invoice and returns 201", async () => {
    const res = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${tokenA}`)
      .set("Idempotency-Key", "invoice-first-1")
      .send(invoicePayload());
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
  });

  it("exact retry (same key, same payload) returns the original result, not a new invoice", async () => {
    const key = "invoice-exact-retry-1";
    const first = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${tokenA}`)
      .set("Idempotency-Key", key)
      .send(invoicePayload());
    expect(first.status).toBe(201);

    const retry = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${tokenA}`)
      .set("Idempotency-Key", key)
      .send(invoicePayload());
    expect(retry.status).toBe(201);
    expect(retry.body.id).toBe(first.body.id);

    const listRes = await request(app).get("/api/invoices").set("Authorization", `Bearer ${tokenA}`);
    const matching = listRes.body.invoices.filter((inv: { clientName: string }) => inv.clientName === "Idem Client");
    // Only assert no duplicate was created for THIS key's invoice id.
    expect(matching.filter((inv: { id: string }) => inv.id === first.body.id).length).toBe(1);
  });

  it("N concurrent requests with the SAME key create exactly one invoice", async () => {
    const key = "invoice-concurrent-1";
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        request(app)
          .post("/api/invoices")
          .set("Authorization", `Bearer ${tokenA}`)
          .set("Idempotency-Key", key)
          .send(invoicePayload()),
      ),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    const ids = new Set(results.map((r) => r.body.id));
    expect(ids.size).toBe(1);
  });

  it("same key reused with a materially different payload returns a deterministic 409, not a silent replay", async () => {
    const key = "invoice-conflict-1";
    const first = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${tokenA}`)
      .set("Idempotency-Key", key)
      .send(invoicePayload({ clientName: "Original Client" }));
    expect(first.status).toBe(201);

    const conflict = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${tokenA}`)
      .set("Idempotency-Key", key)
      .send(invoicePayload({ clientName: "Different Client" }));
    expect(conflict.status).toBe(409);
  });

  it("cross-tenant: the same key used by a different company creates its own independent invoice", async () => {
    const key = "invoice-cross-tenant-1";
    const a = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${tokenA}`)
      .set("Idempotency-Key", key)
      .send(invoicePayload());
    const b = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${tokenB}`)
      .set("Idempotency-Key", key)
      .send(invoicePayload());
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.id).not.toBe(b.body.id);
  });

  it("without an Idempotency-Key header, behavior is unchanged (each request creates a new invoice)", async () => {
    const first = await request(app).post("/api/invoices").set("Authorization", `Bearer ${tokenA}`).send(invoicePayload());
    const second = await request(app).post("/api/invoices").set("Authorization", `Bearer ${tokenA}`).send(invoicePayload());
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.id).not.toBe(second.body.id);
  });
});

describe("Idempotency: quote creation", () => {
  it("first request creates a quote and returns 201", async () => {
    const res = await request(app)
      .post("/api/quotes")
      .set("Authorization", `Bearer ${tokenA}`)
      .set("Idempotency-Key", "quote-first-1")
      .send(quotePayload());
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
  });

  it("exact retry (same key, same payload) returns the original quote", async () => {
    const key = "quote-exact-retry-1";
    const first = await request(app)
      .post("/api/quotes")
      .set("Authorization", `Bearer ${tokenA}`)
      .set("Idempotency-Key", key)
      .send(quotePayload());
    const retry = await request(app)
      .post("/api/quotes")
      .set("Authorization", `Bearer ${tokenA}`)
      .set("Idempotency-Key", key)
      .send(quotePayload());
    expect(retry.status).toBe(201);
    expect(retry.body.id).toBe(first.body.id);
  });

  it("N concurrent requests with the SAME key create exactly one quote", async () => {
    const key = "quote-concurrent-1";
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        request(app)
          .post("/api/quotes")
          .set("Authorization", `Bearer ${tokenA}`)
          .set("Idempotency-Key", key)
          .send(quotePayload()),
      ),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    const ids = new Set(results.map((r) => r.body.id));
    expect(ids.size).toBe(1);
  });

  it("same key reused with a materially different payload returns a deterministic 409", async () => {
    const key = "quote-conflict-1";
    const first = await request(app)
      .post("/api/quotes")
      .set("Authorization", `Bearer ${tokenA}`)
      .set("Idempotency-Key", key)
      .send(quotePayload({ clientName: "Original Client" }));
    expect(first.status).toBe(201);

    const conflict = await request(app)
      .post("/api/quotes")
      .set("Authorization", `Bearer ${tokenA}`)
      .set("Idempotency-Key", key)
      .send(quotePayload({ clientName: "Different Client" }));
    expect(conflict.status).toBe(409);
  });

  it("cross-tenant: the same key used by a different company creates its own independent quote", async () => {
    const key = "quote-cross-tenant-1";
    const a = await request(app)
      .post("/api/quotes")
      .set("Authorization", `Bearer ${tokenA}`)
      .set("Idempotency-Key", key)
      .send(quotePayload());
    const b = await request(app)
      .post("/api/quotes")
      .set("Authorization", `Bearer ${tokenB}`)
      .set("Idempotency-Key", key)
      .send(quotePayload());
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.id).not.toBe(b.body.id);
  });
});

// Wave 1F (W1E-002 remediation) — same opt-in Idempotency-Key matrix as
// invoice/quote creation above, applied to expense creation.
describe("Idempotency: expense creation", () => {
  it("normal expense creation still succeeds", async () => {
    const projectId = await createProject(tokenA);
    const res = await request(app)
      .post(`/api/projects/${projectId}/budget/expenses`)
      .set("Authorization", `Bearer ${tokenA}`)
      .set("Idempotency-Key", "expense-first-1")
      .send(expensePayload());
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
  });

  it("same key repeated sequentially creates exactly one expense", async () => {
    const projectId = await createProject(tokenA);
    const key = "expense-exact-retry-1";
    const first = await request(app)
      .post(`/api/projects/${projectId}/budget/expenses`)
      .set("Authorization", `Bearer ${tokenA}`)
      .set("Idempotency-Key", key)
      .send(expensePayload());
    expect(first.status).toBe(201);

    const retry = await request(app)
      .post(`/api/projects/${projectId}/budget/expenses`)
      .set("Authorization", `Bearer ${tokenA}`)
      .set("Idempotency-Key", key)
      .send(expensePayload());
    expect(retry.status).toBe(201);
    expect(retry.body.id).toBe(first.body.id);

    const budget = await request(app).get(`/api/projects/${projectId}/budget`).set("Authorization", `Bearer ${tokenA}`);
    expect(budget.body.expenses.filter((e: { id: string }) => e.id === first.body.id).length).toBe(1);
  });

  it("N concurrent requests with the SAME key create exactly one expense (genuine concurrency)", async () => {
    const projectId = await createProject(tokenA);
    const key = "expense-concurrent-1";
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        request(app)
          .post(`/api/projects/${projectId}/budget/expenses`)
          .set("Authorization", `Bearer ${tokenA}`)
          .set("Idempotency-Key", key)
          .send(expensePayload()),
      ),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    const ids = new Set(results.map((r) => r.body.id));
    // This is the assertion that would fail against the pre-Wave-1F route:
    // without withIdempotency, 8 concurrent inserts would each succeed
    // independently and this set would have size 8, not 1.
    expect(ids.size).toBe(1);

    const budget = await request(app).get(`/api/projects/${projectId}/budget`).set("Authorization", `Bearer ${tokenA}`);
    expect(budget.body.expenses.length).toBe(1);
  });

  it("different keys create separate expenses", async () => {
    const projectId = await createProject(tokenA);
    const a = await request(app)
      .post(`/api/projects/${projectId}/budget/expenses`)
      .set("Authorization", `Bearer ${tokenA}`)
      .set("Idempotency-Key", "expense-key-a")
      .send(expensePayload());
    const b = await request(app)
      .post(`/api/projects/${projectId}/budget/expenses`)
      .set("Authorization", `Bearer ${tokenA}`)
      .set("Idempotency-Key", "expense-key-b")
      .send(expensePayload());
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.id).not.toBe(b.body.id);
  });

  it("cross-tenant: the same key used by a different company creates its own independent expense", async () => {
    const projectA = await createProject(tokenA);
    const projectB = await createProject(tokenB);
    const key = "expense-cross-tenant-1";
    const a = await request(app)
      .post(`/api/projects/${projectA}/budget/expenses`)
      .set("Authorization", `Bearer ${tokenA}`)
      .set("Idempotency-Key", key)
      .send(expensePayload());
    const b = await request(app)
      .post(`/api/projects/${projectB}/budget/expenses`)
      .set("Authorization", `Bearer ${tokenB}`)
      .set("Idempotency-Key", key)
      .send(expensePayload());
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.id).not.toBe(b.body.id);
  });

  it("replay returns the original response (same id, same fields) rather than a fresh row", async () => {
    const projectId = await createProject(tokenA);
    const key = "expense-replay-1";
    const first = await request(app)
      .post(`/api/projects/${projectId}/budget/expenses`)
      .set("Authorization", `Bearer ${tokenA}`)
      .set("Idempotency-Key", key)
      .send(expensePayload({ description: "Replay target expense" }));
    expect(first.status).toBe(201);

    const replay = await request(app)
      .post(`/api/projects/${projectId}/budget/expenses`)
      .set("Authorization", `Bearer ${tokenA}`)
      .set("Idempotency-Key", key)
      .send(expensePayload({ description: "Replay target expense" }));
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
  });

  it("replay does not create a duplicate audit event", async () => {
    const projectId = await createProject(tokenA);
    const key = "expense-audit-1";
    const first = await request(app)
      .post(`/api/projects/${projectId}/budget/expenses`)
      .set("Authorization", `Bearer ${tokenA}`)
      .set("Idempotency-Key", key)
      .send(expensePayload());
    expect(first.status).toBe(201);

    await request(app)
      .post(`/api/projects/${projectId}/budget/expenses`)
      .set("Authorization", `Bearer ${tokenA}`)
      .set("Idempotency-Key", key)
      .send(expensePayload());

    const events = await db.query.auditEvents.findMany({
      where: and(eq(auditEvents.entityType, "expense"), eq(auditEvents.entityId, first.body.id), eq(auditEvents.action, "expense.created")),
    });
    expect(events.length).toBe(1);
  });

  it("without an Idempotency-Key header, behavior is unchanged (each request creates a new expense)", async () => {
    const projectId = await createProject(tokenA);
    const first = await request(app)
      .post(`/api/projects/${projectId}/budget/expenses`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send(expensePayload());
    const second = await request(app)
      .post(`/api/projects/${projectId}/budget/expenses`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send(expensePayload());
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.id).not.toBe(second.body.id);
  });

  // E1 — the expense.create path shares withIdempotency() with
  // invoice/quote creation above, but conflicting-payload behavior had
  // never been exercised for expenses specifically until now. This proves
  // the existing semantics (same key + materially different payload → a
  // deterministic 409, never a silent replay of the wrong expense) already
  // hold for expenses too — nothing about withIdempotency() itself changes
  // here.
  it("same key reused with a materially different payload returns a deterministic 409, not a silent replay", async () => {
    const projectId = await createProject(tokenA);
    const key = "expense-conflict-1";
    const first = await request(app)
      .post(`/api/projects/${projectId}/budget/expenses`)
      .set("Authorization", `Bearer ${tokenA}`)
      .set("Idempotency-Key", key)
      .send(expensePayload({ description: "Original expense" }));
    expect(first.status).toBe(201);

    const conflict = await request(app)
      .post(`/api/projects/${projectId}/budget/expenses`)
      .set("Authorization", `Bearer ${tokenA}`)
      .set("Idempotency-Key", key)
      .send(expensePayload({ description: "Different expense" }));
    expect(conflict.status).toBe(409);
  });
});

// E2 (production-readiness remediation) — same opt-in Idempotency-Key
// matrix as invoice/quote/expense creation above, applied to Commitment
// creation: a network retry, double-submit, or concurrent duplicate
// request must not create two logically identical Commitments and inflate
// committed cost.
describe("Idempotency: commitment creation", () => {
  it("normal commitment creation still succeeds", async () => {
    const projectId = await createProject(tokenA);
    const supplierId = await createSupplier(tokenA);
    const res = await request(app)
      .post(`/api/projects/${projectId}/commitments`)
      .set("Authorization", `Bearer ${tokenA}`)
      .set("Idempotency-Key", "commitment-first-1")
      .send(commitmentPayload(supplierId));
    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
  });

  it("same key repeated sequentially creates exactly one commitment", async () => {
    const projectId = await createProject(tokenA);
    const supplierId = await createSupplier(tokenA);
    const key = "commitment-exact-retry-1";
    const first = await request(app)
      .post(`/api/projects/${projectId}/commitments`)
      .set("Authorization", `Bearer ${tokenA}`)
      .set("Idempotency-Key", key)
      .send(commitmentPayload(supplierId));
    expect(first.status).toBe(201);

    const retry = await request(app)
      .post(`/api/projects/${projectId}/commitments`)
      .set("Authorization", `Bearer ${tokenA}`)
      .set("Idempotency-Key", key)
      .send(commitmentPayload(supplierId));
    expect(retry.status).toBe(201);
    expect(retry.body.id).toBe(first.body.id);

    const list = await request(app).get(`/api/projects/${projectId}/commitments`).set("Authorization", `Bearer ${tokenA}`);
    expect(list.body.filter((c: { id: string }) => c.id === first.body.id).length).toBe(1);
  });

  it("N concurrent requests with the SAME key create exactly one commitment (genuine concurrency)", async () => {
    const projectId = await createProject(tokenA);
    const supplierId = await createSupplier(tokenA);
    const key = "commitment-concurrent-1";
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        request(app)
          .post(`/api/projects/${projectId}/commitments`)
          .set("Authorization", `Bearer ${tokenA}`)
          .set("Idempotency-Key", key)
          .send(commitmentPayload(supplierId)),
      ),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    const ids = new Set(results.map((r) => r.body.id));
    // Without withIdempotency, 8 concurrent inserts would each claim their
    // own commitment_number and this set would have size 8, not 1.
    expect(ids.size).toBe(1);

    const list = await request(app).get(`/api/projects/${projectId}/commitments`).set("Authorization", `Bearer ${tokenA}`);
    expect(list.body.length).toBe(1);
  });

  it("different keys create separate commitments", async () => {
    const projectId = await createProject(tokenA);
    const supplierId = await createSupplier(tokenA);
    const a = await request(app)
      .post(`/api/projects/${projectId}/commitments`)
      .set("Authorization", `Bearer ${tokenA}`)
      .set("Idempotency-Key", "commitment-key-a")
      .send(commitmentPayload(supplierId));
    const b = await request(app)
      .post(`/api/projects/${projectId}/commitments`)
      .set("Authorization", `Bearer ${tokenA}`)
      .set("Idempotency-Key", "commitment-key-b")
      .send(commitmentPayload(supplierId));
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.id).not.toBe(b.body.id);
  });

  it("cross-tenant: the same key used by a different company creates its own independent commitment", async () => {
    const projectA = await createProject(tokenA);
    const projectB = await createProject(tokenB);
    const supplierA = await createSupplier(tokenA);
    const supplierB = await createSupplier(tokenB);
    const key = "commitment-cross-tenant-1";
    const a = await request(app)
      .post(`/api/projects/${projectA}/commitments`)
      .set("Authorization", `Bearer ${tokenA}`)
      .set("Idempotency-Key", key)
      .send(commitmentPayload(supplierA));
    const b = await request(app)
      .post(`/api/projects/${projectB}/commitments`)
      .set("Authorization", `Bearer ${tokenB}`)
      .set("Idempotency-Key", key)
      .send(commitmentPayload(supplierB));
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.id).not.toBe(b.body.id);
  });

  it("replay returns the original response (same id, same fields) rather than a fresh row", async () => {
    const projectId = await createProject(tokenA);
    const supplierId = await createSupplier(tokenA);
    const key = "commitment-replay-1";
    const first = await request(app)
      .post(`/api/projects/${projectId}/commitments`)
      .set("Authorization", `Bearer ${tokenA}`)
      .set("Idempotency-Key", key)
      .send(commitmentPayload(supplierId, { description: "Replay target commitment" }));
    expect(first.status).toBe(201);

    const replay = await request(app)
      .post(`/api/projects/${projectId}/commitments`)
      .set("Authorization", `Bearer ${tokenA}`)
      .set("Idempotency-Key", key)
      .send(commitmentPayload(supplierId, { description: "Replay target commitment" }));
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
  });

  it("replay does not create a duplicate audit event", async () => {
    const projectId = await createProject(tokenA);
    const supplierId = await createSupplier(tokenA);
    const key = "commitment-audit-1";
    const first = await request(app)
      .post(`/api/projects/${projectId}/commitments`)
      .set("Authorization", `Bearer ${tokenA}`)
      .set("Idempotency-Key", key)
      .send(commitmentPayload(supplierId));
    expect(first.status).toBe(201);

    await request(app)
      .post(`/api/projects/${projectId}/commitments`)
      .set("Authorization", `Bearer ${tokenA}`)
      .set("Idempotency-Key", key)
      .send(commitmentPayload(supplierId));

    const events = await db.query.auditEvents.findMany({
      where: and(eq(auditEvents.entityType, "commitment"), eq(auditEvents.entityId, first.body.id), eq(auditEvents.action, "commitment.created")),
    });
    expect(events.length).toBe(1);
  });

  it("without an Idempotency-Key header, behavior is unchanged (each request creates a new commitment)", async () => {
    const projectId = await createProject(tokenA);
    const supplierId = await createSupplier(tokenA);
    const first = await request(app)
      .post(`/api/projects/${projectId}/commitments`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send(commitmentPayload(supplierId));
    const second = await request(app)
      .post(`/api/projects/${projectId}/commitments`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send(commitmentPayload(supplierId));
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.id).not.toBe(second.body.id);
  });

  it("same key reused with a materially different payload returns a deterministic 409, not a silent replay", async () => {
    const projectId = await createProject(tokenA);
    const supplierId = await createSupplier(tokenA);
    const key = "commitment-conflict-1";
    const first = await request(app)
      .post(`/api/projects/${projectId}/commitments`)
      .set("Authorization", `Bearer ${tokenA}`)
      .set("Idempotency-Key", key)
      .send(commitmentPayload(supplierId, { description: "Original commitment" }));
    expect(first.status).toBe(201);

    const conflict = await request(app)
      .post(`/api/projects/${projectId}/commitments`)
      .set("Authorization", `Bearer ${tokenA}`)
      .set("Idempotency-Key", key)
      .send(commitmentPayload(supplierId, { description: "Different commitment" }));
    expect(conflict.status).toBe(409);
  });

  // Existing Commitment authorization must remain intact: requirePermission
  // runs as route middleware BEFORE the idempotency-wrapped handler runs, so
  // a caller who fails RBAC (procurement.test.ts's "a member cannot create a
  // commitment" test) is rejected regardless of whether an Idempotency-Key
  // header is sent — nothing here changes that ordering. Cross-tenant
  // reference validation (a supplierId belonging to a different company)
  // behaves the same way: it also runs before withIdempotency claims a key,
  // proven directly by procurement.test.ts's own "rejects a supplierId
  // belonging to another company" test.
  it("an idempotency key does not bypass ownership validation — a cross-tenant supplierId is still rejected", async () => {
    const projectId = await createProject(tokenA);
    const supplierFromCompanyB = await createSupplier(tokenB);
    const res = await request(app)
      .post(`/api/projects/${projectId}/commitments`)
      .set("Authorization", `Bearer ${tokenA}`)
      .set("Idempotency-Key", "commitment-authz-1")
      .send(commitmentPayload(supplierFromCompanyB));
    expect(res.status).toBe(404);
  });
});

// 18-phase internal remediation, Phase 8 follow-up — lease/heartbeat/
// fencing-token crash recovery. A prior version of this fix reclaimed any
// claim whose createdAt was simply "old" (>30s) — which could not tell a
// crashed leader apart from a LIVE one that was merely slow, and a
// read-only review caught the real consequence: a retry could steal a
// live leader's claim and run the SAME handler a second time (a genuine
// financial mutation executed twice), while the original leader silently
// reported false success to its own caller too. These tests exercise the
// real lease + fencing-token mechanism (lib/idempotency.ts) end to end —
// including, critically, a REAL live leader with a REAL heartbeat racing
// a REAL reclaim attempt, not just a synthetically-inserted dead row with
// no process behind it.
describe("Idempotency: lease-based crash recovery (dead-leader reclaim + live-leader protection)", () => {
  // Test-scaled LEASE_DURATION_MS/HEARTBEAT_INTERVAL_MS (see idempotency.ts's
  // own constants) — mirrored here only so these tests can compute
  // duration multiples of them without importing internal constants.
  const LEASE_MS = 300;
  const HEARTBEAT_MS = 80;

  async function insertDeadClaim(key: string, ageMs = LEASE_MS + 500) {
    const [row] = await db
      .insert(idempotencyKeys)
      .values({
        companyId: companyIdA,
        operation: "expense.create",
        key,
        requestFingerprint: "irrelevant-fingerprint",
        status: "pending",
        ownerToken: "dead-owner-token",
        leaseExpiresAt: new Date(Date.now() - ageMs),
      })
      .returning();
    return row;
  }

  it("DEAD LEADER: a claim whose lease has actually expired is reclaimed (atomic steal — new ownerToken), not stuck forever", async () => {
    const key = "lease-dead-1";
    const original = await insertDeadClaim(key);

    const outcome = await withIdempotency(companyIdA, "expense.create", key, { ok: true }, async () => ({
      status: 201,
      body: { recovered: true },
    }));

    expect(outcome.replayed).toBe(false);
    expect(outcome.status).toBe(201);
    expect(outcome.body).toEqual({ recovered: true });

    const row = await db.query.idempotencyKeys.findFirst({ where: eq(idempotencyKeys.id, original.id) });
    expect(row!.status).toBe("completed");
    expect(row!.ownerToken).not.toBe("dead-owner-token"); // proves an actual steal happened, not an in-place edit
  });

  it("LIVE LEADER (synthetic boundary check): a claim whose lease has NOT yet expired is never stolen, even though it looks old by any timestamp other than leaseExpiresAt", async () => {
    const key = "lease-live-boundary-1";
    // leaseExpiresAt is set comfortably beyond the follower's ENTIRE
    // poll/claim budget (CLAIM_ATTEMPTS * POLL_ATTEMPTS * POLL_INTERVAL_MS
    // ≈ 3s in idempotency.ts) — not just "a bit in the future" — so the
    // lease genuinely never expires for the full duration of this test,
    // isolating exactly what's being proven: leaseExpiresAt, not
    // createdAt, is what reclaim consults.
    const [row] = await db
      .insert(idempotencyKeys)
      .values({
        companyId: companyIdA,
        operation: "expense.create",
        key,
        requestFingerprint: "irrelevant-fingerprint",
        status: "pending",
        ownerToken: "live-owner-token",
        leaseExpiresAt: new Date(Date.now() + 8_000),
        createdAt: new Date(Date.now() - 60_000), // old by createdAt — must NOT matter anymore
      })
      .returning();

    await expect(
      withIdempotency(companyIdA, "expense.create", key, { ok: true }, async () => ({
        status: 201,
        body: { shouldNeverRun: true },
      })),
    ).rejects.toThrow("idempotency key contention could not be resolved");

    const after = await db.query.idempotencyKeys.findFirst({ where: eq(idempotencyKeys.id, row.id) });
    expect(after!.ownerToken).toBe("live-owner-token"); // untouched — never stolen
    expect(after!.status).toBe("pending");
  });

  it("LIVE LEADER (real concurrency): a genuinely live, heartbeat-renewing leader is never stolen from by a concurrent retry — handler runs exactly once, both requests get the correct result", async () => {
    const key = "lease-live-real-1";
    let leaderHandlerRuns = 0;
    let followerHandlerRuns = 0;

    // Leader's handler outlives at least one full lease period + a
    // heartbeat tick (LEASE_MS=300, HEARTBEAT_MS=80) — long enough that if
    // the OLD flat-timestamp/no-heartbeat design were still in place, a
    // concurrent retry landing after LEASE_MS would have stolen this claim
    // and run its own handler too. It must not.
    const leaderPromise = withIdempotency(companyIdA, "expense.create", key, { ok: true }, async () => {
      leaderHandlerRuns++;
      await new Promise((resolve) => setTimeout(resolve, LEASE_MS + HEARTBEAT_MS * 2));
      return { status: 201, body: { leader: true } };
    });

    // Give the leader a moment to actually claim before the follower starts.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const followerPromise = withIdempotency(companyIdA, "expense.create", key, { ok: true }, async () => {
      followerHandlerRuns++;
      return { status: 201, body: { follower: true } };
    });

    const [leaderOutcome, followerOutcome] = await Promise.all([leaderPromise, followerPromise]);

    expect(leaderHandlerRuns).toBe(1);
    expect(followerHandlerRuns).toBe(0); // the follower's handler must NEVER execute — no duplicate financial mutation
    expect(leaderOutcome.replayed).toBe(false);
    expect(leaderOutcome.body).toEqual({ leader: true });
    // Correct current semantics: the follower waited out the leader and
    // replayed its real result, rather than being told a different or
    // fabricated outcome.
    expect(followerOutcome.replayed).toBe(true);
    expect(followerOutcome.body).toEqual({ leader: true });

    const rows = await db.query.idempotencyKeys.findMany({
      where: and(eq(idempotencyKeys.companyId, companyIdA), eq(idempotencyKeys.key, key)),
    });
    expect(rows).toHaveLength(1); // exactly one claim row ever existed for this key — no duplicate row either
  });

  it("FENCING TOKEN: if a claim's ownership changes out from under a leader while its handler is still running, the leader detects lost ownership and never reports false success", async () => {
    const key = "lease-fencing-1";

    await expect(
      withIdempotency(companyIdA, "expense.create", key, { ok: true }, async () => {
        // Simulates the residual pathological case (see idempotency.ts's
        // own file comment): something else has taken over this claim's
        // ownership while this handler was still executing. The handler
        // itself still completes normally and "succeeds" from its own
        // point of view — the fencing-token check is what must catch this,
        // not the handler.
        await db
          .update(idempotencyKeys)
          .set({ ownerToken: "hijacker-token", leaseExpiresAt: new Date(Date.now() + LEASE_MS) })
          .where(and(eq(idempotencyKeys.companyId, companyIdA), eq(idempotencyKeys.key, key)));
        return { status: 201, body: { shouldNotBeReportedAsSuccess: true } };
      }),
    ).rejects.toThrow(IdempotencyLeaseLostError);

    // The row must reflect the hijacker's ownership, untouched by the
    // original leader's cleanup-on-error delete (which is itself
    // ownerToken-scoped, so it correctly can't clobber a new owner).
    const row = await db.query.idempotencyKeys.findFirst({
      where: and(eq(idempotencyKeys.companyId, companyIdA), eq(idempotencyKeys.key, key)),
    });
    expect(row).toBeDefined();
    expect(row!.ownerToken).toBe("hijacker-token");
    expect(row!.status).toBe("pending"); // never marked "completed" by the leader that lost ownership
  });

  it("CONCURRENT RETRIES: several concurrent callers racing to reclaim the same dead claim — exactly one wins, handler runs exactly once, everyone gets the same result", async () => {
    const key = "lease-concurrent-reclaim-1";
    await insertDeadClaim(key);
    let handlerRuns = 0;

    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () =>
        withIdempotency(companyIdA, "expense.create", key, { ok: true }, async () => {
          handlerRuns++;
          return { status: 201, body: { winner: true } };
        }),
      ),
    );

    expect(handlerRuns).toBe(1);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe(201);
      expect(outcome.body).toEqual({ winner: true });
    }
    expect(outcomes.filter((o) => !o.replayed)).toHaveLength(1);
    expect(outcomes.filter((o) => o.replayed)).toHaveLength(4);

    const rows = await db.query.idempotencyKeys.findMany({
      where: and(eq(idempotencyKeys.companyId, companyIdA), eq(idempotencyKeys.key, key)),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("completed");
  });

  it("RESPONSE REPLAY: a call made after a reclaimed claim has completed simply replays it — no second execution", async () => {
    const key = "lease-replay-after-reclaim-1";
    await insertDeadClaim(key);

    let runs = 0;
    const first = await withIdempotency(companyIdA, "expense.create", key, { ok: true }, async () => {
      runs++;
      return { status: 201, body: { once: true } };
    });
    const second = await withIdempotency(companyIdA, "expense.create", key, { ok: true }, async () => {
      runs++;
      return { status: 201, body: { shouldNotRun: true } };
    });

    expect(runs).toBe(1);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.body).toEqual({ once: true });
  });

  it("PER-TENANT SCOPING: reclaiming a dead claim under one company never touches a same-key dead claim under a different company", async () => {
    const bRes = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${tokenB}`);
    const companyIdB = bRes.body.company.id as string;
    const key = "lease-tenant-scope-1";
    await insertDeadClaim(key);
    const [rowB] = await db
      .insert(idempotencyKeys)
      .values({
        companyId: companyIdB,
        operation: "expense.create",
        key,
        requestFingerprint: "company-b-fingerprint",
        status: "pending",
        ownerToken: "company-b-dead-owner",
        leaseExpiresAt: new Date(Date.now() - (LEASE_MS + 500)),
      })
      .returning();

    await withIdempotency(companyIdA, "expense.create", key, { ok: true }, async () => ({
      status: 201,
      body: { recovered: true },
    }));

    const stillThereForB = await db.query.idempotencyKeys.findFirst({ where: eq(idempotencyKeys.id, rowB.id) });
    expect(stillThereForB).toBeDefined();
    expect(stillThereForB!.status).toBe("pending");
    expect(stillThereForB!.ownerToken).toBe("company-b-dead-owner"); // untouched
  });
});
