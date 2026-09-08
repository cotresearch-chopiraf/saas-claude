import "reflect-metadata";
import { describe, it, expect, beforeAll } from "vitest";
import { webcrypto } from "node:crypto";
import * as x509 from "@peculiar/x509";
import { XadesZatcaSigner } from "../src/lib/zatca/signer/xadesZatcaSigner.js";
import { verifyZatcaSignature } from "../src/lib/zatca/signer/verify.js";
import { useZatcaCsrCurve } from "./helpers/zatcaEnv.js";
import { buildZatcaInvoiceXml } from "../src/lib/zatca/xmlBuilder.js";
import type { CanonicalZatcaDocument } from "../src/lib/zatca/types.js";
import type { ResolvedZatcaCredential } from "../src/lib/zatca/provider/types.js";

// Slice 5 continuation, task #49 — local (offline) signature verification.
// See verify.ts's file comment: entirely self-contained (never needs the
// private key or credential), meant to catch a MIDAD-side signing bug
// before any signed document is ever sent to ZATCA. These tests prove it
// actually detects tampering in each of the elements it checks, not just
// that it accepts a well-formed signature.

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

async function signSampleDocument(): Promise<{ signedXml: string; wrongPublicKeyCert: string }> {
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

  // A second, unrelated self-signed cert (different key pair) — used to
  // prove a substituted certificate is caught.
  const otherKeys = (await webcrypto.subtle.generateKey(alg, true, ["sign", "verify"])) as CryptoKeyPair;
  const otherCert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "02",
    name: "CN=Other Cert,O=Other Co,C=SA",
    notBefore: new Date("2026-01-01"),
    notAfter: new Date("2027-01-01"),
    signingAlgorithm: alg,
    keys: otherKeys,
  });

  return { signedXml, wrongPublicKeyCert: Buffer.from(otherCert.rawData).toString("base64") };
}

describe("verifyZatcaSignature", () => {
  it("accepts a real, untampered XadesZatcaSigner output", async () => {
    const { signedXml } = await signSampleDocument();
    const result = await verifyZatcaSignature(signedXml);
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("rejects malformed XML", async () => {
    const result = await verifyZatcaSignature("<Invoice><Unclosed>");
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/malformed XML/);
  });

  it("rejects XML with no Signature element at all", async () => {
    const xml = buildZatcaInvoiceXml(sampleDoc);
    const result = await verifyZatcaSignature(xml);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/missing ds:Signature/);
  });

  it("rejects a tampered invoice line amount (invoice content no longer matches the signed digest)", async () => {
    const { signedXml } = await signSampleDocument();
    const tampered = signedXml.replace("<cbc:LineExtensionAmount currencyID=\"SAR\">100.00</cbc:LineExtensionAmount>", "<cbc:LineExtensionAmount currencyID=\"SAR\">999.00</cbc:LineExtensionAmount>");
    expect(tampered).not.toBe(signedXml);
    const result = await verifyZatcaSignature(tampered);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/invoice content does not match/);
  });

  it("rejects a tampered SigningTime (SignedProperties digest no longer matches)", async () => {
    const { signedXml } = await signSampleDocument();
    const tampered = signedXml.replace(/<xades:SigningTime>[^<]+<\/xades:SigningTime>/, "<xades:SigningTime>2099-01-01T00:00:00Z</xades:SigningTime>");
    expect(tampered).not.toBe(signedXml);
    const result = await verifyZatcaSignature(tampered);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/SignedProperties digest/);
  });

  it("rejects a substituted certificate whose public key never signed this document (signature no longer cryptographically valid)", async () => {
    const { signedXml, wrongPublicKeyCert } = await signSampleDocument();
    const tampered = signedXml.replace(/<ds:X509Certificate>[^<]+<\/ds:X509Certificate>/, `<ds:X509Certificate>${wrongPublicKeyCert}</ds:X509Certificate>`);
    expect(tampered).not.toBe(signedXml);
    const result = await verifyZatcaSignature(tampered);
    expect(result.valid).toBe(false);
    // The substituted cert also breaks the CertDigest match (computed
    // over the DER bytes) before crypto verification is even reached --
    // both are real, honest rejections of the same tampering.
    expect(result.reason).toMatch(/certificate digest does not match|signature does not cryptographically verify/);
  });

  it("rejects a tampered SignatureValue (corrupted signature bytes)", async () => {
    const { signedXml } = await signSampleDocument();
    const tampered = signedXml.replace(/<ds:SignatureValue>[^<]+<\/ds:SignatureValue>/, "<ds:SignatureValue>AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA</ds:SignatureValue>");
    expect(tampered).not.toBe(signedXml);
    const result = await verifyZatcaSignature(tampered);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/signature does not cryptographically verify|threw/);
  });

  it("rejects a tampered X509IssuerName in SignedProperties (issuer/serial consistency check)", async () => {
    const { signedXml } = await signSampleDocument();
    const tampered = signedXml.replace(/<ds:X509IssuerName>[^<]+<\/ds:X509IssuerName>/, "<ds:X509IssuerName>CN=Impersonator</ds:X509IssuerName>");
    expect(tampered).not.toBe(signedXml);
    const result = await verifyZatcaSignature(tampered);
    expect(result.valid).toBe(false);
    // Tampering the issuer name also changes the canonicalized
    // SignedProperties bytes, so the digest check (which runs first) is
    // what actually fires here -- still a correct, honest rejection.
    expect(result.reason).toMatch(/SignedProperties digest|issuer does not match/);
  });

  it("never throws for arbitrary garbage input -- always returns a structured result", async () => {
    await expect(verifyZatcaSignature("")).resolves.toMatchObject({ valid: false });
    await expect(verifyZatcaSignature("not xml at all")).resolves.toMatchObject({ valid: false });
  });

  it("rejects a signature whose SigningTime falls outside the embedded certificate's validity period (expired cert)", async () => {
    const alg = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
    const keys = (await webcrypto.subtle.generateKey(alg, true, ["sign", "verify"])) as CryptoKeyPair;
    // A certificate that was already expired well before "now" -- any
    // real SigningTime (always "now" from XadesZatcaSigner) necessarily
    // falls outside this window.
    const expiredCert = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: "03",
      name: "CN=Expired Cert,O=Test Co,C=SA",
      notBefore: new Date("2020-01-01"),
      notAfter: new Date("2020-06-01"),
      signingAlgorithm: alg,
      keys,
    });
    const privateDer = await webcrypto.subtle.exportKey("pkcs8", keys.privateKey);
    const privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(privateDer).toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
    const credential: ResolvedZatcaCredential = {
      binarySecurityToken: Buffer.from(expiredCert.rawData).toString("base64"),
      secret: "s",
      privateKeyPem,
      curve: "P-256",
    };
    const signer = new XadesZatcaSigner();
    const xml = buildZatcaInvoiceXml(sampleDoc);
    const { signedXml } = await signer.sign({ canonicalXml: xml, credential });

    const result = await verifyZatcaSignature(signedXml);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/validity period/);
  });
});
