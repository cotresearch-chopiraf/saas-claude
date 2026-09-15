import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";

// Priority 3 (read-only-review follow-up) — routes/quotes.ts's public
// accept/reject endpoints now wrap their conditional UPDATE (status
// 'sent' -> 'accepted'/'rejected') together with recordAuditEvent in one
// db.transaction(), matching the atomicity discipline already proven for
// ZATCA in zatcaSuccessPathAtomicity.test.ts. This file proves the same
// guarantee here, on the two PUBLIC, unauthenticated, customer-facing
// endpoints the user explicitly called out: a real client clicking
// "accept" on an emailed quote link must never see a 500 while the
// status change silently commits anyway (which would desync the UI from
// the database and make a retry behave unpredictably against the
// conditional-UPDATE guard).
//
// Own file — mocks lib/audit.js the same way zatcaSuccessPathAtomicity's
// mock does (vi.importActual passthrough, selectively failing only the
// two actions this route itself writes), so no other suite's audit calls
// are affected.
const DECISION_AUDIT_ACTIONS = new Set(["quote.accepted", "quote.rejected"]);
let auditFailuresRemaining = 0;
vi.mock("../src/lib/audit.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/audit.js")>("../src/lib/audit.js");
  return {
    ...actual,
    recordAuditEvent: vi.fn(async (dbOrTx: unknown, input: { action: string }) => {
      if (DECISION_AUDIT_ACTIONS.has(input.action) && auditFailuresRemaining > 0) {
        auditFailuresRemaining--;
        throw new Error("simulated audit insert failure");
      }
      return actual.recordAuditEvent(dbOrTx as never, input as never);
    }),
  };
});

const { buildApp } = await import("../src/app.js");
const { resetDb } = await import("./setup.js");
const { db } = await import("../src/db/client.js");
const { quotes, auditEvents } = await import("../src/db/schema.js");

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

async function setupCompany(name = "Atomicity Reno Co") {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ companyName: name, name: "Owner", email: uniqueEmail("quote-atomicity-owner"), password: "password123" });
  return res.body.token as string;
}

async function createSentQuote(token: string) {
  const quote = await request(app)
    .post("/api/quotes")
    .set("Authorization", `Bearer ${token}`)
    .send({ clientName: "Client", projectName: "Bath remodel", items: [{ description: "Tile", amount: 100 }] });
  await request(app).patch(`/api/quotes/${quote.body.id}/send`).set("Authorization", `Bearer ${token}`);
  return quote.body as { id: string; publicToken: string };
}

beforeEach(() => {
  auditFailuresRemaining = 0;
});

describe("POST /api/public/quotes/:token/accept — atomicity (status update + audit event)", () => {
  beforeEach(resetDb);

  it("normal success: status becomes accepted and its audit event exists together", async () => {
    const token = await setupCompany();
    const quote = await createSentQuote(token);

    const res = await request(app).post(`/api/public/quotes/${quote.publicToken}/accept`).send({ acceptedByName: "Real Client" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("accepted");

    const row = await db.query.quotes.findFirst({ where: eq(quotes.id, quote.id) });
    expect(row!.status).toBe("accepted");

    const events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, quote.id) });
    expect(events.some((e) => e.action === "quote.accepted")).toBe(true);
  });

  it("CRITICAL: audit insert fails — the quote status is NEVER left as 'accepted' without its audit trail, and a client retry is not blocked by a phantom acceptance", async () => {
    const token = await setupCompany();
    const quote = await createSentQuote(token);
    auditFailuresRemaining = 1;

    const failed = await request(app).post(`/api/public/quotes/${quote.publicToken}/accept`).send({ acceptedByName: "Real Client" });
    // The transaction rolled back — this is a genuine 500, not a
    // misleading 409/200 hiding a committed side effect.
    expect(failed.status).toBe(500);

    const row = await db.query.quotes.findFirst({ where: eq(quotes.id, quote.id) });
    // The core guarantee: never "accepted" when the audit write that was
    // supposed to accompany it actually failed.
    expect(row!.status).toBe("sent");

    const events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, quote.id) });
    expect(events.some((e) => e.action === "quote.accepted")).toBe(false);

    // Because the status genuinely rolled back to 'sent', the existing
    // conditional-UPDATE guard (status = 'sent') lets a real retry
    // succeed cleanly once the transient condition clears — the public
    // endpoint's documented retry semantics are preserved, not violated.
    auditFailuresRemaining = 0;
    const retried = await request(app).post(`/api/public/quotes/${quote.publicToken}/accept`).send({ acceptedByName: "Real Client" });
    expect(retried.status).toBe(200);
    expect(retried.body.status).toBe("accepted");
  });
});

describe("POST /api/public/quotes/:token/reject — atomicity (status update + audit event)", () => {
  beforeEach(resetDb);

  it("normal success: status becomes rejected and its audit event exists together", async () => {
    const token = await setupCompany();
    const quote = await createSentQuote(token);

    const res = await request(app).post(`/api/public/quotes/${quote.publicToken}/reject`).send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("rejected");

    const events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, quote.id) });
    expect(events.some((e) => e.action === "quote.rejected")).toBe(true);
  });

  it("CRITICAL: audit insert fails — the quote status is NEVER left as 'rejected' without its audit trail", async () => {
    const token = await setupCompany();
    const quote = await createSentQuote(token);
    auditFailuresRemaining = 1;

    const failed = await request(app).post(`/api/public/quotes/${quote.publicToken}/reject`).send({});
    expect(failed.status).toBe(500);

    const row = await db.query.quotes.findFirst({ where: eq(quotes.id, quote.id) });
    expect(row!.status).toBe("sent");

    const events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, quote.id) });
    expect(events.some((e) => e.action === "quote.rejected")).toBe(false);
  });
});
