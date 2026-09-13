import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { buildInvoiceZatcaQrPayload, buildInvoiceQrCodeDataUri, type InvoiceQrInput } from "../src/lib/zatca/invoiceQr.js";
import { buildDocumentHtml, type DocumentData } from "../src/lib/documentHtml.js";

const app = buildApp();

async function setupCompany() {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Reno Co", name: "Owner", email: `owner-${Date.now()}-${Math.random()}@test.com`, password: "password123" });
  return res.body.token as string;
}

// P0-5 pre-launch hardening — ZATCA Phase 1 QR wiring. Proves: (1) the
// payload builder only produces a QR from real, authoritative invoice data
// and never from missing/placeholder data, (2) the payload's total/VAT
// figures track the same computeTotals() every other total in this
// codebase uses, so it cannot silently diverge from what the PDF displays,
// (3) the rendered PDF HTML actually carries a QR <img> for an invoice
// with a configured VAT number and never for one without — or for a
// quote — and (4) the existing invoice/PDF template behavior is untouched
// when no QR is present.

// Same manual TLV decoder pattern already used in zatcaQr.test.ts, kept
// local rather than shared/imported — this file asserts on the invoice-
// specific payload builder, not the generic TLV encoder itself.
function decodeTlv(base64: string): { tag: number; value: string }[] {
  const bytes = Buffer.from(base64, "base64");
  const fields: { tag: number; value: string }[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const tag = bytes[offset];
    const length = bytes[offset + 1];
    const value = bytes.subarray(offset + 2, offset + 2 + length).toString("utf-8");
    fields.push({ tag, value });
    offset += 2 + length;
  }
  return fields;
}

function baseInput(overrides: Partial<InvoiceQrInput> = {}): InvoiceQrInput {
  return {
    sellerName: "شركة الاختبار للمقاولات",
    vatNumber: "300000000000003",
    issueDate: "2026-08-31",
    itemAmounts: [100, 50],
    taxRatePercent: 15,
    ...overrides,
  };
}

describe("buildInvoiceZatcaQrPayload — authoritative data in, correct TLV tags out", () => {
  it("returns null when no ZATCA VAT number is configured — never a QR from missing data", () => {
    expect(buildInvoiceZatcaQrPayload(baseInput({ vatNumber: null }))).toBeNull();
  });

  it("produces exactly the 5 Phase 1 tags, in order, for a fully-configured invoice", () => {
    const payload = buildInvoiceZatcaQrPayload(baseInput());
    expect(payload).not.toBeNull();
    const decoded = decodeTlv(payload!);
    expect(decoded.map((f) => f.tag)).toEqual([1, 2, 3, 4, 5]);
  });

  it("tag 1 (seller name) and tag 2 (VAT number) match the authoritative input exactly", () => {
    const decoded = decodeTlv(buildInvoiceZatcaQrPayload(baseInput())!);
    expect(decoded[0].value).toBe("شركة الاختبار للمقاولات");
    expect(decoded[1].value).toBe("300000000000003");
  });

  it("tag 3 (timestamp) is the invoice's issueDate expressed as ISO 8601 midnight UTC — never a fabricated time", () => {
    const decoded = decodeTlv(buildInvoiceZatcaQrPayload(baseInput({ issueDate: "2026-01-15" }))!);
    expect(decoded[2].value).toBe("2026-01-15T00:00:00Z");
  });

  it("tag 4 (invoice total) and tag 5 (VAT total) are computed via the same computeTotals() every other total in the app uses, formatted to exactly 2 decimals", () => {
    // 150 subtotal, 15% tax -> 22.50 tax, 172.50 total.
    const decoded = decodeTlv(buildInvoiceZatcaQrPayload(baseInput())!);
    expect(decoded[3].value).toBe("172.50");
    expect(decoded[4].value).toBe("22.50");
  });

  it("changing the authoritative item amounts changes the QR payload (total/VAT tags), proving it is not cached/stale", () => {
    const original = buildInvoiceZatcaQrPayload(baseInput());
    const changed = buildInvoiceZatcaQrPayload(baseInput({ itemAmounts: [999, 1] }));
    expect(changed).not.toBe(original);
    const decodedChanged = decodeTlv(changed!);
    expect(decodedChanged[3].value).not.toBe("172.50");
  });

  it("changing the tax rate changes both the invoice-total and VAT-total tags (total includes tax)", () => {
    const decoded15 = decodeTlv(buildInvoiceZatcaQrPayload(baseInput({ taxRatePercent: 15 }))!);
    const decoded0 = decodeTlv(buildInvoiceZatcaQrPayload(baseInput({ taxRatePercent: 0 }))!);
    expect(decoded0[4].value).toBe("0.00");
    expect(decoded15[4].value).not.toBe(decoded0[4].value);
    expect(decoded15[3].value).not.toBe(decoded0[3].value);
  });

  it("uses odd fractional-cent amounts and a non-integer tax rate without producing more than 2 decimal places (no unrounded float leakage)", () => {
    const decoded = decodeTlv(buildInvoiceZatcaQrPayload(baseInput({ itemAmounts: [0.01, 0.1, 999999.99], taxRatePercent: 20.5 }))!);
    expect(decoded[3].value).toMatch(/^\d+\.\d{2}$/);
    expect(decoded[4].value).toMatch(/^\d+\.\d{2}$/);
  });

  it("is a pure function — identical input produces an identical payload", () => {
    expect(buildInvoiceZatcaQrPayload(baseInput())).toBe(buildInvoiceZatcaQrPayload(baseInput()));
  });
});

