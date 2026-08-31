import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import { computeDocumentHash, GENESIS_PREVIOUS_INVOICE_HASH } from "../src/lib/zatca/hash.js";

describe("computeDocumentHash", () => {
  it("computes SHA-256 of the input, Base64-encoded", () => {
    const expected = createHash("sha256").update("hello").digest("base64");
    expect(computeDocumentHash("hello")).toBe(expected);
  });

  it("is deterministic — same input always produces the same hash", () => {
    expect(computeDocumentHash("same input")).toBe(computeDocumentHash("same input"));
  });

  it("produces different hashes for different input (no accidental collisions on simple inputs)", () => {
    expect(computeDocumentHash("a")).not.toBe(computeDocumentHash("b"));
  });

  it("accepts a Buffer as well as a string", () => {
    expect(computeDocumentHash(Buffer.from("hello"))).toBe(computeDocumentHash("hello"));
  });

  it("hashes full UTF-8 (Arabic) content correctly", () => {
    const arabic = "شركة الاختبار";
    const expected = createHash("sha256").update(arabic).digest("base64");
    expect(computeDocumentHash(arabic)).toBe(expected);
  });
});

describe("GENESIS_PREVIOUS_INVOICE_HASH", () => {
  it("equals Base64(SHA-256(\"0\")) — the cross-corroborated genesis value", () => {
    const expected = createHash("sha256").update("0").digest("base64");
    expect(GENESIS_PREVIOUS_INVOICE_HASH).toBe(expected);
  });

  it("is a valid, decodable Base64 string", () => {
    expect(() => Buffer.from(GENESIS_PREVIOUS_INVOICE_HASH, "base64")).not.toThrow();
  });
});
