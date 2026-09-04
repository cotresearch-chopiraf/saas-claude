import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";

// Slice AA Scope D — public quote accept/reject and invoice mark-paid now use
// a conditional UPDATE (WHERE status = 'sent') instead of a plain eq(id)
// write, closing the same read-then-write race already proven and fixed for
// change orders in concurrency.test.ts. These tests reproduce the race
// against the actual HTTP routes and assert it is now impossible to observe
// more than one winning transition.

vi.mock("../src/lib/mailer.js", () => ({ sendMail: vi.fn() }));

const app = buildApp();

let ownerToken: string;

const TRIALS = 5;

async function createSentQuote(token: string): Promise<{ id: string; publicToken: string }> {
  const createRes = await request(app)
    .post("/api/quotes")
    .set("Authorization", `Bearer ${token}`)
    .send({
      clientName: "Race Client",
      projectName: "Race Project",
      items: [{ description: "Item", amount: 1000 }],
    });
  await request(app).patch(`/api/quotes/${createRes.body.id}/send`).set("Authorization", `Bearer ${token}`);
  return { id: createRes.body.id, publicToken: createRes.body.publicToken };
}

async function createSentInvoice(token: string): Promise<string> {
  const createRes = await request(app)
    .post("/api/invoices")
    .set("Authorization", `Bearer ${token}`)
    .send({ clientName: "Race Client", items: [{ description: "Item", amount: 1000 }] });
  await request(app).patch(`/api/invoices/${createRes.body.id}/send`).set("Authorization", `Bearer ${token}`);
  return createRes.body.id as string;
}

describe("concurrency: public quote accept/reject cannot double-transition", () => {
  beforeAll(async () => {
    await resetDb();
    const res = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "Quote Race Co", name: "Owner", email: "quote-race-owner@test.com", password: "password123" });
    ownerToken = res.body.token;
  });

  it(`${TRIALS}x: N simultaneous accepts of the SAME sent quote — exactly one succeeds`, async () => {
    for (let trial = 0; trial < TRIALS; trial++) {
      const quote = await createSentQuote(ownerToken);

      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          request(app).post(`/api/public/quotes/${quote.publicToken}/accept`).send({ acceptedByName: "Client" }),
        ),
      );
      const successes = results.filter((r) => r.status === 200);
      const conflicts = results.filter((r) => r.status === 409);
      expect(successes.length).toBe(1);
      expect(conflicts.length).toBe(7);

      const final = await request(app).get(`/api/public/quotes/${quote.publicToken}`);
      expect(final.body.status).toBe("accepted");
    }
  });

  it(`${TRIALS}x: N simultaneous rejects of the SAME sent quote — exactly one succeeds`, async () => {
    for (let trial = 0; trial < TRIALS; trial++) {
      const quote = await createSentQuote(ownerToken);

      const results = await Promise.all(
        Array.from({ length: 8 }, () => request(app).post(`/api/public/quotes/${quote.publicToken}/reject`).send({})),
      );
      const successes = results.filter((r) => r.status === 200);
      const conflicts = results.filter((r) => r.status === 409);
      expect(successes.length).toBe(1);
      expect(conflicts.length).toBe(7);

      const final = await request(app).get(`/api/public/quotes/${quote.publicToken}`);
      expect(final.body.status).toBe("rejected");
    }
  });

  it(`${TRIALS}x: accept-vs-reject fired simultaneously on the same sent quote — exactly one wins`, async () => {
    for (let trial = 0; trial < TRIALS; trial++) {
      const quote = await createSentQuote(ownerToken);

      const [accept, reject] = await Promise.all([
        request(app).post(`/api/public/quotes/${quote.publicToken}/accept`).send({ acceptedByName: "Client" }),
        request(app).post(`/api/public/quotes/${quote.publicToken}/reject`).send({}),
      ]);
      const outcomes = [accept.status, reject.status].sort();
      expect(outcomes).toEqual([200, 409]);

      const final = await request(app).get(`/api/public/quotes/${quote.publicToken}`);
      expect(["accepted", "rejected"]).toContain(final.body.status);
      expect(final.body.status).toBe(accept.status === 200 ? "accepted" : "rejected");
    }
  });
});

describe("concurrency: invoice mark-paid cannot double-transition", () => {
  beforeAll(async () => {
    await resetDb();
    const res = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "Invoice Race Co", name: "Owner", email: "invoice-race-owner@test.com", password: "password123" });
    ownerToken = res.body.token;
  });

  it(`${TRIALS}x: N simultaneous mark-paid requests on the SAME sent invoice — exactly one succeeds`, async () => {
    for (let trial = 0; trial < TRIALS; trial++) {
      const invoiceId = await createSentInvoice(ownerToken);

      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          request(app).patch(`/api/invoices/${invoiceId}/mark-paid`).set("Authorization", `Bearer ${ownerToken}`),
        ),
      );
      const successes = results.filter((r) => r.status === 200);
      const conflicts = results.filter((r) => r.status === 409);
      expect(successes.length).toBe(1);
      expect(conflicts.length).toBe(7);

      const final = await request(app).get(`/api/invoices/${invoiceId}`).set("Authorization", `Bearer ${ownerToken}`);
      expect(final.body.status).toBe("paid");
    }
  });

  it("concurrent mark-paid on two DIFFERENT invoices do not interfere with each other", async () => {
    const invoiceX = await createSentInvoice(ownerToken);
    const invoiceY = await createSentInvoice(ownerToken);

    const [rx, ry] = await Promise.all([
      request(app).patch(`/api/invoices/${invoiceX}/mark-paid`).set("Authorization", `Bearer ${ownerToken}`),
      request(app).patch(`/api/invoices/${invoiceY}/mark-paid`).set("Authorization", `Bearer ${ownerToken}`),
    ]);
    expect(rx.status).toBe(200);
    expect(ry.status).toBe(200);
  });
});
