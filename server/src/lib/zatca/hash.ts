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
// document (blocked from fetching zatca.gov.sa in this environment). The
// EXACT bytes ZATCA expects to be hashed (e.g. whether certain UBL
// extension/signature elements are excluded before hashing) could not be
// confirmed and is intentionally left as the caller's responsibility — see
// docs/ZATCA_IMPLEMENTATION_STATUS.md.

import { createHash } from "crypto";

export function computeDocumentHash(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("base64");
}

// Cross-corroborated genesis value for the very first document in a
// company's PIH chain — Base64(SHA-256("0")).
export const GENESIS_PREVIOUS_INVOICE_HASH = computeDocumentHash("0");
