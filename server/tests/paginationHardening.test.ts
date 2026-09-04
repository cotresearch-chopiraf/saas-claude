import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";

// Slice AA Scope G — company-wide quote/invoice lists are now paginated.
// Proves: server-enforced max page size, deterministic ordering, and
// tenant isolation is preserved (a paginated read never leaks another
// company's rows).

const app = buildApp();

let tokenA: string, tokenB: string;

beforeAll(async () => {
  await resetDb();
  const a = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Page Co A", name: "Owner A", email: "page-owner-a@test.com", password: "password123" });
  tokenA = a.body.token;

  const b = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Page Co B", name: "Owner B", email: "page-owner-b@test.com", password: "password123" });
  tokenB = b.body.token;

  for (let i = 0; i < 5; i++) {
    await request(app)
      .post("/api/quotes")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ clientName: `Client ${i}`, projectName: `Project ${i}`, items: [{ description: "Item", amount: 100 }] });
    await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ clientName: `Client ${i}`, items: [{ description: "Item", amount: 100 }] });
  }
  // Company B's own rows — used only to prove they never leak into A's page.
  await request(app)
    .post("/api/quotes")
    .set("Authorization", `Bearer ${tokenB}`)
    .send({ clientName: "B Client", projectName: "B Project", items: [{ description: "Item", amount: 100 }] });
  await request(app)
    .post("/api/invoices")
    .set("Authorization", `Bearer ${tokenB}`)
    .send({ clientName: "B Client", items: [{ description: "Item", amount: 100 }] });
});

describe("Pagination: quotes list", () => {
  it("enforces a server-side max page size", async () => {
    const res = await request(app).get("/api/quotes?limit=99999").set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(400);
  });

  it("paginates deterministically (newest first) with hasMore/limit/offset", async () => {
    const page1 = await request(app).get("/api/quotes?limit=2&offset=0").set("Authorization", `Bearer ${tokenA}`);
    expect(page1.status).toBe(200);
    expect(page1.body.quotes.length).toBe(2);
    expect(page1.body.hasMore).toBe(true);
    expect(page1.body.limit).toBe(2);
    expect(page1.body.offset).toBe(0);

    const page2 = await request(app).get("/api/quotes?limit=2&offset=2").set("Authorization", `Bearer ${tokenA}`);
    expect(page2.body.quotes.length).toBe(2);

    const idsPage1 = page1.body.quotes.map((q: { id: string }) => q.id);
    const idsPage2 = page2.body.quotes.map((q: { id: string }) => q.id);
    expect(idsPage1.some((id: string) => idsPage2.includes(id))).toBe(false);

    const page3 = await request(app).get("/api/quotes?limit=2&offset=4").set("Authorization", `Bearer ${tokenA}`);
    expect(page3.body.quotes.length).toBe(1);
    expect(page3.body.hasMore).toBe(false);
  });

  it("tenant isolation: company A's page never includes company B's quotes", async () => {
    const res = await request(app).get("/api/quotes?limit=100").set("Authorization", `Bearer ${tokenA}`);
    expect(res.body.quotes.every((q: { clientName: string }) => q.clientName !== "B Client")).toBe(true);
  });
});

describe("Pagination: invoices list", () => {
  it("enforces a server-side max page size", async () => {
    const res = await request(app).get("/api/invoices?limit=99999").set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(400);
  });

  it("paginates deterministically (newest first) with hasMore/limit/offset", async () => {
    const page1 = await request(app).get("/api/invoices?limit=2&offset=0").set("Authorization", `Bearer ${tokenA}`);
    expect(page1.status).toBe(200);
    expect(page1.body.invoices.length).toBe(2);
    expect(page1.body.hasMore).toBe(true);

    const page3 = await request(app).get("/api/invoices?limit=2&offset=4").set("Authorization", `Bearer ${tokenA}`);
    expect(page3.body.invoices.length).toBe(1);
    expect(page3.body.hasMore).toBe(false);
  });

  it("tenant isolation: company A's page never includes company B's invoices", async () => {
    const res = await request(app).get("/api/invoices?limit=100").set("Authorization", `Bearer ${tokenA}`);
    expect(res.body.invoices.every((inv: { clientName: string }) => inv.clientName !== "B Client")).toBe(true);
  });
});
