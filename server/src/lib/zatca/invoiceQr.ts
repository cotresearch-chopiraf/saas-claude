// P0-5 pre-launch hardening — ZATCA Phase 1 QR wiring for invoice output.
//
// Deliberately Phase 1 only (tags 1-5: seller name, VAT number, timestamp,
// invoice total, VAT total), never Phase 2 (tags 6-9): Phase 2 requires a
// real ZATCA clearance/reporting response and a real Production CSID's
// certificate signature (tag 9), and per the P0-4 pre-launch audit finding
// this environment has never completed a real ZATCA Sandbox round-trip —
// there is no cryptographic material to put in tags 6-9 without
// fabricating it, which qr.ts's buildPhase2QrPayload correctly refuses to
// accept as optional. Phase 1 is the correct, honest, currently-available
// format: it requires no ZATCA interaction at all, is derived entirely
// from an invoice's own already-authoritative data, and is what every VAT
// invoice has been legally required to carry since ZATCA's e-invoicing
// Generation phase (independent of Integration-phase onboarding status).
//
// Split into a pure payload builder (unit-testable without an image
// decoder) and a thin async image-rendering wrapper, so "does the payload
// contain the right tags/values" can be asserted directly against the
// TLV bytes rather than round-tripping through a rendered PNG.

import QRCode from "qrcode";
import { computeTotals } from "../money.js";
import { buildPhase1QrPayload } from "./qr.js";

export interface InvoiceQrInput {
  sellerName: string;
  // null when the company has not configured a ZATCA VAT number yet
  // (routes/zatca.ts's tenant identity settings, stored in
  // company_tax_identifiers — NEVER company.taxId, which is a generic,
  // unvalidated free-text field for the printed letterhead, not a
  // ZATCA-formatted VAT registration number).
  vatNumber: string | null;
  // Date-only (YYYY-MM-DD) — no time-of-day is captured anywhere in this
  // data model for an invoice's issue date.
  issueDate: string;
  itemAmounts: number[];
  taxRatePercent: number;
}

// Returns null — never a QR built from missing/placeholder data — when
// there is no configured VAT number to put in it. Pure and synchronous:
// safe to call from a test without touching the QR-image renderer.
export function buildInvoiceZatcaQrPayload(input: InvoiceQrInput): string | null {
  if (!input.vatNumber) return null;

  // Same shared, single computeTotals call every other invoice total in
  // this codebase goes through — the QR's total/VAT figures are therefore
  // guaranteed identical to what the PDF itself displays, by construction,
  // not by keeping two calculations in sync by hand. If the underlying
  // item amounts or tax rate change, this payload changes too, since it is
  // always recomputed from the current authoritative inputs, never cached.
  const { taxAmount, total } = computeTotals(input.itemAmounts, input.taxRatePercent);

  // ZATCA's TLV total/VAT fields are plain, locale-invariant decimal
  // strings (e.g. "1150.00") — never the thousands-separated,
  // locale-formatted string the PDF's own display column uses.
  const fixed2 = (n: number) => n.toFixed(2);

  // Expressed as ISO 8601 at midnight UTC rather than inventing a
  // time-of-day MIDAD never recorded.
  const timestamp = `${input.issueDate}T00:00:00Z`;

  return buildPhase1QrPayload({
    sellerName: input.sellerName,
    vatRegistrationNumber: input.vatNumber,
    timestamp,
    invoiceTotal: fixed2(total),
    vatTotal: fixed2(taxAmount),
  });
}

// Renders the payload above to a scannable PNG data URI. Returns null
// under the identical condition buildInvoiceZatcaQrPayload returns null —
// callers never need to duplicate that check.
export async function buildInvoiceQrCodeDataUri(input: InvoiceQrInput): Promise<string | null> {
  const payload = buildInvoiceZatcaQrPayload(input);
  if (!payload) return null;
  return QRCode.toDataURL(payload, { margin: 1, width: 220 });
}