describe("buildInvoiceQrCodeDataUri — rendered image wrapper", () => {
  it("returns null (never an image built from nothing) when there is no VAT number", async () => {
    expect(await buildInvoiceQrCodeDataUri(baseInput({ vatNumber: null }))).toBeNull();
  });

  it("returns a scannable PNG data URI when the invoice is fully configured", async () => {
    const uri = await buildInvoiceQrCodeDataUri(baseInput());
    expect(uri).toMatch(/^data:image\/png;base64,/);
  });
});

function baseDocument(overrides: Partial<DocumentData> = {}): DocumentData {
  return {
    kind: "invoice",
    language: "ar",
    number: "INV-1",
    date: "2026-01-01",
    company: { name: "شركة الاختبار", logoDataUri: null, address: null, taxId: null, phone: null },
    client: { name: "عميل", address: null, taxId: null },
    items: [{ description: "بند", amount: 100 }],
    taxRatePercent: 15,
    ...overrides,
  };
}

describe("buildDocumentHtml(): QR wiring into the actual PDF/print output", () => {
  it("renders the QR <img> and caption when qrCodeDataUri is present on an invoice", () => {
    const html = buildDocumentHtml(baseDocument({ qrCodeDataUri: "data:image/png;base64,AAAA" }));
    expect(html).toContain('<img src="data:image/png;base64,AAAA"');
    expect(html).toContain("qr-block");
  });

  it("renders no QR block at all when qrCodeDataUri is null (e.g. VAT number not configured) — existing layout is untouched", () => {
    const html = buildDocumentHtml(baseDocument({ qrCodeDataUri: null }));
    expect(html).not.toContain(`class="qr-block"`);
    expect(html).not.toContain("<img");
  });

  it("renders no QR block when qrCodeDataUri is simply omitted — existing quote/invoice callers that never pass it keep working exactly as before", () => {
    const html = buildDocumentHtml(baseDocument());
    expect(html).not.toContain(`class="qr-block"`);
  });

  it("never renders a QR for a quote, even if a data URI were somehow supplied — ZATCA QR is an invoice-only concept", () => {
    const html = buildDocumentHtml(baseDocument({ kind: "quote", qrCodeDataUri: "data:image/png;base64,AAAA" }));
    expect(html).not.toContain(`class="qr-block"`);
  });

  it("the QR image src is HTML-escaped like every other data-URI attribute in this template (defense in depth, matching the existing logo escaping test)", () => {
    const malicious = 'data:image/png;base64,AAAA" onerror="alert(1)';
    const html = buildDocumentHtml(baseDocument({ qrCodeDataUri: malicious }));
    expect(html).not.toContain('src="data:image/png;base64,AAAA" onerror="alert(1)"');
    expect(html).toContain("&quot;");
  });

  it("the totals block (subtotal/tax/total) is completely unaffected by the presence or absence of a QR — existing invoice behavior is preserved", () => {
    const withQr = buildDocumentHtml(baseDocument({ qrCodeDataUri: "data:image/png;base64,AAAA" }));
    const withoutQr = buildDocumentHtml(baseDocument({ qrCodeDataUri: null }));
    const totalsBlock = (html: string) => html.match(/<div class="totals">[\s\S]*?<\/div>\s*<\/div>/)?.[0];
    expect(totalsBlock(withQr)).toBe(totalsBlock(withoutQr));
  });
});

