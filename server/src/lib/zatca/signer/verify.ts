// Local (offline) verification of a XadesZatcaSigner-produced signature —
// Slice 5 continuation, task #49.
//
// This is entirely self-contained: everything it checks is already inside
// signedXml (the embedded certificate, the SignedInfo digests, the
// signature value) — it never needs the private key, the original
// credential, or any network call. Its purpose is to catch a MIDAD-side
// signing bug BEFORE a signed document is ever sent to ZATCA, per the
// user-supplied requirement: "any failure -> persist validation_failed
// with a safe reason, never call the provider." It does NOT prove ZATCA
// itself will accept the document — only that the signature is internally
// consistent and cryptographically valid against the embedded certificate.
//
// Checks performed, matching the task's own list: well-formed XML, hash
// recompute (the "invoiceSignedData" Reference against a fresh
// computeCanonicalInvoiceHash of the same document), SignedProperties
// digest recompute, certificate digest match (the embedded X509Certificate
// against SignedProperties' CertDigest), issuer/serial consistency, the
// certificate's validity period against the asserted SigningTime,
// cert/key relationship (the signature verifies against the embedded
// certificate's own public key via WebCrypto's ECDSA verify), and presence
// of every required XAdES/XMLDSig element.

import "reflect-metadata";
import { createHash, webcrypto } from "node:crypto";
import * as x509 from "@peculiar/x509";
import { C14nCanonicalization } from "xml-crypto";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { computeCanonicalInvoiceHash } from "../canonicalHash.js";

const XMLDSIG_NS = "http://www.w3.org/2000/09/xmldsig#";
const XADES_NS = "http://uri.etsi.org/01903/v1.3.2#";

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

export interface VerifyZatcaSignatureResult {
  valid: boolean;
  // Safe for UI/log/audit — never includes raw XML content, key material,
  // or anything beyond a short, fixed description of which check failed.
  reason?: string;
}

function sha256Base64(input: Buffer): string {
  return createHash("sha256").update(input).digest("base64");
}

function c14nFragment(wrapperNamespaceAttrs: string, fragmentXml: string): string {
  const wrapped = `<root ${wrapperNamespaceAttrs}>${fragmentXml}</root>`;
  const doc = new DOMParser().parseFromString(wrapped, "text/xml");
  const wrapperEl = (doc as unknown as { documentElement: { firstChild: unknown } }).documentElement;
  return new C14nCanonicalization().process(wrapperEl.firstChild as unknown as Node, {});
}

interface DomLikeNode {
  textContent: string | null;
  getAttribute?(name: string): string | null;
  getElementsByTagNameNS(ns: string, localName: string): ArrayLike<DomLikeNode>;
}

function one(parent: DomLikeNode, ns: string, localName: string): DomLikeNode | undefined {
  return parent.getElementsByTagNameNS(ns, localName)[0];
}

function serializeElement(node: DomLikeNode): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new XMLSerializer().serializeToString(node as any);
}

