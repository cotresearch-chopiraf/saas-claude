import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { auditEvents } from "../src/db/schema.js";

// Slice AA Scope D — public quote accept/reject and invoice mark-paid now use
// a conditional UPDATE (WHERE status = 'sent') instead of a plain eq(id)
// write, closing the same read-then-write race already proven and fixed for
// change orders in concurrency.test.ts. These tests reproduce the race
// against the actual HTTP routes and assert it is now impossible to observe
// more than one winning transition.

vi.mock("../src/lib/mailer.js", () => ({ sendMail: vi.fn() }));
import { sendMail } from "../src/lib/mailer.js";

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

// Red-Team Remediation Wave 1E (W1E-003) — invoices.ts's and quotes.ts's
// /send routes previously checked status='draft' via a plain read, then
// wrote unconditionally — two concurrent sends of the same draft document
// could both pass the read and both "succeed". Same TOCTOU shape already
// fixed here for mark-paid/accept/reject; /send was the one transition
// left unhardened. These tests reproduce the race against the real HTTP
// routes and prove the conditional UPDATE now allows exactly one winner.
describe("concurrency: invoice send cannot double-transition (Wave 1E fix)", () => {
  beforeAll(async () => {
    await resetDb();
    const res = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "Invoice Send Race Co", name: "Owner", email: "invoice-send-race-owner@test.com", password: "password123" });
    ownerToken = res.body.token;
  });

  it(`${TRIALS}x: N simultaneous /send requests on the SAME draft invoice — exactly one succeeds`, async () => {
    for (let trial = 0; trial < TRIALS; trial++) {
      const createRes = await request(app)
        .post("/api/invoices")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ clientName: "Race Client", items: [{ description: "Item", amount: 1000 }] });
      const invoiceId = createRes.body.id as string;

      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          request(app).patch(`/api/invoices/${invoiceId}/send`).set("Authorization", `Bearer ${ownerToken}`),
        ),
      );
      const successes = results.filter((r) => r.status === 200);
      const conflicts = results.filter((r) => r.status === 409);
      expect(successes.length).toBe(1);
      expect(conflicts.length).toBe(7);

      // No duplicate side effect: exactly one invoice.sent audit event
      // exists for this invoice, not one per winning-looking request.
      const sentEvents = await db.query.auditEvents.findMany({
        where: eq(auditEvents.entityId, invoiceId),
      });
      expect(sentEvents.filter((e) => e.action === "invoice.sent")).toHaveLength(1);

      const final = await request(app).get(`/api/invoices/${invoiceId}`).set("Authorization", `Bearer ${ownerToken}`);
      expect(final.body.status).toBe("sent");
    }
  });
});

describe("concurrency: quote send cannot double-transition (Wave 1E fix)", () => {
  beforeAll(async () => {
    await resetDb();
    const res = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "Quote Send Race Co", name: "Owner", email: "quote-send-race-owner@test.com", password: "password123" });
    ownerToken = res.body.token;
  });

  it(`${TRIALS}x: N simultaneous /send requests on the SAME draft quote — exactly one succeeds`, async () => {
    for (let trial = 0; trial < TRIALS; trial++) {
      const createRes = await request(app)
        .post("/api/quotes")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ clientName: "Race Client", projectName: "Race Project", items: [{ description: "Item", amount: 1000 }] });
      const quoteId = createRes.body.id as string;

      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          request(app).patch(`/api/quotes/${quoteId}/send`).set("Authorization", `Bearer ${ownerToken}`),
        ),
      );
      const successes = results.filter((r) => r.status === 200);
      const conflicts = results.filter((r) => r.status === 409);
      expect(successes.length).toBe(1);
      expect(conflicts.length).toBe(7);

      const sentEvents = await db.query.auditEvents.findMany({
        where: eq(auditEvents.entityId, quoteId),
      });
      expect(sentEvents.filter((e) => e.action === "quote.sent")).toHaveLength(1);

      const final = await request(app).get(`/api/quotes/${quoteId}`).set("Authorization", `Bearer ${ownerToken}`);
      expect(final.body.status).toBe("sent");
    }
  });
});