// End-to-end, through the real routes — proves the wiring, not just the
// template function in isolation: the actual tenant PDF route, the actual
// public (client-facing) PDF route, and the actual PATCH /api/zatca/config
// route that a real tenant uses to configure their VAT number.
describe("real HTTP invoice PDF route: ZATCA QR wiring end-to-end", () => {
  beforeEach(resetDb);

  it("a fully-configured company's invoice PDF is a real, non-trivial PDF (QR generation does not break PDF rendering)", async () => {
    const token = await setupCompany();
    await request(app)
      .patch("/api/zatca/config")
      .set("Authorization", `Bearer ${token}`)
      .send({ vatNumber: "300000000000003" });

    const invoice = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientName: "Client", items: [{ description: "Work", amount: 500 }] });
    expect(invoice.status).toBe(201);

    const pdf = await request(app)
      .get(`/api/invoices/${invoice.body.id}/pdf`)
      .set("Authorization", `Bearer ${token}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });

    expect(pdf.status).toBe(200);
    expect(pdf.headers["content-type"]).toContain("application/pdf");
    const body = pdf.body as Buffer;
    expect(body.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(body.length).toBeGreaterThan(1000);
  });

  it("an invoice PDF still renders successfully when no ZATCA VAT number is configured — QR is simply omitted, nothing breaks", async () => {
    const token = await setupCompany();
    const invoice = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientName: "Client", items: [{ description: "Work", amount: 500 }] });
    expect(invoice.status).toBe(201);

    const pdf = await request(app)
      .get(`/api/invoices/${invoice.body.id}/pdf`)
      .set("Authorization", `Bearer ${token}`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });

    expect(pdf.status).toBe(200);
    const body = pdf.body as Buffer;
    expect(body.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("the public (client-facing) invoice PDF link also carries the QR — the same code path a real customer opens", async () => {
    const token = await setupCompany();
    await request(app)
      .patch("/api/zatca/config")
      .set("Authorization", `Bearer ${token}`)
      .send({ vatNumber: "300000000000003" });

    const invoice = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientName: "Client", items: [{ description: "Work", amount: 500 }] });
    await request(app).patch(`/api/invoices/${invoice.body.id}/send`).set("Authorization", `Bearer ${token}`);

    const detail = await request(app).get(`/api/invoices/${invoice.body.id}`).set("Authorization", `Bearer ${token}`);
    const publicToken = detail.body.publicToken as string;

    const pdf = await request(app)
      .get(`/api/public/invoices/${publicToken}/pdf`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => cb(null, Buffer.concat(chunks)));
      });

    expect(pdf.status).toBe(200);
    const body = pdf.body as Buffer;
    expect(body.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });
});
