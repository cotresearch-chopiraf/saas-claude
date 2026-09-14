import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { auditEvents } from "../src/db/schema.js";

// Slice AA Scope E — opt-in Idempotency-Key support for invoice/quote
// creation. Five-scenario matrix per the slice's own requirement: first
// request, exact retry, concurrent retry, conflicting payload, cross-tenant
// isolation.

vi.mock("../src/lib/mailer.js", () => ({ sendMail: vi.fn() }));

const app = buildApp();

let tokenA: string;
let tokenB: string;

beforeAll(async () => {
  await resetDb();
  const a = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Idem Co A", name: "Owner A", email: "idem-owner-a@test.com", password: "password123" });
  tokenA = a.body.token;

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
