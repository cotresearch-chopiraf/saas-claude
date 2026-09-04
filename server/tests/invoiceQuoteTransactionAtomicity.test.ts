import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";

// MIDAD pre-launch closure — invoices.ts POST / and quotes.ts POST / were the
// only two financial-creation endpoints in the codebase that did not wrap
// their parent-row + line-items writes in a single db.transaction (every
// other domain — contracts, BOQ, commitments, measurements, IPCs,
// subcontractor IPCs, budget items/expenses — already did). This file
// proves: (1) normal creation is unaffected, (2) a genuine DB-level failure
// mid-creation now rolls back the parent row instead of leaving an orphan.
//
// Kept in its own file rather than added to invoicing.test.ts/quotes.test.ts:
// those files already sit near the shared authRateLimit budget (10
// requests/15min/IP, shared across every /api/auth/* and /api/platform/auth/*
// route including /auth/me) from their own existing register calls. This
// file uses beforeAll (register twice, once) instead of beforeEach +
// per-test register, staying well under budget.

const app = buildApp();

let ownerToken: string;
let otherToken: string;

beforeAll(async () => {
  await resetDb();

  const ownerRes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Txn Atomicity Co", name: "Owner", email: "txn-atomicity-owner@test.com", password: "password123" });
  expect(ownerRes.status).toBe(201);
  ownerToken = ownerRes.body.token;

  const otherRes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Txn Atomicity Other Co", name: "Owner2", email: "txn-atomicity-other@test.com", password: "password123" });
  expect(otherRes.status).toBe(201);
  otherToken = otherRes.body.token;
});

describe("invoice creation is transactional", () => {
  it("still succeeds normally with a single item", async () => {
    const res = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ clientName: "Client", items: [{ description: "Work", amount: 500 }] });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.invoiceNumber).toBeTruthy();
  });

  it("creates correctly with multiple line items, all persisted", async () => {
    const res = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        clientName: "Client",
        items: [
          { description: "Labor", amount: 100 },
          { description: "Materials", amount: 250 },
          { description: "Permits", amount: 50 },
        ],
      });
    expect(res.status).toBe(201);

    const reread = await request(app).get(`/api/invoices/${res.body.id}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(reread.body.items).toHaveLength(3);
    expect(reread.body.items.map((i: { description: string }) => i.description).sort()).toEqual(
      ["Labor", "Materials", "Permits"].sort(),
    );
  });

  it("still records an invoice.created audit event", async () => {
    const res = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ clientName: "Client", items: [{ description: "Work", amount: 500 }] });

    const activity = await request(app).get("/api/audit-events").set("Authorization", `Bearer ${ownerToken}`);
    const created = activity.body.events.find(
      (e: { action: string; entityId: string }) => e.action === "invoice.created" && e.entityId === res.body.id,
    );
    expect(created).toBeTruthy();
  });

  it("response shape is unchanged: id, companyId, invoiceNumber, status, clientName all present", async () => {
    const res = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ clientName: "Client", items: [{ description: "Work", amount: 500 }] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ clientName: "Client", status: "draft", language: "ar" });
    expect(res.body.id).toBeTruthy();
    expect(res.body.companyId).toBeTruthy();
    expect(res.body.invoiceNumber).toBeTruthy();
  });

  it("tenant isolation is unchanged: another company cannot read the created invoice", async () => {
    const res = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ clientName: "Client", items: [{ description: "Work", amount: 500 }] });

    const cross = await request(app).get(`/api/invoices/${res.body.id}`).set("Authorization", `Bearer ${otherToken}`);
    expect(cross.status).toBe(404);
  });

  // Forces a genuine DB-level failure inside the transaction (not a mock):
  // amount overflows invoice_items.amount's numeric(12,2) column, a failure
  // zod's nonnegative() check cannot catch, so it only surfaces when
  // Postgres rejects the line-items insert. Before the transaction fix this
  // left an orphaned, item-less invoice (no delete route exists for
  // invoices) — this proves the parent insert now rolls back with it.
  it("rolls back the parent invoice when a line-item insert fails, leaving no orphan", async () => {
    const before = await request(app).get("/api/invoices").set("Authorization", `Bearer ${ownerToken}`);
    const countBefore = before.body.invoices.length;

    const res = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        clientName: "Client",
        items: [
          { description: "Valid item", amount: 100 },
          { description: "Overflowing item", amount: 999999999999999 },
        ],
      });

    expect(res.status).toBeGreaterThanOrEqual(400);

    const after = await request(app).get("/api/invoices").set("Authorization", `Bearer ${ownerToken}`);
    expect(after.body.invoices.length).toBe(countBefore);
  });
});

describe("quote creation is transactional", () => {
  it("still succeeds normally with a single item", async () => {
    const res = await request(app)
      .post("/api/quotes")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ clientName: "Client", projectName: "Job", items: [{ description: "Work", amount: 500 }] });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.quoteNumber).toBeTruthy();
  });

  it("creates correctly with multiple line items, all persisted", async () => {
    const res = await request(app)
      .post("/api/quotes")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        clientName: "Client",
        projectName: "Job",
        items: [
          { description: "Labor", amount: 100 },
          { description: "Materials", amount: 250 },
          { description: "Permits", amount: 50 },
        ],
      });
    expect(res.status).toBe(201);

    const reread = await request(app).get(`/api/quotes/${res.body.id}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(reread.body.items).toHaveLength(3);
    expect(reread.body.items.map((i: { description: string }) => i.description).sort()).toEqual(
      ["Labor", "Materials", "Permits"].sort(),
    );
  });

  it("response shape is unchanged: id, companyId, quoteNumber, status, clientName all present", async () => {
    const res = await request(app)
      .post("/api/quotes")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ clientName: "Client", projectName: "Job", items: [{ description: "Work", amount: 500 }] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ clientName: "Client", status: "draft", language: "ar" });
    expect(res.body.id).toBeTruthy();
    expect(res.body.companyId).toBeTruthy();
    expect(res.body.quoteNumber).toBeTruthy();
  });

  it("tenant isolation is unchanged: another company cannot read the created quote", async () => {
    const res = await request(app)
      .post("/api/quotes")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ clientName: "Client", projectName: "Job", items: [{ description: "Work", amount: 500 }] });

    const cross = await request(app).get(`/api/quotes/${res.body.id}`).set("Authorization", `Bearer ${otherToken}`);
    expect(cross.status).toBe(404);
  });

  // Same DB-level failure trick as invoices: amount overflows
  // quote_items.amount's numeric(12,2) column, a failure zod's
  // nonnegative() check cannot catch, so it only surfaces at the Postgres
  // insert itself. This proves the parent insert now rolls back with the
  // failed line-items insert instead of leaving an incomplete quote.
  it("rolls back the parent quote when a line-item insert fails, leaving no orphan", async () => {
    const before = await request(app).get("/api/quotes").set("Authorization", `Bearer ${ownerToken}`);
    const countBefore = before.body.quotes.length;

    const res = await request(app)
      .post("/api/quotes")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        clientName: "Client",
        projectName: "Job",
        items: [
          { description: "Valid item", amount: 100 },
          { description: "Overflowing item", amount: 999999999999999 },
        ],
      });

    expect(res.status).toBeGreaterThanOrEqual(400);

    const after = await request(app).get("/api/quotes").set("Authorization", `Bearer ${ownerToken}`);
    expect(after.body.quotes.length).toBe(countBefore);
  });
});
