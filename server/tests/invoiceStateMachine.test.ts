import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

async function setupCompany() {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "State Co", name: "Owner", email: uniqueEmail("state"), password: "password123" });
  return res.body.token as string;
}

async function createInvoice(token: string) {
  const res = await request(app)
    .post("/api/invoices")
    .set("Authorization", `Bearer ${token}`)
    .send({ clientName: "State Client", items: [{ description: "x", amount: 100 }] });
  return res.body.id as string;
}

// Authoritative lifecycle: draft -> sent -> paid. No other transition is
// valid. Enforced entirely server-side (the API is the security boundary
// here, same as authorization) — these tests call the routes directly.
describe("invoice state machine: draft -> sent -> paid, no shortcuts", () => {
  beforeEach(resetDb);

  it("DRAFT -> PAID directly is DENIED", async () => {
    const token = await setupCompany();
    const id = await createInvoice(token);

    const res = await request(app).patch(`/api/invoices/${id}/mark-paid`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(409);

    const invoice = await request(app).get(`/api/invoices/${id}`).set("Authorization", `Bearer ${token}`);
    expect(invoice.body.status).toBe("draft");
  });

  it("DRAFT -> SENT is ALLOWED", async () => {
    const token = await setupCompany();
    const id = await createInvoice(token);

    const res = await request(app).patch(`/api/invoices/${id}/send`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("sent");
  });

  it("SENT -> PAID is ALLOWED", async () => {
    const token = await setupCompany();
    const id = await createInvoice(token);
    await request(app).patch(`/api/invoices/${id}/send`).set("Authorization", `Bearer ${token}`);

    const res = await request(app).patch(`/api/invoices/${id}/mark-paid`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("paid");
    expect(res.body.paidAt).toBeTruthy();
  });

  it("SENT -> SENT again is DENIED", async () => {
    const token = await setupCompany();
    const id = await createInvoice(token);
    await request(app).patch(`/api/invoices/${id}/send`).set("Authorization", `Bearer ${token}`);

    const res = await request(app).patch(`/api/invoices/${id}/send`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(409);
  });

  it("PAID -> PAID again is DENIED", async () => {
    const token = await setupCompany();
    const id = await createInvoice(token);
    await request(app).patch(`/api/invoices/${id}/send`).set("Authorization", `Bearer ${token}`);
    await request(app).patch(`/api/invoices/${id}/mark-paid`).set("Authorization", `Bearer ${token}`);

    const res = await request(app).patch(`/api/invoices/${id}/mark-paid`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(409);
  });

  it("PAID -> SENT (re-sending an already-paid invoice) is DENIED", async () => {
    const token = await setupCompany();
    const id = await createInvoice(token);
    await request(app).patch(`/api/invoices/${id}/send`).set("Authorization", `Bearer ${token}`);
    await request(app).patch(`/api/invoices/${id}/mark-paid`).set("Authorization", `Bearer ${token}`);

    const res = await request(app).patch(`/api/invoices/${id}/send`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(409);

    const invoice = await request(app).get(`/api/invoices/${id}`).set("Authorization", `Bearer ${token}`);
    expect(invoice.body.status).toBe("paid");
  });

  it("a public link never exposes a draft invoice, but does expose a sent one", async () => {
    const token = await setupCompany();
    const id = await createInvoice(token);
    const draft = await request(app).get(`/api/invoices/${id}`).set("Authorization", `Bearer ${token}`);

    const draftPublic = await request(app).get(`/api/public/invoices/${draft.body.publicToken}`);
    expect(draftPublic.status).toBe(404);

    await request(app).patch(`/api/invoices/${id}/send`).set("Authorization", `Bearer ${token}`);
    const sentPublic = await request(app).get(`/api/public/invoices/${draft.body.publicToken}`);
    expect(sentPublic.status).toBe(200);
  });
});
