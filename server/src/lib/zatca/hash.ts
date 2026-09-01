// ZATCA document hashing — SHA-256, Base64-encoded, for Previous Invoice
// Hash (PIH) chaining and the QR code's XML-hash tag.
//
// Pure functions only: no persistence, no chain-state lookup. Deciding
// WHICH previous document's hash to pass in (and storing this document's
// own resulting hash for the next one in sequence) is Phase 4/5 —
// schema-gated, out of scope for this slice.
//
// VERIFICATION STATUS: "SHA-256 of the invoice, Base64-encoded" and "the
// first document's PIH is Base64(SHA-256(\"0\"))" are cross-corroborated
// across many independent secondary sources describing ZATCA's Security
// Features Implementation Standard — unverified against the primary
// document (blocked from fetching zatca.gov.sa in this environment).
//
// This module is the raw hash PRIMITIVE only (plain SHA-256 + Base64 of
// whatever bytes it's given) — used for the PIH genesis value and any
// generic chaining need. It intentionally does NOT implement ZATCA's
// specific invoice-hash contract (remove UBLExtensions/QR reference/
// Signature, canonicalize, then hash) — that real, XML-aware
// canonicalization lives in canonicalHash.ts's computeCanonicalInvoiceHash,
// which is what routes/zatca.ts actually calls when hashing a real
// invoice document. See docs/zatca/SLICE5_OFFICIAL_SPEC_VERIFICATION.md.

import { createHash } from "crypto";

export function computeDocumentHash(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("base64");
}

// Cross-corroborated genesis value for the very first document in a
// company's PIH chain — Base64(SHA-256("0")).
export const GENESIS_PREVIOUS_INVOICE_HASH = computeDocumentHash("0");