export async function verifyZatcaSignature(signedXml: string): Promise<VerifyZatcaSignatureResult> {
  let doc: DomLikeNode;
  try {
    const parsed = new DOMParser().parseFromString(signedXml, "text/xml");
    doc = parsed as unknown as DomLikeNode;
  } catch (err) {
    return { valid: false, reason: `malformed XML: ${err instanceof Error ? err.message : "parse error"}` };
  }
  if (!doc) return { valid: false, reason: "malformed XML: parser returned no document" };

  const signature = one(doc, XMLDSIG_NS, "Signature");
  if (!signature) return { valid: false, reason: "missing ds:Signature element" };

  const signedInfo = one(signature, XMLDSIG_NS, "SignedInfo");
  if (!signedInfo) return { valid: false, reason: "missing ds:SignedInfo element" };

  const signatureValueEl = one(signature, XMLDSIG_NS, "SignatureValue");
  if (!signatureValueEl?.textContent) return { valid: false, reason: "missing ds:SignatureValue element" };

  const x509CertEl = one(signature, XMLDSIG_NS, "X509Certificate");
  if (!x509CertEl?.textContent) return { valid: false, reason: "missing ds:KeyInfo/X509Data/X509Certificate element" };

  const qualifyingProperties = one(signature, XADES_NS, "QualifyingProperties");
  if (!qualifyingProperties) return { valid: false, reason: "missing xades:QualifyingProperties element" };

  const signedProperties = one(qualifyingProperties, XADES_NS, "SignedProperties");
  if (!signedProperties) return { valid: false, reason: "missing xades:SignedProperties element" };

  const signingTime = one(signedProperties, XADES_NS, "SigningTime");
  if (!signingTime?.textContent) return { valid: false, reason: "missing xades:SigningTime element" };

  const certDigestValueEl = one(signedProperties, XMLDSIG_NS, "DigestValue");
  const issuerNameEl = one(signedProperties, XMLDSIG_NS, "X509IssuerName");
  const serialNumberEl = one(signedProperties, XMLDSIG_NS, "X509SerialNumber");
  if (!certDigestValueEl?.textContent || !issuerNameEl?.textContent || !serialNumberEl?.textContent) {
    return { valid: false, reason: "missing xades:SigningCertificate/Cert/CertDigest or IssuerSerial fields" };
  }

  const references = Array.from(signedInfo.getElementsByTagNameNS(XMLDSIG_NS, "Reference"));
  const invoiceRef = references.find((r) => r.getAttribute?.("Id") === "invoiceSignedData");
  const signedPropsRef = references.find((r) => r.getAttribute?.("URI") === "#xades-SignedProperties");
  if (!invoiceRef) return { valid: false, reason: "missing ds:Reference[Id=invoiceSignedData] in SignedInfo" };
  if (!signedPropsRef) return { valid: false, reason: "missing ds:Reference[URI=#xades-SignedProperties] in SignedInfo" };

  const invoiceDigestValueEl = one(invoiceRef, XMLDSIG_NS, "DigestValue");
  const signedPropsDigestValueEl = one(signedPropsRef, XMLDSIG_NS, "DigestValue");
  if (!invoiceDigestValueEl?.textContent || !signedPropsDigestValueEl?.textContent) {
    return { valid: false, reason: "missing DigestValue in one of SignedInfo's References" };
  }

  // 1) Invoice hash recompute — computeCanonicalInvoiceHash strips
  // ext:UBLExtensions (which contains this very Signature) before hashing,
  // so calling it on the SIGNED document reproduces exactly the hash the
  // signer computed on the ORIGINAL unsigned document — no need to keep
  // the pre-signing XML around separately.
  let recomputedInvoiceHash: string;
  try {
    recomputedInvoiceHash = computeCanonicalInvoiceHash(signedXml);
  } catch (err) {
    return { valid: false, reason: `failed to recompute invoice hash: ${err instanceof Error ? err.message : "unknown error"}` };
  }
  if (recomputedInvoiceHash !== invoiceDigestValueEl.textContent) {
    return { valid: false, reason: "invoice content does not match the signed invoiceSignedData digest" };
  }

  // 2) SignedProperties digest recompute.
  const signedPropertiesXml = serializeElement(signedProperties);
  const recomputedSignedPropsDigest = sha256Base64(
    Buffer.from(c14nFragment(`xmlns:xades="${XADES_NS}" xmlns:ds="${XMLDSIG_NS}"`, signedPropertiesXml), "utf8"),
  );
  if (recomputedSignedPropsDigest !== signedPropsDigestValueEl.textContent) {
    return { valid: false, reason: "SignedProperties digest does not match the signed xades-SignedProperties reference" };
  }

  // 3) Certificate parse + digest match + issuer/serial consistency.
  let cert: x509.X509Certificate;
  try {
    cert = new x509.X509Certificate(x509CertEl.textContent);
  } catch (err) {
    return { valid: false, reason: `embedded certificate does not parse as X.509: ${err instanceof Error ? err.message : "parse error"}` };
  }
  const certDerBuffer = Buffer.from(cert.rawData);
  const actualCertDigest = sha256Base64(certDerBuffer);
  if (actualCertDigest !== certDigestValueEl.textContent) {
    return { valid: false, reason: "embedded certificate digest does not match SignedProperties' CertDigest" };
  }
  const actualSerialDecimal = BigInt(`0x${cert.serialNumber || "0"}`).toString(10);
  if (actualSerialDecimal !== serialNumberEl.textContent) {
    return { valid: false, reason: "embedded certificate serial number does not match SignedProperties' X509SerialNumber" };
  }
  if (cert.issuer !== issuerNameEl.textContent) {
    return { valid: false, reason: "embedded certificate issuer does not match SignedProperties' X509IssuerName" };
  }

  // 3.5) Certificate validity period — the SigningTime asserted inside the
  // signature itself must fall within the embedded certificate's own
  // [notBefore, notAfter] window. A signature claiming to have been made
  // outside that window is never trustworthy, regardless of whether the
  // cryptographic math otherwise checks out.
  const signingTimeDate = new Date(signingTime.textContent!);
  if (Number.isNaN(signingTimeDate.getTime())) {
    return { valid: false, reason: "xades:SigningTime is not a valid date" };
  }
  if (signingTimeDate < cert.notBefore || signingTimeDate > cert.notAfter) {
    return { valid: false, reason: "SigningTime falls outside the embedded certificate's validity period" };
  }

  // 4) Cryptographic verification: the signature must verify against the
  // embedded certificate's own public key over the actual SignedInfo
  // canonical bytes.
  let publicKey: CryptoKey;
  try {
    const algorithm = cert.publicKey.algorithm as EcKeyAlgorithm;
    publicKey = await cert.publicKey.export({ name: "ECDSA", namedCurve: algorithm.namedCurve } as EcKeyImportParams, ["verify"]);
  } catch (err) {
    return { valid: false, reason: `failed to import the embedded certificate's public key: ${err instanceof Error ? err.message : "unknown error"}` };
  }

  const signedInfoXml = serializeElement(signedInfo);
  const canonicalSignedInfo = c14nFragment(`xmlns:ds="${XMLDSIG_NS}"`, signedInfoXml);
  let signatureBytes: Buffer;
  try {
    signatureBytes = Buffer.from(signatureValueEl.textContent, "base64");
  } catch {
    return { valid: false, reason: "SignatureValue is not valid base64" };
  }

  let cryptoValid: boolean;
  try {
    cryptoValid = await webcrypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      signatureBytes,
      Buffer.from(canonicalSignedInfo, "utf8"),
    );
  } catch (err) {
    return { valid: false, reason: `signature verification threw: ${err instanceof Error ? err.message : "unknown error"}` };
  }
  if (!cryptoValid) {
    return { valid: false, reason: "signature does not cryptographically verify against the embedded certificate" };
  }

  return { valid: true };
}
