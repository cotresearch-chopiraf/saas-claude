import { describe, it, expect } from "vitest";
import {
  checkXmlWellFormed,
  checkRequiredElementsPresent,
  validateDocumentArithmetic,
  validateZatcaDocument,
  ZATCA_REQUIRED_ELEMENTS,
} from "../src/lib/zatca/validation.js";
import { buildZatcaInvoiceXml } from "../src/lib/zatca/xmlBuilder.js";
import type { CanonicalZatcaDocument } from "../src/lib/zatca/types.js";

function baseDoc(overrides: Partial<CanonicalZatcaDocument> = {}): CanonicalZatcaDocument {
  return {
    documentTypeCode: "388",
    subtype: "standard",
    uuid: "3cf5ee18-0f37-4c5b-8e0d-1a2b3c4d5e6f",
    id: "INV-2026-0001",
    issueDate: "2026-08-31",
    issueTime: "12:13:57",
    currencyCode: "SAR",
    supplier: { registrationName: "Acme", vatNumber: "300000000000003" },
    previousInvoiceHash: "AAAA",
    invoiceCounterValue: 1,
    lines: [{ id: "1", description: "Widget", quantity: 2, unitPrice: 50, lineExtensionAmount: 100, taxCategoryCode: "S", taxRatePercent: 15, taxAmount: 15 }],
    taxSubtotals: [{ taxCategoryCode: "S", taxRatePercent: 15, taxableAmount: 100, taxAmount: 15 }],
    taxExclusiveAmount: 100,
    totalTaxAmount: 15,
    taxInclusiveAmount: 115,
    payableAmount: 115,
    ...overrides,
  };
}

describe("checkXmlWellFormed", () => {
  it("returns no errors for well-formed XML", () => {
    expect(checkXmlWellFormed("<a><b>x</b></a>")).toEqual([]);
  });

  it("detects an unclosed tag", () => {
    const errors = checkXmlWellFormed("<a><b>x</a>");
    expect(errors.some((e) => e.code === "XML_MISMATCHED_TAG" || e.code === "XML_UNCLOSED_TAG")).toBe(true);
  });

  it("detects multiple root elements", () => {
    const errors = checkXmlWellFormed("<a/><b/>");
    expect(errors.some((e) => e.code === "XML_MULTIPLE_ROOT_ELEMENTS")).toBe(true);
  });

  it("detects no root element in an empty string", () => {
    const errors = checkXmlWellFormed("");
    expect(errors.some((e) => e.code === "XML_NO_ROOT_ELEMENT")).toBe(true);
  });

  it("accepts self-closing elements as valid", () => {
    expect(checkXmlWellFormed('<a><b attr="x"/></a>')).toEqual([]);
  });

  it("confirms a real generated invoice XML is well-formed", () => {
    const xml = buildZatcaInvoiceXml(baseDoc());
    expect(checkXmlWellFormed(xml)).toEqual([]);
  });
});

describe("checkRequiredElementsPresent", () => {
  it("returns no missing elements when all are present", () => {
    const xml = buildZatcaInvoiceXml(baseDoc());
    expect(checkRequiredElementsPresent(xml, ZATCA_REQUIRED_ELEMENTS)).toEqual([]);
  });

  it("reports a missing element", () => {
    const missing = checkRequiredElementsPresent("<a><b/></a>", ["cbc:ID", "b"]);
    expect(missing).toHaveLength(1);
    expect(missing[0].message).toContain("cbc:ID");
  });
});

describe("validateDocumentArithmetic", () => {
  it("passes for internally consistent amounts", () => {
    expect(validateDocumentArithmetic(baseDoc())).toEqual([]);
  });

  it("flags a line-sum mismatch", () => {
    const doc = baseDoc({ taxExclusiveAmount: 999 });
    const errors = validateDocumentArithmetic(doc);
    expect(errors.some((e) => e.code === "ARITH_LINE_SUM_MISMATCH")).toBe(true);
  });

  it("flags a tax-subtotal sum mismatch", () => {
    const doc = baseDoc({ totalTaxAmount: 999 });
    const errors = validateDocumentArithmetic(doc);
    expect(errors.some((e) => e.code === "ARITH_TAX_SUBTOTAL_MISMATCH")).toBe(true);
  });

  it("flags a tax-inclusive amount mismatch", () => {
    const doc = baseDoc({ taxInclusiveAmount: 999 });
    const errors = validateDocumentArithmetic(doc);
    expect(errors.some((e) => e.code === "ARITH_TAX_INCLUSIVE_MISMATCH")).toBe(true);
  });

  it("flags a payable-amount mismatch", () => {
    const doc = baseDoc({ payableAmount: 999 });
    const errors = validateDocumentArithmetic(doc);
    expect(errors.some((e) => e.code === "ARITH_PAYABLE_MISMATCH")).toBe(true);
  });

  it("flags a credit note missing its billing reference", () => {
    const doc = baseDoc({ documentTypeCode: "381" });
    const errors = validateDocumentArithmetic(doc);
    expect(errors.some((e) => e.code === "MISSING_BILLING_REFERENCE")).toBe(true);
  });

  it("does not flag a credit note that does have a billing reference", () => {
    const doc = baseDoc({ documentTypeCode: "381", billingReference: { invoiceId: "INV-2026-0001", issueDate: "2026-08-01" } });
    const errors = validateDocumentArithmetic(doc);
    expect(errors.some((e) => e.code === "MISSING_BILLING_REFERENCE")).toBe(false);
  });

  it("tolerates sub-cent floating point noise without a false positive", () => {
    const doc = baseDoc({ taxInclusiveAmount: 115.001 });
    expect(validateDocumentArithmetic(doc)).toEqual([]);
  });
});

describe("validateZatcaDocument — combined result", () => {
  it("reports valid:true for a correct document, and always carries sdkVerified:false", () => {
    const doc = baseDoc();
    const xml = buildZatcaInvoiceXml(doc);
    const result = validateZatcaDocument(xml, doc);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.sdkVerified).toBe(false);
  });

  it("always includes the unverified-BR-KSA-rules warning, so a caller cannot mistake this for full ZATCA validation", () => {
    const doc = baseDoc();
    const xml = buildZatcaInvoiceXml(doc);
    const result = validateZatcaDocument(xml, doc);
    expect(result.warnings.some((w) => w.code === "UNVERIFIED_BR_KSA_RULES")).toBe(true);
  });

  it("reports valid:false when the canonical data has an arithmetic inconsistency, even if the XML itself is well-formed", () => {
    const doc = baseDoc({ payableAmount: 1 });
    const xml = buildZatcaInvoiceXml(doc);
    const result = validateZatcaDocument(xml, doc);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === "ARITH_PAYABLE_MISMATCH")).toBe(true);
  });

  it("reports valid:false for malformed XML even if the underlying data is arithmetically correct", () => {
    const doc = baseDoc();
    const brokenXml = "<Invoice><cbc:ID>INV-1</Invoice>";
    const result = validateZatcaDocument(brokenXml, doc);
    expect(result.valid).toBe(false);
  });
});
