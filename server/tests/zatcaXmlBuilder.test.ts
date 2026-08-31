import { describe, it, expect } from "vitest";
import { buildZatcaInvoiceXml } from "../src/lib/zatca/xmlBuilder.js";
import type { CanonicalZatcaDocument } from "../src/lib/zatca/types.js";
import { checkXmlWellFormed, checkRequiredElementsPresent, ZATCA_REQUIRED_ELEMENTS } from "../src/lib/zatca/validation.js";

function baseDoc(overrides: Partial<CanonicalZatcaDocument> = {}): CanonicalZatcaDocument {
  return {
    documentTypeCode: "388",
    subtype: "standard",
    uuid: "3cf5ee18-0f37-4c5b-8e0d-1a2b3c4d5e6f",
    id: "INV-2026-0001",
    issueDate: "2026-08-31",
    issueTime: "12:13:57",
    currencyCode: "SAR",
    supplier: {
      registrationName: "شركة الاختبار",
      vatNumber: "300000000000003",
      address: { cityName: "Riyadh", countryCode: "SA" },
    },
    customer: { registrationName: "Test Customer" },
    previousInvoiceHash: "MDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA=",
    invoiceCounterValue: 1,
    lines: [
      {
        id: "1",
        description: "Widget",
        quantity: 2,
        unitPrice: 50,
        lineExtensionAmount: 100,
        taxCategoryCode: "S",
        taxRatePercent: 15,
        taxAmount: 15,
      },
    ],
    taxSubtotals: [{ taxCategoryCode: "S", taxRatePercent: 15, taxableAmount: 100, taxAmount: 15 }],
    taxExclusiveAmount: 100,
    totalTaxAmount: 15,
    taxInclusiveAmount: 115,
    payableAmount: 115,
    ...overrides,
  };
}

describe("buildZatcaInvoiceXml — well-formedness and structure", () => {
  it("produces well-formed XML with no unclosed/mismatched tags", () => {
    const xml = buildZatcaInvoiceXml(baseDoc());
    expect(checkXmlWellFormed(xml)).toEqual([]);
  });

  it("contains every field ZATCA_REQUIRED_ELEMENTS expects", () => {
    const xml = buildZatcaInvoiceXml(baseDoc());
    expect(checkRequiredElementsPresent(xml, ZATCA_REQUIRED_ELEMENTS)).toEqual([]);
  });

  it("starts with the XML declaration", () => {
    const xml = buildZatcaInvoiceXml(baseDoc());
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });

  it("carries the standard UBL namespace declarations", () => {
    const xml = buildZatcaInvoiceXml(baseDoc());
    expect(xml).toContain('xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"');
    expect(xml).toContain("urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2");
  });
});

describe("buildZatcaInvoiceXml — invoice type / subtype encoding", () => {
  it("encodes standard (B2B) subtype as InvoiceTypeCode name 0100000", () => {
    const xml = buildZatcaInvoiceXml(baseDoc({ subtype: "standard" }));
    expect(xml).toContain('<cbc:InvoiceTypeCode name="0100000">388</cbc:InvoiceTypeCode>');
  });

  it("encodes simplified (B2C) subtype as InvoiceTypeCode name 0200000", () => {
    const xml = buildZatcaInvoiceXml(baseDoc({ subtype: "simplified" }));
    expect(xml).toContain('<cbc:InvoiceTypeCode name="0200000">388</cbc:InvoiceTypeCode>');
  });

  it("uses reporting:1.0 profile for simplified and clearance:1.0 for standard", () => {
    const standard = buildZatcaInvoiceXml(baseDoc({ subtype: "standard" }));
    const simplified = buildZatcaInvoiceXml(baseDoc({ subtype: "simplified" }));
    expect(standard).toContain("<cbc:ProfileID>clearance:1.0</cbc:ProfileID>");
    expect(simplified).toContain("<cbc:ProfileID>reporting:1.0</cbc:ProfileID>");
  });

  it("renders credit note (381) and debit note (383) type codes", () => {
    const credit = buildZatcaInvoiceXml(
      baseDoc({ documentTypeCode: "381", billingReference: { invoiceId: "INV-2026-0001", issueDate: "2026-08-01" } }),
    );
    const debit = buildZatcaInvoiceXml(
      baseDoc({ documentTypeCode: "383", billingReference: { invoiceId: "INV-2026-0001", issueDate: "2026-08-01" } }),
    );
    expect(credit).toContain("<cbc:InvoiceTypeCode name=\"0100000\">381</cbc:InvoiceTypeCode>");
    expect(debit).toContain("<cbc:InvoiceTypeCode name=\"0100000\">383</cbc:InvoiceTypeCode>");
  });
});

