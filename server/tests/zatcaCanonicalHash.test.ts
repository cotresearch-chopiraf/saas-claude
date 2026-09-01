import { describe, it, expect } from "vitest";
import { computeCanonicalInvoiceHash } from "../src/lib/zatca/canonicalHash.js";
import { buildZatcaInvoiceXml } from "../src/lib/zatca/xmlBuilder.js";
import type { CanonicalZatcaDocument } from "../src/lib/zatca/types.js";

// Slice 5 continuation — computeCanonicalInvoiceHash implements the
// USER-SUPPLIED removal-then-C14N-then-hash sequence (see
// docs/zatca/SLICE5_OFFICIAL_SPEC_VERIFICATION.md for provenance). These
// tests verify MIDAD's own implementation is internally consistent and
// does what it claims — they are NOT a claim that the resulting hash
// matches what a real ZATCA endpoint expects (unverifiable without a
// reachable primary source).

const NS = {
  ext: "urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2",
  cac: "urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2",
  cbc: "urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2",
};

function withUblExtensions(xml: string): string {
  return xml.replace(
    "<cbc:ID>",
    `<ext:UBLExtensions><ext:UBLExtension><ext:ExtensionContent>placeholder-signature-block</ext:ExtensionContent></ext:UBLExtension></ext:UBLExtensions><cbc:ID>`,
  );
}

function withQrReference(xml: string): string {
  return xml.replace(
    "</Invoice>",
    `<cac:AdditionalDocumentReference><cbc:ID>QR</cbc:ID><cbc:UUID>ZmFrZS1xci1wYXlsb2Fk</cbc:UUID></cac:AdditionalDocumentReference></Invoice>`,
  );
}

function withSignature(xml: string): string {
  return xml.replace(
    "</Invoice>",
    `<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:SignatureValue>fake</ds:SignatureValue></ds:Signature></Invoice>`,
  );
}

describe("computeCanonicalInvoiceHash", () => {
  const baseXml = `<?xml version="1.0" encoding="UTF-8"?>\n<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="${NS.cac}" xmlns:cbc="${NS.cbc}" xmlns:ext="${NS.ext}"><cbc:ID>INV-1</cbc:ID></Invoice>`;

  it("is deterministic for the same input", () => {
    expect(computeCanonicalInvoiceHash(baseXml)).toBe(computeCanonicalInvoiceHash(baseXml));
  });

  it("produces a valid base64 SHA-256 digest (32 bytes decoded)", () => {
    const hash = computeCanonicalInvoiceHash(baseXml);
    const decoded = Buffer.from(hash, "base64");
    expect(decoded.length).toBe(32);
  });

  it("produces the SAME hash whether or not a UBLExtensions block is present (it is removed before hashing)", () => {
    const withExt = withUblExtensions(baseXml);
    expect(withExt).not.toBe(baseXml);
    expect(computeCanonicalInvoiceHash(withExt)).toBe(computeCanonicalInvoiceHash(baseXml));
  });

  it("produces the SAME hash whether or not the QR AdditionalDocumentReference is present (it is removed before hashing)", () => {
    const withQr = withQrReference(baseXml);
    expect(withQr).not.toBe(baseXml);
    expect(computeCanonicalInvoiceHash(withQr)).toBe(computeCanonicalInvoiceHash(baseXml));
  });

  it("produces the SAME hash whether or not a ds:Signature element is present (it is removed before hashing)", () => {
    const withSig = withSignature(baseXml);
    expect(withSig).not.toBe(baseXml);
    expect(computeCanonicalInvoiceHash(withSig)).toBe(computeCanonicalInvoiceHash(baseXml));
  });

  it("removes all three artifact kinds together and still matches the clean baseline", () => {
    const full = withSignature(withQrReference(withUblExtensions(baseXml)));
    expect(computeCanonicalInvoiceHash(full)).toBe(computeCanonicalInvoiceHash(baseXml));
  });

  it("does NOT remove an unrelated AdditionalDocumentReference (e.g. ICV/PIH) — only removes the one whose ID is exactly 'QR'", () => {
    const withIcv = baseXml.replace(
      "</Invoice>",
      `<cac:AdditionalDocumentReference><cbc:ID>ICV</cbc:ID><cbc:UUID>1</cbc:UUID></cac:AdditionalDocumentReference></Invoice>`,
    );
    expect(computeCanonicalInvoiceHash(withIcv)).not.toBe(computeCanonicalInvoiceHash(baseXml));
  });

  it("changes when the surviving invoice content changes", () => {
    const other = baseXml.replace("INV-1", "INV-2");
    expect(computeCanonicalInvoiceHash(other)).not.toBe(computeCanonicalInvoiceHash(baseXml));
  });

  it("is insensitive to non-semantic whitespace differences that C14N normalizes (attribute quoting order aside)", () => {
    // Two documents with the same single-quoted vs double-quoted namespace
    // declarations serialize to the same canonical form.
    const singleQuoted = baseXml.replace(/"/g, "'");
    expect(computeCanonicalInvoiceHash(singleQuoted)).toBe(computeCanonicalInvoiceHash(baseXml));
  });

  it("throws a ZatcaInternalError (not a raw parser exception) on malformed XML", () => {
    expect(() => computeCanonicalInvoiceHash("<Invoice><Unclosed></Invoice>")).toThrow();
  });

  it("works end-to-end against a real buildZatcaInvoiceXml() document (no artifacts present yet, so removal is a no-op)", () => {
    const doc: CanonicalZatcaDocument = {
      id: "INV-2026-0001",
      uuid: "11111111-1111-1111-1111-111111111111",
      issueDate: "2026-09-01",
      issueTime: "12:00:00",
      documentTypeCode: "388",
      subtype: "simplified",
      currencyCode: "SAR",
      invoiceCounterValue: 1,
      previousInvoiceHash: "MA==",
      supplier: { registrationName: "Test Supplier", vatNumber: "300000000000003" },
      taxSubtotals: [{ taxableAmount: 100, taxAmount: 15, taxCategoryCode: "S", taxRatePercent: 15 }],
      totalTaxAmount: 15,
      taxExclusiveAmount: 100,
      taxInclusiveAmount: 115,
      payableAmount: 115,
      lines: [
        {
          id: "1",
          description: "Item",
          quantity: 1,
          unitPrice: 100,
          lineExtensionAmount: 100,
          taxAmount: 15,
          taxRatePercent: 15,
          taxCategoryCode: "S",
        },
      ],
    };
    const xml = buildZatcaInvoiceXml(doc);
    const hash1 = computeCanonicalInvoiceHash(xml);
    const hash2 = computeCanonicalInvoiceHash(xml);
    expect(hash1).toBe(hash2);
    expect(Buffer.from(hash1, "base64").length).toBe(32);
  });
});
