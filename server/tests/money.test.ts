import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { computeTotals, sumMoney, roundMoney } from "../src/lib/money.js";

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

// The exact defect the audit reported was values like taxAmount: 25513642.0279
// (four decimal places on a currency amount) — this checks the general
// invariant a monetary value must satisfy, independent of the specific
// number involved.
function isTwoDecimalPrecise(n: number): boolean {
  return Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
}

describe("lib/money: deterministic monetary arithmetic", () => {
  it("whole amounts", () => {
    expect(computeTotals([100, 50], 10)).toEqual({ subtotal: 150, taxAmount: 15, total: 165 });
  });

  it("decimal prices", () => {
    expect(computeTotals([19.99, 5.5], 0)).toEqual({ subtotal: 25.49, taxAmount: 0, total: 25.49 });
  });

  it("multiple fractional line items sum exactly — no float drift", () => {
    expect(computeTotals([0.01, 0.1, 0.29], 0).subtotal).toBe(0.4);
  });

  it("zero tax", () => {
    expect(computeTotals([100], 0)).toEqual({ subtotal: 100, taxAmount: 0, total: 100 });
  });

  it("100% tax", () => {
    expect(computeTotals([100], 100)).toEqual({ subtotal: 100, taxAmount: 100, total: 200 });
  });

  it("odd tax rate (20.5%) on a round amount", () => {
    expect(computeTotals([100], 20.5)).toEqual({ subtotal: 100, taxAmount: 20.5, total: 120.5 });
  });

  it("a very small amount (0.01)", () => {
    expect(computeTotals([0.01], 20.5).subtotal).toBe(0.01);
  });

  it("a very large amount stays exact to the cent", () => {
    const result = computeTotals([999999.99], 0);
    expect(result.subtotal).toBe(999999.99);
  });

  it("rounding boundary cases never drift past 2 decimal places", () => {
    for (const [amounts, rate] of [
      [[0.05], 50],
      [[10.1, 10.15, 10.2], 7],
      [[33.33, 33.33, 33.34], 8.25],
    ] as [number[], number][]) {
      const result = computeTotals(amounts, rate);
      expect(isTwoDecimalPrecise(result.subtotal)).toBe(true);
      expect(isTwoDecimalPrecise(result.taxAmount)).toBe(true);
      expect(isTwoDecimalPrecise(result.total)).toBe(true);
    }
  });

  it("the exact audit-reported edge case (0.01, 0.10, 0.29, 999999.99, 123456789.99 @ 20.5%) is 2-decimal precise", () => {
    // Before the fix this returned taxAmount: 25513642.0279 and
    // total: 149970432.4079 — four decimal places on a currency value.
    const result = computeTotals([0.01, 0.1, 0.29, 999999.99, 123456789.99], 20.5);
    expect(isTwoDecimalPrecise(result.subtotal)).toBe(true);
    expect(isTwoDecimalPrecise(result.taxAmount)).toBe(true);
    expect(isTwoDecimalPrecise(result.total)).toBe(true);
    expect(result.subtotal).toBe(124456790.38);
  });

  it("sumMoney agrees with computeTotals's subtotal for the same inputs", () => {
    const amounts = [10.1, 20.2, 30.3];
    expect(sumMoney(amounts)).toBe(computeTotals(amounts, 0).subtotal);
  });

  it("roundMoney is idempotent and always 2-decimal precise", () => {
    const value = roundMoney(19.999);
    expect(isTwoDecimalPrecise(value)).toBe(true);
    expect(roundMoney(value)).toBe(value);
  });
});

describe("invoice financial precision via the real HTTP API", () => {
  beforeEach(resetDb);

  async function setupCompanyWithTax(rate: number) {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "Money Co", name: "Owner", email: uniqueEmail("money"), password: "password123" });
    const token = res.body.token as string;
    await request(app)
      .patch("/api/company/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({ defaultTaxRatePercent: rate });
    return token;
  }

  it("the list endpoint returns 2-decimal-precise totals for the exact audit-reported edge case", async () => {
    const token = await setupCompanyWithTax(20.5);
    const created = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({
        clientName: "Precision Client",
        items: [
          { description: "item1", amount: 0.01 },
          { description: "item2", amount: 0.1 },
          { description: "item3", amount: 0.29 },
          { description: "item4", amount: 999999.99 },
          { description: "item5", amount: 123456789.99 },
        ],
      });
    expect(created.status).toBe(201);

    const list = await request(app).get("/api/invoices").set("Authorization", `Bearer ${token}`);
    const row = list.body.invoices[0];
    expect(isTwoDecimalPrecise(row.subtotal)).toBe(true);
    expect(isTwoDecimalPrecise(row.taxAmount)).toBe(true);
    expect(isTwoDecimalPrecise(row.total)).toBe(true);
    expect(row.subtotal).toBe(124456790.38);
  });

  it("the public invoice view's total is 2-decimal precise", async () => {
    const token = await setupCompanyWithTax(20.5);
    const created = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientName: "Public Client", items: [{ description: "x", amount: 999999.99 }, { description: "y", amount: 0.29 }] });
    await request(app).patch(`/api/invoices/${created.body.id}/send`).set("Authorization", `Bearer ${token}`);

    const publicView = await request(app).get(`/api/public/invoices/${created.body.publicToken}`);
    expect(publicView.status).toBe(200);
    expect(isTwoDecimalPrecise(publicView.body.total)).toBe(true);
  });

  it("the budget totals endpoint returns 2-decimal-precise planned/spent/remaining", async () => {
    const token = await setupCompanyWithTax(0);
    const project = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Precision Project", budgetTotal: 1000 });
    await request(app)
      .post(`/api/projects/${project.body.id}/budget/items`)
      .set("Authorization", `Bearer ${token}`)
      .send({ category: "Materials", plannedAmount: 333.33 });
    await request(app)
      .post(`/api/projects/${project.body.id}/budget/expenses`)
      .set("Authorization", `Bearer ${token}`)
      .send({ description: "Wood", amount: 0.1, expenseDate: "2026-01-01" });
    await request(app)
      .post(`/api/projects/${project.body.id}/budget/expenses`)
      .set("Authorization", `Bearer ${token}`)
      .send({ description: "Nails", amount: 0.2, expenseDate: "2026-01-01" });

    const budget = await request(app).get(`/api/projects/${project.body.id}/budget`).set("Authorization", `Bearer ${token}`);
    expect(isTwoDecimalPrecise(budget.body.totals.planned)).toBe(true);
    expect(isTwoDecimalPrecise(budget.body.totals.spent)).toBe(true);
    expect(isTwoDecimalPrecise(budget.body.totals.remaining)).toBe(true);
    expect(budget.body.totals.spent).toBe(0.3);
  });
});
