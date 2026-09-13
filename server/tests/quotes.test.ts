import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

async function setupCompany(name = "Reno Co") {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ companyName: name, name: "Owner", email: uniqueEmail("quote-owner"), password: "password123" });
  return res.body.token as string;
}

async function createQuote(token: string) {
  return request(app)
    .post("/api/quotes")
    .set("Authorization", `Bearer ${token}`)
    .send({ clientName: "Client", projectName: "Bath remodel", items: [{ description: "Tile", amount: 100 }] });
}

describe("quote lifecycle", () => {
  beforeEach(resetDb);

  it("a draft quote is not visible on its public link", async () => {
    const token = await setupCompany();
    const quote = await request(app)
      .post("/api/quotes")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientName: "Client", projectName: "Bath remodel", items: [{ description: "Tile", amount: 100 }] });

    const publicView = await request(app).get(`/api/public/quotes/${quote.body.publicToken}`);
    expect(publicView.status).toBe(404);
  });

  it("sending a quote makes it publicly visible and acceptable, once", async () => {
    const token = await setupCompany();
    const quote = await request(app)
      .post("/api/quotes")
      .set("Authorization", `Bearer ${token}`)
      .send({
        clientName: "Client",
        projectName: "Bath remodel",
        items: [{ description: "Tile", amount: 100 }, { description: "Plumbing", amount: 200 }],
      });

    await request(app).patch(`/api/quotes/${quote.body.id}/send`).set("Authorization", `Bearer ${token}`);

    const publicView = await request(app).get(`/api/public/quotes/${quote.body.publicToken}`);
    expect(publicView.status).toBe(200);
    expect(publicView.body.total).toBe(300);

    const accept = await request(app)
      .post(`/api/public/quotes/${quote.body.publicToken}/accept`)
      .send({ acceptedByName: "Real Client" });
    expect(accept.status).toBe(200);
    expect(accept.body.status).toBe("accepted");

    const secondAccept = await request(app)
      .post(`/api/public/quotes/${quote.body.publicToken}/accept`)
      .send({ acceptedByName: "Real Client" });
    expect(secondAccept.status).toBe(409);
  });
});

// P0 hardening (MIDAD Final Pre-Launch audit, §4/§19) — quotes.ts already
// scopes every query by companyId (findOwnedQuote, the list route's own
// eq(quotes.companyId, ...)), matching the pattern every other tenant-owned
// domain uses, but this file previously had zero tests actually proving it.
// This block closes that gap with real, direct-ID-manipulation assertions.
describe("quotes: tenant isolation", () => {
  beforeEach(resetDb);

  it("a foreign company's list never includes this company's quotes", async () => {
    const tokenA = await setupCompany("Company A");
    const tokenB = await setupCompany("Company B");
    await createQuote(tokenA);

    const res = await request(app).get("/api/quotes").set("Authorization", `Bearer ${tokenB}`);
    expect(res.status).toBe(200);
    expect(res.body.quotes).toHaveLength(0);
  });

  it("a foreign company cannot GET this company's quote by id (direct ID manipulation)", async () => {
    const tokenA = await setupCompany("Company A");
    const tokenB = await setupCompany("Company B");
    const quote = await createQuote(tokenA);

    const res = await request(app).get(`/api/quotes/${quote.body.id}`).set("Authorization", `Bearer ${tokenB}`);
    expect(res.status).toBe(404);
  });

  it("a foreign company cannot send this company's quote", async () => {
    const tokenA = await setupCompany("Company A");
    const tokenB = await setupCompany("Company B");
    const quote = await createQuote(tokenA);

    const res = await request(app)
      .patch(`/api/quotes/${quote.body.id}/send`)
      .set("Authorization", `Bearer ${tokenB}`);
    expect(res.status).toBe(404);

    // Never actually sent — no public token should be publicly visible.
    const asOwner = await request(app).get(`/api/quotes/${quote.body.id}`).set("Authorization", `Bearer ${tokenA}`);
    expect(asOwner.body.status).toBe("draft");
  });

  it("a foreign company cannot delete this company's quote", async () => {
    const tokenA = await setupCompany("Company A");
    const tokenB = await setupCompany("Company B");
    const quote = await createQuote(tokenA);

    const res = await request(app).delete(`/api/quotes/${quote.body.id}`).set("Authorization", `Bearer ${tokenB}`);
    expect(res.status).toBe(404);

    const asOwner = await request(app).get(`/api/quotes/${quote.body.id}`).set("Authorization", `Bearer ${tokenA}`);
    expect(asOwner.status).toBe(200);
  });

  it("a foreign company cannot fetch this company's quote PDF", async () => {
    const tokenA = await setupCompany("Company A");
    const tokenB = await setupCompany("Company B");
    const quote = await createQuote(tokenA);

    const res = await request(app).get(`/api/quotes/${quote.body.id}/pdf`).set("Authorization", `Bearer ${tokenB}`);
    expect(res.status).toBe(404);
  });
});
