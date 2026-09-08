import "reflect-metadata";
import { describe, it, expect, beforeAll } from "vitest";
import { webcrypto } from "node:crypto";
import * as x509 from "@peculiar/x509";
import { XadesZatcaSigner } from "../src/lib/zatca/signer/xadesZatcaSigner.js";
import { deriveZatcaQrCryptographicTags, buildZatcaQrTags1Through8 } from "../src/lib/zatca/qrCryptographicTags.js";
import { buildZatcaInvoiceXml } from "../src/lib/zatca/xmlBuilder.js";
import { computeCanonicalInvoiceHash } from "../src/lib/zatca/canonicalHash.js";
import type { CanonicalZatcaDocument } from "../src/lib/zatca/types.js";
import type { ResolvedZatcaCredential } from "../src/lib/zatca/provider/types.js";
import { useZatcaCsrCurve } from "./helpers/zatcaEnv.js";

// Slice 5 continuation, task #50 — real QR tags 6-8, tag 9 intentionally
// never produced (see qrCryptographicTags.ts's file comment: it requires
// a real ZATCA CA signature this environment cannot obtain).

useZatcaCsrCurve();
beforeAll(() => {
  x509.cryptoProvider.set(webcrypto as unknown as Crypto);
});

const sampleDoc: CanonicalZatcaDocument = {
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
    { id: "1", description: "Item", quantity: 1, unitPrice: 100, lineExtensionAmount: 100, taxAmount: 15, taxRatePercent: 15, taxCategoryCode: "S" },
  ],
};

async function signSampleDocument(): Promise<{ signedXml: string; publicKey: CryptoKey }> {
  const alg = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
  const keys = (await webcrypto.subtle.generateKey(alg, true, ["sign", "verify"])) as CryptoKeyPair;
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=Test EGS,O=Test Co,C=SA",
    notBefore: new Date("2026-01-01"),
    notAfter: new Date("2027-01-01"),
    signingAlgorithm: alg,
    keys,
  });
  const privateDer = await webcrypto.subtle.exportKey("pkcs8", keys.privateKey);
  const privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(privateDer).toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
  const credential: ResolvedZatcaCredential = {
    binarySecurityToken: Buffer.from(cert.rawData).toString("base64"),
    secret: "s",
    privateKeyPem,
    curve: "P-256",
  };
  const signer = new XadesZatcaSigner();
  const xml = buildZatcaInvoiceXml(sampleDoc);
  const { signedXml } = await signer.sign({ canonicalXml: xml, credential });
  return { signedXml, publicKey: keys.publicKey };
}

describe("deriveZatcaQrCryptographicTags", () => {
  it("derives real, correctly-sized tag values from a real signed invoice", async () => {
    const { signedXml } = await signSampleDocument();
    const tags = await deriveZatcaQrCryptographicTags(signedXml);

    expect(tags.invoiceXmlHash.length).toBe(32); // raw SHA-256
    expect(tags.ecdsaSignature.length).toBeGreaterThan(0);
    expect(tags.ecdsaSignature.length).toBeLessThanOrEqual(255);
    expect(tags.ecdsaPublicKey.length).toBe(65); // uncompressed P-256 point: 0x04 + 32 + 32
    expect(tags.ecdsaPublicKey[0]).toBe(0x04);
  });

  it("the derived invoiceXmlHash equals computeCanonicalInvoiceHash of the same document, decoded to raw bytes", async () => {
    const { signedXml } = await signSampleDocument();
    const tags = await deriveZatcaQrCryptographicTags(signedXml);
    const expected = Buffer.from(computeCanonicalInvoiceHash(signedXml), "base64");
    expect(tags.invoiceXmlHash.equals(expected)).toBe(true);
  });

  it("the derived public key round-trips: it can be re-imported and used to verify a signature made by the matching private key", async () => {
    const { signedXml, publicKey } = await signSampleDocument();
    const tags = await deriveZatcaQrCryptographicTags(signedXml);

    const expectedRaw = Buffer.from(await webcrypto.subtle.exportKey("raw", publicKey));
    expect(tags.ecdsaPublicKey.equals(expectedRaw)).toBe(true);
  });

  it("throws (never fabricates) on XML with no signature", async () => {
    const xml = buildZatcaInvoiceXml(sampleDoc);
    await expect(deriveZatcaQrCryptographicTags(xml)).rejects.toThrow();
  });
});

describe("buildZatcaQrTags1Through8", () => {
  it("builds a real TLV payload carrying tags 1-8 and nothing beyond (never tag 9)", async () => {
    const { signedXml } = await signSampleDocument();
    const payload = await buildZatcaQrTags1Through8({
      sellerName: "Test Supplier",
      vatRegistrationNumber: "300000000000003",
      timestamp: "2026-09-01T12:00:00",
      invoiceTotal: "115.00",
      vatTotal: "15.00",
      signedXml,
    });

    const decoded = Buffer.from(payload, "base64");
    const tagsSeen: number[] = [];
    let offset = 0;
    while (offset < decoded.length) {
      const tag = decoded[offset];
      const len = decoded[offset + 1];
      tagsSeen.push(tag);
      offset += 2 + len;
    }
    expect(tagsSeen).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(tagsSeen).not.toContain(9);
  });
});
