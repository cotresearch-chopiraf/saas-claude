import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";

const app = buildApp();

async function setupCompany() {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Reno Co", name: "Owner", email: "owner@test.com", password: "password123" });
  return res.body.token as string;
}

describe("sequential numbering", () => {
  beforeEach(resetDb);

  it("quote numbers increase and never collide", async () => {
    const token = await setupCompany();
    const numbers: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await request(app)
        .post("/api/quotes")
        .set("Authorization", `Bearer ${token}`)
        .send({ clientName: "Client", projectName: "Job", items: [{ description: "x", amount: 10 }] });
      numbers.push(res.body.quoteNumber);
    }
    expect(new Set(numbers).size).toBe(5);
  });

  it("two companies get independent numbering sequences starting at 1", async () => {
    const tokenA = await setupCompany();
    const resB = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "Other Co", name: "Owner2", email: "owner2@test.com", password: "password123" });
    const tokenB = resB.body.token as string;

    const quoteA = await request(app)
      .post("/api/quotes")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ clientName: "Client", projectName: "Job", items: [{ description: "x", amount: 10 }] });
    const quoteB = await request(app)
      .post("/api/quotes")
      .set("Authorization", `Bearer ${tokenB}`)
      .send({ clientName: "Client", projectName: "Job", items: [{ description: "x", amount: 10 }] });

    expect(quoteA.body.quoteNumber).toContain("-0001");
    expect(quoteB.body.quoteNumber).toContain("-0001");
  });
});

describe("invoicing feature flag", () => {
  beforeEach(resetDb);

  it("is enabled by default", async () => {
    const token = await setupCompany();
    const res = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientName: "Client", items: [{ description: "Work", amount: 500 }] });
    expect(res.status).toBe(201);
  });

  it("rejects invoice creation once a company disables it", async () => {
    const token = await setupCompany();
    await request(app)
      .patch("/api/company/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({ featureFlags: { invoicing: false } });

    const res = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientName: "Client", items: [{ description: "Work", amount: 500 }] });
    expect(res.status).toBe(403);
  });
});

describe("invoice tax calculation", () => {
  beforeEach(resetDb);

  it("snapshots the company's default tax rate at creation time", async () => {
    const token = await setupCompany();
    await request(app)
      .patch("/api/company/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({ defaultTaxRatePercent: 20 });

    const invoice = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientName: "Client", items: [{ description: "Work", amount: 100 }] });
    expect(Number(invoice.body.taxRatePercent)).toBe(20);

    // Changing the company's rate afterwards must not rewrite the issued invoice.
    await request(app)
      .patch("/api/company/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({ defaultTaxRatePercent: 5 });

    const reread = await request(app).get(`/api/invoices/${invoice.body.id}`).set("Authorization", `Bearer ${token}`);
    expect(Number(reread.body.taxRatePercent)).toBe(20);
  });

  it("computes subtotal/tax/total on the list endpoint from the frozen rate", async () => {
    const token = await setupCompany();
    await request(app)
      .patch("/api/company/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({ defaultTaxRatePercent: 10 });

    await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientName: "Client", items: [{ description: "A", amount: 100 }, { description: "B", amount: 50 }] });

    const list = await request(app).get("/api/invoices").set("Authorization", `Bearer ${token}`);
    expect(list.body.invoices[0].subtotal).toBe(150);
    expect(list.body.invoices[0].taxAmount).toBe(15);
    expect(list.body.invoices[0].total).toBe(165);
  });
});

// Red-Team Remediation Wave 1B: routes/invoices.ts previously collapsed
// every calculateTax() reviewReason into the same "use the company's flat
// defaultTaxRatePercent" fallback — including cases where a compliance
// profile DOES exist and the engine genuinely failed to resolve a rate
// (unresolvable_tax_category, unresolvable_vat_rate,
// no_published_rule_version_for_date), not just the legitimate
// "no_compliance_profile" case. These tests pin down the corrected
// per-reviewReason behavior.
describe("invoice tax fallback (Wave 1B fix)", () => {
  beforeEach(resetDb);

  it("calculated: a company with a compliance profile gets the engine's computed rate, not the flat default", async () => {
    const token = await setupCompany();
    await request(app)
      .patch("/api/company/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({ defaultTaxRatePercent: 99 });
    await request(app).post("/api/compliance/profile").set("Authorization", `Bearer ${token}`).send({ countryCode: "SA" });

    const invoice = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientName: "Client", taxCategory: "standard_rate", items: [{ description: "Work", amount: 100 }] });
    expect(invoice.status).toBe(201);
    // Saudi Arabia's own published standard rate — never the unrelated 99% flat default.
    expect(Number(invoice.body.taxRatePercent)).toBe(15);
  });

  it("no_compliance_profile: the legacy flat-default fallback still works exactly as before", async () => {
    const token = await setupCompany();
    await request(app)
      .patch("/api/company/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({ defaultTaxRatePercent: 7 });

    const invoice = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientName: "Client", taxCategory: "standard_rate", items: [{ description: "Work", amount: 100 }] });
    expect(invoice.status).toBe(201);
    expect(Number(invoice.body.taxRatePercent)).toBe(7);
  });

  it("unresolvable_tax_category: rejects with 422 instead of silently using the flat default, and never consumes an invoice number", async () => {
    const token = await setupCompany();
    await request(app)
      .patch("/api/company/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({ defaultTaxRatePercent: 42 });
    await request(app).post("/api/compliance/profile").set("Authorization", `Bearer ${token}`).send({ countryCode: "SA" });

    const rejected = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientName: "Client", taxCategory: "not_a_real_category", items: [{ description: "Work", amount: 100 }] });
    expect(rejected.status).toBe(422);

    // No invoice was created at all — not at the (wrong) 42% default, not at any rate.
    const list = await request(app).get("/api/invoices").set("Authorization", `Bearer ${token}`);
    expect(list.body.invoices).toHaveLength(0);

    // The rejected attempt must not have burned an invoice number: the next
    // successful invoice still gets sequence 0001, not 0002.
    const invoice = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientName: "Client", items: [{ description: "Work", amount: 100 }] });
    expect(invoice.status).toBe(201);
    expect(invoice.body.invoiceNumber).toContain("-0001");
  });
});

describe("document language", () => {
  beforeEach(resetDb);

  it("defaults quotes and invoices to Arabic", async () => {
    const token = await setupCompany();
    const quote = await request(app)
      .post("/api/quotes")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientName: "Client", projectName: "Job", items: [{ description: "x", amount: 10 }] });
    expect(quote.body.language).toBe("ar");
  });

  it("accepts a per-document language choice and generates a PDF for each", async () => {
    const token = await setupCompany();
    for (const language of ["ar", "fr", "en"] as const) {
      const invoice = await request(app)
        .post("/api/invoices")
        .set("Authorization", `Bearer ${token}`)
        .send({ clientName: "Client", language, items: [{ description: "Work", amount: 100 }] });
      expect(invoice.body.language).toBe(language);

      const pdf = await request(app).get(`/api/invoices/${invoice.body.id}/pdf`).set("Authorization", `Bearer ${token}`);
      expect(pdf.status).toBe(200);
      expect(pdf.headers["content-type"]).toBe("application/pdf");
    }
  });
});
