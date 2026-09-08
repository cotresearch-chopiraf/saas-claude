import "reflect-metadata";
import { describe, it, expect, beforeAll } from "vitest";
import { webcrypto } from "node:crypto";
import * as x509 from "@peculiar/x509";
import { XadesZatcaSigner } from "../src/lib/zatca/signer/xadesZatcaSigner.js";
import { useZatcaCsrCurve } from "./helpers/zatcaEnv.js";
import { generateEcdsaKeyPair } from "../src/lib/zatca/csr/keyPair.js";
import { buildZatcaInvoiceXml } from "../src/lib/zatca/xmlBuilder.js";
import { computeCanonicalInvoiceHash } from "../src/lib/zatca/canonicalHash.js";
import { ZatcaConfigurationError } from "../src/lib/zatca/errors.js";
import type { CanonicalZatcaDocument } from "../src/lib/zatca/types.js";
import type { ResolvedZatcaCredential } from "../src/lib/zatca/provider/types.js";

// Slice 5 continuation — real XAdES signer. See xadesZatcaSigner.ts's file
// comment for full provenance of which structural details are
// USER-SUPPLIED vs. public XMLDSig/XAdES standards vs. this module's own
// documented choices. These tests verify MIDAD's own code is internally
// consistent, produces a well-formed signature that a standard ECDSA
// verifier accepts, and refuses to fabricate a signature when the
// credential is incomplete — NOT that ZATCA itself will accept this exact
// structure (unverifiable without a reachable primary source).

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

async function makeSelfSignedTestCertificate(): Promise<{ certBase64: string; privateKeyPem: string; curve: string }> {
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
  return { certBase64: Buffer.from(cert.rawData).toString("base64"), privateKeyPem, curve: "P-256" };
}

describe("XadesZatcaSigner", () => {
  it("refuses to sign without a private key on the credential", async () => {
    const signer = new XadesZatcaSigner();
    const credential: ResolvedZatcaCredential = { binarySecurityToken: "irrelevant", secret: "s" };
    const xml = buildZatcaInvoiceXml(sampleDoc);
    await expect(signer.sign({ canonicalXml: xml, credential })).rejects.toThrow(ZatcaConfigurationError);
  });

  it("refuses to sign without a certificate on the credential", async () => {
    const signer = new XadesZatcaSigner();
    const { privateKeyPem, curve } = await makeSelfSignedTestCertificate();
    const credential: ResolvedZatcaCredential = { binarySecurityToken: "", secret: "s", privateKeyPem, curve };
    const xml = buildZatcaInvoiceXml(sampleDoc);
    await expect(signer.sign({ canonicalXml: xml, credential })).rejects.toThrow(ZatcaConfigurationError);
  });

  it("produces a real, well-formed signed XML once a private key and certificate are both present", async () => {
    const signer = new XadesZatcaSigner();
    const { certBase64, privateKeyPem, curve } = await makeSelfSignedTestCertificate();
    const credential: ResolvedZatcaCredential = { binarySecurityToken: certBase64, secret: "s", privateKeyPem, curve };
    const xml = buildZatcaInvoiceXml(sampleDoc);

    const result = await signer.sign({ canonicalXml: xml, credential });

    expect(result.signedXml).toContain("<ext:UBLExtensions>");
    expect(result.signedXml).toContain("<ds:Signature");
    expect(result.signedXml).toContain("xades-SignedProperties");
    expect(result.signatureValueBase64.length).toBeGreaterThan(0);
    expect(() => Buffer.from(result.signatureValueBase64, "base64")).not.toThrow();

    // The signed XML must still parse as well-formed XML.
    const { DOMParser } = await import("@xmldom/xmldom");
    let parseErrored = false;
    const doc = new DOMParser({
      onError: () => {
        parseErrored = true;
      },
    }).parseFromString(result.signedXml, "text/xml");
    expect(parseErrored).toBe(false);
    expect((doc as unknown as { documentElement: unknown }).documentElement).toBeTruthy();
  });

  it("produces a signature that a standard WebCrypto ECDSA verifier accepts over the actual SignedInfo bytes", async () => {
    const signer = new XadesZatcaSigner();
    const alg = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
    const keys = (await webcrypto.subtle.generateKey(alg, true, ["sign", "verify"])) as CryptoKeyPair;
    const cert = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: "02",
      name: "CN=Verify Test,O=Test Co,C=SA",
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
    const xml = buildZatcaInvoiceXml(sampleDoc);
    const result = await signer.sign({ canonicalXml: xml, credential });

    // Re-derive the exact SignedInfo canonical bytes independently (by
    // re-extracting the ds:SignedInfo element from the signed XML output
    // and canonicalizing it the same way) and verify the signature over
    // them with the public key — proves the signature is real and
    // internally consistent, not a placeholder string.
    const { DOMParser: XDOMParser } = await import("@xmldom/xmldom");
    const { C14nCanonicalization } = await import("xml-crypto");
    const doc = new XDOMParser().parseFromString(result.signedXml, "text/xml");
    const signedInfoEl = (doc as unknown as { getElementsByTagNameNS(ns: string, ln: string): ArrayLike<unknown> }).getElementsByTagNameNS(
      "http://www.w3.org/2000/09/xmldsig#",
      "SignedInfo",
    )[0];
    const canonicalSignedInfo = new C14nCanonicalization().process(signedInfoEl as unknown as Node, {});

    const verified = await webcrypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      keys.publicKey,
      Buffer.from(result.signatureValueBase64, "base64"),
      Buffer.from(canonicalSignedInfo, "utf8"),
    );
    expect(verified).toBe(true);
  });

  it("the invoiceSignedData Reference's DigestValue equals computeCanonicalInvoiceHash of the ORIGINAL (unsigned) XML", async () => {
    const signer = new XadesZatcaSigner();
    const { certBase64, privateKeyPem, curve } = await makeSelfSignedTestCertificate();
    const credential: ResolvedZatcaCredential = { binarySecurityToken: certBase64, secret: "s", privateKeyPem, curve };
    const xml = buildZatcaInvoiceXml(sampleDoc);
    const expectedHash = computeCanonicalInvoiceHash(xml);

    const result = await signer.sign({ canonicalXml: xml, credential });
    expect(result.signedXml).toContain(expectedHash);
  });

  it("signing the same document twice produces two DIFFERENT signatures (SigningTime changes, real timestamp not a fixture)", async () => {
    const signer = new XadesZatcaSigner();
    const { certBase64, privateKeyPem, curve } = await makeSelfSignedTestCertificate();
    const credential: ResolvedZatcaCredential = { binarySecurityToken: certBase64, secret: "s", privateKeyPem, curve };
    const xml = buildZatcaInvoiceXml(sampleDoc);

    const first = await signer.sign({ canonicalXml: xml, credential });
    await new Promise((r) => setTimeout(r, 1100));
    const second = await signer.sign({ canonicalXml: xml, credential });

    expect(first.signatureValueBase64).not.toBe(second.signatureValueBase64);
  });
});