describe("buildZatcaInvoiceXml — billing reference (credit/debit notes)", () => {
  it("includes cac:BillingReference/cac:InvoiceDocumentReference when supplied", () => {
    const xml = buildZatcaInvoiceXml(
      baseDoc({ documentTypeCode: "381", billingReference: { invoiceId: "INV-2026-0001", issueDate: "2026-08-01" } }),
    );
    expect(xml).toContain("<cac:BillingReference><cac:InvoiceDocumentReference><cbc:ID>INV-2026-0001</cbc:ID><cbc:IssueDate>2026-08-01</cbc:IssueDate></cac:InvoiceDocumentReference></cac:BillingReference>");
  });

  it("omits cac:BillingReference entirely for a plain invoice", () => {
    const xml = buildZatcaInvoiceXml(baseDoc());
    expect(xml).not.toContain("cac:BillingReference");
  });
});

describe("buildZatcaInvoiceXml — ICV and PIH", () => {
  it("carries the invoice counter value and previous invoice hash as AdditionalDocumentReference entries", () => {
    const xml = buildZatcaInvoiceXml(baseDoc({ invoiceCounterValue: 42 }));
    expect(xml).toContain("<cbc:ID>ICV</cbc:ID><cbc:UUID>42</cbc:UUID>");
    expect(xml).toContain("<cbc:ID>PIH</cbc:ID>");
  });
});

describe("buildZatcaInvoiceXml — amounts and lines", () => {
  it("formats monetary amounts to exactly two decimal places with the currency attribute", () => {
    const xml = buildZatcaInvoiceXml(baseDoc());
    expect(xml).toContain('<cbc:TaxExclusiveAmount currencyID="SAR">100.00</cbc:TaxExclusiveAmount>');
    expect(xml).toContain('<cbc:PayableAmount currencyID="SAR">115.00</cbc:PayableAmount>');
  });

  it("renders one cac:InvoiceLine per line item, preserving order", () => {
    const doc = baseDoc({
      lines: [
        { id: "1", description: "A", quantity: 1, unitPrice: 10, lineExtensionAmount: 10, taxCategoryCode: "S", taxRatePercent: 15, taxAmount: 1.5 },
        { id: "2", description: "B", quantity: 1, unitPrice: 20, lineExtensionAmount: 20, taxCategoryCode: "Z", taxRatePercent: 0, taxAmount: 0 },
      ],
      taxSubtotals: [
        { taxCategoryCode: "S", taxRatePercent: 15, taxableAmount: 10, taxAmount: 1.5 },
        { taxCategoryCode: "Z", taxRatePercent: 0, taxableAmount: 20, taxAmount: 0 },
      ],
      taxExclusiveAmount: 30,
      totalTaxAmount: 1.5,
      taxInclusiveAmount: 31.5,
      payableAmount: 31.5,
    });
    const xml = buildZatcaInvoiceXml(doc);
    const lineMatches = xml.match(/<cac:InvoiceLine>/g);
    expect(lineMatches).toHaveLength(2);
    expect(xml.indexOf(">A<")).toBeLessThan(xml.indexOf(">B<"));
  });

  it("escapes a malicious/special-character line description safely", () => {
    const doc = baseDoc({
      lines: [
        {
          id: "1",
          description: `Widget & Co </cbc:Name><Injected>`,
          quantity: 1,
          unitPrice: 100,
          lineExtensionAmount: 100,
          taxCategoryCode: "S",
          taxRatePercent: 15,
          taxAmount: 15,
        },
      ],
    });
    const xml = buildZatcaInvoiceXml(doc);
    expect(checkXmlWellFormed(xml)).toEqual([]);
    expect(xml).not.toContain("<Injected>");
    expect(xml).toContain("Widget &amp; Co &lt;/cbc:Name&gt;&lt;Injected&gt;");
  });
});

describe("buildZatcaInvoiceXml — Arabic / bilingual content", () => {
  it("preserves Arabic supplier/customer names verbatim (UTF-8, no mangling)", () => {
    const doc = baseDoc({
      supplier: { registrationName: "شركة الاختبار للمقاولات", vatNumber: "300000000000003" },
      customer: { registrationName: "عميل تجريبي" },
    });
    const xml = buildZatcaInvoiceXml(doc);
    expect(xml).toContain("شركة الاختبار للمقاولات");
    expect(xml).toContain("عميل تجريبي");
    expect(checkXmlWellFormed(xml)).toEqual([]);
  });
});

describe("buildZatcaInvoiceXml — determinism", () => {
  it("produces byte-identical output for identical input (pure function)", () => {
    const doc = baseDoc();
    expect(buildZatcaInvoiceXml(doc)).toBe(buildZatcaInvoiceXml(doc));
  });
});
