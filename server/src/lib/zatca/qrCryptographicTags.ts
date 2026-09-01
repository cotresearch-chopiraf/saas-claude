// Derives real values for ZATCA QR tags 6-8 from an actual signed invoice
// — Slice 5 continuation, task #50.
//
// Before this module, qr.ts's buildPhase2QrPayload already refused to
// accept placeholder/fake values for tags 6-9 (they were required Buffer
// fields with no default) — but nothing in this codebase could actually
// COMPUTE real ones, because no real signature existed anywhere. Now that
// XadesZatcaSigner (task #48) produces a genuine signature, tags 6-8 are
// derivable directly from its output — no network call, no fabrication.
//
// TAG 9 REMAINS BLOCKED: it is "ZATCA's own technical CA signature over
// the cryptographic stamp's public key" (per the user-supplied baseline) —
// by definition something only ZATCA itself can produce, requiring a real
// Production CSID issuance response this environment cannot obtain. This
// module deliberately does not attempt tags 1-9 together; see
// buildZatcaQrTags1Through8 below, which is named to make that boundary
// explicit rather than implying a complete/production-ready QR payload.
//
// FORMAT NOTES (SPEC_TEXT_REQUIRED — not given by the user-supplied
// content, so the most consistent non-invented choice available is used
// and documented, never presented as verified):
//   - Tag 6 (invoice hash): the RAW SHA-256 bytes (32 bytes) of the same
//     canonicalized invoice hash computeCanonicalInvoiceHash already
//     computes for signing — decoded from its base64 form, not re-derived
//     by a separate code path.
//   - Tag 7 (ECDSA signature): the RAW signature bytes XadesZatcaSigner
//     already produced (WebCrypto's ECDSA output, IEEE P1363/r||s format)
//     — the exact same bytes embedded in the XML's ds:SignatureValue, not
//     re-signed or re-encoded.
//   - Tag 8 (ECDSA public key): the certificate's public key exported in
//     WebCrypto's "raw" EC point format (SEC1 uncompressed point:
//     0x04 || X || Y) — the standard, format-agnostic raw representation;
//     whether ZATCA expects this exact encoding (vs. DER/SPKI) is
//     unverified.

import "reflect-metadata";
import { webcrypto } from "node:crypto";
import * as x509 from "@peculiar/x509";
import { DOMParser } from "@xmldom/xmldom";
import { computeCanonicalInvoiceHash } from "./canonicalHash.js";
import { ZatcaInternalError } from "./errors.js";
import { buildZatcaQrPayload, ZATCA_QR_TAG } from "./qr.js";

const XMLDSIG_NS = "http://www.w3.org/2000/09/xmldsig#";

x509.cryptoProvider.set(webcrypto as unknown as Crypto);

export interface ZatcaQrCryptographicTags {
  invoiceXmlHash: Buffer;
  ecdsaSignature: Buffer;
  ecdsaPublicKey: Buffer;
}

interface DomLikeNode {
  textContent: string | null;
  getElementsByTagNameNS(ns: string, localName: string): ArrayLike<DomLikeNode>;
}

// Derives QR tags 6-8 from a real XadesZatcaSigner output. Throws
// ZatcaInternalError (never returns a placeholder) if the signed XML is
// missing what it needs — this should only happen if it is called on
// something other than genuine signer output.
export async function deriveZatcaQrCryptographicTags(signedXml: string): Promise<ZatcaQrCryptographicTags> {
  const doc = new DOMParser().parseFromString(signedXml, "text/xml") as unknown as DomLikeNode;
  if (!doc) throw new ZatcaInternalError("deriveZatcaQrCryptographicTags: failed to parse signed XML");

  const signatureValueEl = doc.getElementsByTagNameNS(XMLDSIG_NS, "SignatureValue")[0];
  const x509CertEl = doc.getElementsByTagNameNS(XMLDSIG_NS, "X509Certificate")[0];
  if (!signatureValueEl?.textContent) {
    throw new ZatcaInternalError("deriveZatcaQrCryptographicTags: signed XML has no ds:SignatureValue");
  }
  if (!x509CertEl?.textContent) {
    throw new ZatcaInternalError("deriveZatcaQrCryptographicTags: signed XML has no ds:X509Certificate");
  }

  const ecdsaSignature = Buffer.from(signatureValueEl.textContent, "base64");
  const invoiceXmlHash = Buffer.from(computeCanonicalInvoiceHash(signedXml), "base64");

  let cert: x509.X509Certificate;
  try {
    cert = new x509.X509Certificate(x509CertEl.textContent);
  } catch (err) {
    throw new ZatcaInternalError(
      `deriveZatcaQrCryptographicTags: embedded certificate does not parse as X.509: ${err instanceof Error ? err.message : "parse error"}`,
    );
  }
  const algorithm = cert.publicKey.algorithm as EcKeyAlgorithm;
  const publicKey = await cert.publicKey.export({ name: "ECDSA", namedCurve: algorithm.namedCurve } as EcKeyImportParams, ["verify"]);
  const rawPublicKey = await webcrypto.subtle.exportKey("raw", publicKey);

  return {
    invoiceXmlHash,
    ecdsaSignature,
    ecdsaPublicKey: Buffer.from(rawPublicKey),
  };
}

export interface ZatcaQrTags1Through8Input {
  sellerName: string;
  vatRegistrationNumber: string;
  timestamp: string;
  invoiceTotal: string;
  vatTotal: string;
  signedXml: string;
}

// Builds a QR payload carrying real tags 1-8 — deliberately NOT named
// "Phase 2" or "complete": tag 9 (ZATCA's own CA signature over the
// public key) is structurally impossible to include without a real
// Production CSID, and is never added by this function. Callers must not
// present a payload built by this function as a complete/production QR
// code — see file comment.
export async function buildZatcaQrTags1Through8(input: ZatcaQrTags1Through8Input): Promise<string> {
  const { invoiceXmlHash, ecdsaSignature, ecdsaPublicKey } = await deriveZatcaQrCryptographicTags(input.signedXml);

  return buildZatcaQrPayload([
    { tag: ZATCA_QR_TAG.sellerName, value: input.sellerName },
    { tag: ZATCA_QR_TAG.vatRegistrationNumber, value: input.vatRegistrationNumber },
    { tag: ZATCA_QR_TAG.timestamp, value: input.timestamp },
    { tag: ZATCA_QR_TAG.invoiceTotal, value: input.invoiceTotal },
    { tag: ZATCA_QR_TAG.vatTotal, value: input.vatTotal },
    { tag: ZATCA_QR_TAG.invoiceXmlHash, value: invoiceXmlHash },
    { tag: ZATCA_QR_TAG.ecdsaSignature, value: ecdsaSignature },
    { tag: ZATCA_QR_TAG.ecdsaPublicKey, value: ecdsaPublicKey },
  ]);
}
