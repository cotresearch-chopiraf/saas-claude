import { describe, it, expect } from "vitest";
import { buildCanonicalDocumentFromInvoice, mapZatcaTaxCategory, type BuildDocumentInput } from "../src/lib/zatca/documentBuilder.js";
import { buildZatcaInvoiceXml } from "../src/lib/zatca/xmlBuilder.js";
import { computeDocumentHash, GENESIS_PREVIOUS_INVOICE_HASH } from "../src/lib/zatca/hash.js";
import { validateDocumentArithmetic, checkXmlWellFormed } from "../src/lib/zatca/validation.js";

// MIDAD ZATCA Slice 4 — documentBuilder.ts is the ONLY place a real MIDAD
// invoice becomes a CanonicalZatcaDocument. Pure-function tests: no
// database, no HTTP. Reuses the exact Slice 1 engine (buildZatcaInvoiceXml/
// hash.ts/validation.ts) unmodified, exactly as production code does.

const baseInput: BuildDocumentInput = {
  invoice: {
    invoiceNumber: "INV-2026-0001",
    clientName: "Acme Construction Co",
    clientAddress: "123 King Fahd Rd, Riyadh",
    clientTaxId: "310000000000003",
    taxRatePercent: "15.00",
    taxCategory: "standard_rate",
    issueDate: "2026-08-31",
  },
  items: [
    { description: "Concrete supply", amount: "1000.00" },
    { description: "Labor", amount: "500.00" },
  ],
  supplier: {
    legalName: "MIDAD Test Contractor LLC",
    address: "456 Olaya St, Riyadh",
    vatNumber: "300000000000003",
    commercialRegistration: "1010101010",
  },
  zatcaUuid: "11111111-1111-1111-1111-111111111111",
  invoiceCounterValue: 1,
  previousInvoiceHash: GENESIS_PREVIOUS_INVOICE_HASH,
  issueTime: "10:30:00",
};

describe("mapZatcaTaxCategory", () => {
  it("maps a positive rate to Standard (S)", () => {
    expect(mapZatcaTaxCategory("standard_rate", 15)).toBe("S");
  });
  it("maps a zero rate with no exempt hint to Zero-rated (Z)", () => {
    expect(mapZatcaTaxCategory("zero_rated", 0)).toBe("Z");
  });
  it("maps a zero rate with an exempt hint to Exempt (E)", () => {
    expect(mapZatcaTaxCategory("exempt_export", 0)).toBe("E");
  });
  it("defaults unset/unrecognized taxCategory at a positive rate to Standard (S)", () => {
    expect(mapZatcaTaxCategory(null, 15)).toBe("S");
  });
});

describe("buildCanonicalDocumentFromInvoice", () => {
  it("produces arithmetically consistent totals matching lib/money.ts's computeTotals exactly", () => {
    const doc = buildCanonicalDocumentFromInvoice(baseInput);
    // 1500 subtotal * 15% = 225 tax, 1725 total -- computed by the SAME
    // protected computeTotals() invoices.ts itself uses, not reimplemented.
    expect(doc.taxExclusiveAmount).toBe(1500);
    expect(doc.totalTaxAmount).toBe(225);
    expect(doc.taxInclusiveAmount).toBe(1725);
    expect(doc.payableAmount).toBe(1725);
    expect(validateDocumentArithmetic(doc)).toEqual([]);
  });

  it("derives subtype 'standard' (B2B) when the invoice has a clientTaxId", () => {
    const doc = buildCanonicalDocumentFromInvoice(baseInput);
    expect(doc.subtype).toBe("standard");
  });

  it("derives subtype 'simplified' (B2C) when the invoice has no clientTaxId", () => {
    const doc = buildCanonicalDocumentFromInvoice({
      ...baseInput,
      invoice: { ...baseInput.invoice, clientTaxId: null },
    });
    expect(doc.subtype).toBe("simplified");
  });

  it("produces one line per invoice item, preserving description and amount", () => {
    const doc = buildCanonicalDocumentFromInvoice(baseInput);
    expect(doc.lines).toHaveLength(2);
    expect(doc.lines[0].description).toBe("Concrete supply");
    expect(doc.lines[0].lineExtensionAmount).toBe(1000);
    expect(doc.lines[1].lineExtensionAmount).toBe(500);
  });

  it("carries the caller-supplied uuid/icv/pih through unchanged", () => {
    const doc = buildCanonicalDocumentFromInvoice(baseInput);
    expect(doc.uuid).toBe(baseInput.zatcaUuid);
    expect(doc.invoiceCounterValue).toBe(1);
    expect(doc.previousInvoiceHash).toBe(GENESIS_PREVIOUS_INVOICE_HASH);
  });

  it("produces XML that is well-formed and passes structural validation", () => {
    const doc = buildCanonicalDocumentFromInvoice(baseInput);
    const xml = buildZatcaInvoiceXml(doc);
    expect(checkXmlWellFormed(xml)).toEqual([]);
    expect(xml).toContain("INV-2026-0001");
    expect(xml).toContain(baseInput.supplier.vatNumber!);
  });

  it("is deterministic: identical input produces byte-identical XML and hash (required for safe retries)", () => {
    const doc1 = buildCanonicalDocumentFromInvoice(baseInput);
    const doc2 = buildCanonicalDocumentFromInvoice(baseInput);
    const xml1 = buildZatcaInvoiceXml(doc1);
    const xml2 = buildZatcaInvoiceXml(doc2);
    expect(xml1).toBe(xml2);
    expect(computeDocumentHash(xml1)).toBe(computeDocumentHash(xml2));
  });

  it("a different issueTime input produces a different hash (issueTime genuinely affects the document)", () => {
    const docA = buildCanonicalDocumentFromInvoice(baseInput);
    const docB = buildCanonicalDocumentFromInvoice({ ...baseInput, issueTime: "23:59:59" });
    expect(computeDocumentHash(buildZatcaInvoiceXml(docA))).not.toBe(computeDocumentHash(buildZatcaInvoiceXml(docB)));
  });

  it("KNOWN LIMITATION: the free-text company/client address becomes streetName with a fixed SA country code", () => {
    const doc = buildCanonicalDocumentFromInvoice(baseInput);
    expect(doc.supplier.address?.countryCode).toBe("SA");
    expect(doc.supplier.address?.streetName).toBe(baseInput.supplier.address);
    expect(doc.customer?.address?.countryCode).toBe("SA");
  });

  it("omits customer address entirely when the invoice has no clientAddress, rather than fabricating one", () => {
    const doc = buildCanonicalDocumentFromInvoice({
      ...baseInput,
      invoice: { ...baseInput.invoice, clientAddress: null },
    });
    expect(doc.customer?.address).toBeUndefined();
  });
});
