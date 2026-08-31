import { describe, it, expect } from "vitest";
import { buildZatcaQrPayload, buildPhase1QrPayload, buildPhase2QrPayload, ZATCA_QR_TAG } from "../src/lib/zatca/qr.js";

// Manually decode a base64 TLV payload back into {tag, value} pairs so
// tests can assert on the actual wire structure, not just "it produced a
// string".
function decodeTlv(base64: string): { tag: number; value: Buffer }[] {
  const bytes = Buffer.from(base64, "base64");
  const fields: { tag: number; value: Buffer }[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const tag = bytes[offset];
    const length = bytes[offset + 1];
    const value = bytes.subarray(offset + 2, offset + 2 + length);
    fields.push({ tag, value });
    offset += 2 + length;
  }
  return fields;
}

describe("buildZatcaQrPayload — TLV mechanics", () => {
  it("encodes a single ASCII field with correct tag/length/value bytes", () => {
    const payload = buildZatcaQrPayload([{ tag: 1, value: "Acme" }]);
    const decoded = decodeTlv(payload);
    expect(decoded).toHaveLength(1);
    expect(decoded[0].tag).toBe(1);
    expect(decoded[0].value.length).toBe(4);
    expect(decoded[0].value.toString("utf-8")).toBe("Acme");
  });

  it("uses UTF-8 BYTE length, not character length, for multi-byte Arabic text", () => {
    const arabicName = "شركة"; // 4 Arabic characters, but each is 2 UTF-8 bytes = 8 bytes
    const byteLength = Buffer.from(arabicName, "utf-8").length;
    expect(byteLength).toBe(8); // sanity check on the test fixture itself

    const payload = buildZatcaQrPayload([{ tag: 1, value: arabicName }]);
    const decoded = decodeTlv(payload);
    expect(decoded[0].value.length).toBe(byteLength);
    expect(decoded[0].value.toString("utf-8")).toBe(arabicName);
  });

  it("round-trips a full Arabic company name correctly through TLV + Base64", () => {
    const name = "شركة الاختبار للمقاولات والتشييد";
    const payload = buildZatcaQrPayload([{ tag: 1, value: name }]);
    const decoded = decodeTlv(payload);
    expect(decoded[0].value.toString("utf-8")).toBe(name);
  });

  it("handles an empty string value (zero-length TLV field)", () => {
    const payload = buildZatcaQrPayload([{ tag: 1, value: "" }]);
    const decoded = decodeTlv(payload);
    expect(decoded[0].value.length).toBe(0);
  });

  it("encodes multiple fields back-to-back and decodes them all in order", () => {
    const payload = buildZatcaQrPayload([
      { tag: 1, value: "Seller" },
      { tag: 2, value: "300000000000003" },
      { tag: 3, value: "2026-08-31T12:13:57" },
      { tag: 4, value: "115.00" },
      { tag: 5, value: "15.00" },
    ]);
    const decoded = decodeTlv(payload);
    expect(decoded.map((f) => f.tag)).toEqual([1, 2, 3, 4, 5]);
    expect(decoded[3].value.toString("utf-8")).toBe("115.00");
  });

  it("produces valid, decodable Base64 output", () => {
    const payload = buildZatcaQrPayload([{ tag: 1, value: "x" }]);
    expect(() => Buffer.from(payload, "base64")).not.toThrow();
    expect(/^[A-Za-z0-9+/]+=*$/.test(payload)).toBe(true);
  });

  it("rejects a field whose byte length exceeds the one-byte TLV limit (255)", () => {
    const tooLong = "x".repeat(256);
    expect(() => buildZatcaQrPayload([{ tag: 1, value: tooLong }])).toThrow(/exceeds the one-byte TLV length limit/);
  });

  it("accepts a raw Buffer value (for cryptographic fields) without re-encoding it as UTF-8 text", () => {
    const rawBytes = Buffer.from([0x00, 0xff, 0x10, 0x20]);
    const payload = buildZatcaQrPayload([{ tag: 6, value: rawBytes }]);
    const decoded = decodeTlv(payload);
    expect(decoded[0].value).toEqual(rawBytes);
  });

  it("is deterministic — identical input produces identical output", () => {
    const fields = [{ tag: ZATCA_QR_TAG.sellerName, value: "Acme" } as const];
    expect(buildZatcaQrPayload([...fields])).toBe(buildZatcaQrPayload([...fields]));
  });
});

describe("buildPhase1QrPayload — 5 mandatory fields", () => {
  it("encodes exactly the 5 Phase 1 fields in tag order 1-5", () => {
    const payload = buildPhase1QrPayload({
      sellerName: "شركة الاختبار",
      vatRegistrationNumber: "300000000000003",
      timestamp: "2026-08-31T12:13:57",
      invoiceTotal: "115.00",
      vatTotal: "15.00",
    });
    const decoded = decodeTlv(payload);
    expect(decoded.map((f) => f.tag)).toEqual([1, 2, 3, 4, 5]);
    expect(decoded[0].value.toString("utf-8")).toBe("شركة الاختبار");
    expect(decoded[1].value.toString("utf-8")).toBe("300000000000003");
    expect(decoded[2].value.toString("utf-8")).toBe("2026-08-31T12:13:57");
  });
});

describe("buildPhase2QrPayload — 9 fields including cryptographic material", () => {
  it("encodes all 9 tags in order, appending the 4 cryptographic fields after the base 5", () => {
    const payload = buildPhase2QrPayload({
      sellerName: "Acme",
      vatRegistrationNumber: "300000000000003",
      timestamp: "2026-08-31T12:13:57",
      invoiceTotal: "115.00",
      vatTotal: "15.00",
      invoiceXmlHash: Buffer.from("hash-bytes"),
      ecdsaSignature: Buffer.from("sig-bytes"),
      ecdsaPublicKey: Buffer.from("pubkey-bytes"),
      certificateSignature: Buffer.from("cert-sig-bytes"),
    });
    const decoded = decodeTlv(payload);
    expect(decoded.map((f) => f.tag)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(decoded[5].value.toString()).toBe("hash-bytes");
    expect(decoded[8].value.toString()).toBe("cert-sig-bytes");
  });
});