// Red-Team Remediation Wave 1E (W1E-004) — quotes.ts's DELETE /:id was
// previously (a) ungated by any permission check, and (b) racy: a stale
// "still draft" read followed by an unconditional delete could remove a
// quote a concurrent /send had just transitioned to "sent". Now gated by
// quote.send (the only quote-specific permission that exists) and made
// concurrency-safe via a FOR UPDATE-locked conditional delete, mirroring
// changeOrders.ts's own delete route.
describe("quote delete: authorization + concurrency (Wave 1E fix)", () => {
  let quoteOwnerToken: string;
  let quoteMemberToken: string;
  let otherCompanyToken: string;

  beforeAll(async () => {
    await resetDb();
    const ownerRes = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "Quote Delete Co", name: "Owner", email: "quote-delete-owner@test.com", password: "password123" });
    quoteOwnerToken = ownerRes.body.token;

    const inviteRes = await request(app)
      .post("/api/company/invites")
      .set("Authorization", `Bearer ${quoteOwnerToken}`)
      .send({ email: "quote-delete-member@test.com", role: "member" });
    expect(inviteRes.status).toBe(201);
    const mailCall = (sendMail as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    const inviteToken = (mailCall[2] as string).match(/token=([a-f0-9]{40,80})/)![1];
    const acceptRes = await request(app)
      .post("/api/auth/accept-invite")
      .send({ token: inviteToken, name: "Member", password: "memberpass123" });
    expect(acceptRes.status).toBe(201);
    quoteMemberToken = acceptRes.body.token;

    const otherRes = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "Other Co", name: "Owner B", email: "quote-delete-other@test.com", password: "password123" });
    otherCompanyToken = otherRes.body.token;
  });

  async function createDraftQuote(token: string): Promise<string> {
    const res = await request(app)
      .post("/api/quotes")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientName: "Client", projectName: "Project", items: [{ description: "Item", amount: 500 }] });
    return res.body.id as string;
  }

  it("1. a member without quote.send permission cannot delete a quote", async () => {
    const quoteId = await createDraftQuote(quoteOwnerToken);
    const res = await request(app).delete(`/api/quotes/${quoteId}`).set("Authorization", `Bearer ${quoteMemberToken}`);
    expect(res.status).toBe(403);
  });

  it("2. an authorized owner can delete a deletable (draft) quote", async () => {
    const quoteId = await createDraftQuote(quoteOwnerToken);
    const res = await request(app).delete(`/api/quotes/${quoteId}`).set("Authorization", `Bearer ${quoteOwnerToken}`);
    expect(res.status).toBe(204);

    const reread = await request(app).get(`/api/quotes/${quoteId}`).set("Authorization", `Bearer ${quoteOwnerToken}`);
    expect(reread.status).toBe(404);
  });

  it("3. concurrent delete vs send cannot leave an invalid final state", async () => {
    for (let trial = 0; trial < TRIALS; trial++) {
      const quoteId = await createDraftQuote(quoteOwnerToken);

      const [deleteRes, sendRes] = await Promise.all([
        request(app).delete(`/api/quotes/${quoteId}`).set("Authorization", `Bearer ${quoteOwnerToken}`),
        request(app).patch(`/api/quotes/${quoteId}/send`).set("Authorization", `Bearer ${quoteOwnerToken}`),
      ]);

      // Exactly one of the two competing transitions wins — either the
      // delete or the send can legitimately win this race; what must never
      // happen is both succeeding or both failing.
      expect([deleteRes.status, sendRes.status].filter((s) => s === 409)).toHaveLength(1);
      expect(deleteRes.status === 204 || sendRes.status === 200).toBe(true);
      expect(deleteRes.status === 204 && sendRes.status === 200).toBe(false);

      // The final state matches whichever one actually won — never both
      // "deleted" and "sent", never neither.
      const reread = await request(app).get(`/api/quotes/${quoteId}`).set("Authorization", `Bearer ${quoteOwnerToken}`);
      if (deleteRes.status === 204) {
        expect(reread.status).toBe(404);
      } else {
        expect(reread.status).toBe(200);
        expect(reread.body.status).toBe("sent");
      }
    }
  });

  it("4. tenant isolation: company B cannot delete company A's quote", async () => {
    const quoteId = await createDraftQuote(quoteOwnerToken);
    const res = await request(app).delete(`/api/quotes/${quoteId}`).set("Authorization", `Bearer ${otherCompanyToken}`);
    expect(res.status).toBe(404);

    const reread = await request(app).get(`/api/quotes/${quoteId}`).set("Authorization", `Bearer ${quoteOwnerToken}`);
    expect(reread.status).toBe(200);
  });

  it("5. a successful delete is recorded as a quote.deleted audit event", async () => {
    const quoteId = await createDraftQuote(quoteOwnerToken);
    const res = await request(app).delete(`/api/quotes/${quoteId}`).set("Authorization", `Bearer ${quoteOwnerToken}`);
    expect(res.status).toBe(204);

    const events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, quoteId) });
    const deleteEvents = events.filter((e) => e.action === "quote.deleted");
    expect(deleteEvents).toHaveLength(1);
    expect(deleteEvents[0].beforeValue).toMatchObject({ id: quoteId, status: "draft" });
  });
});
