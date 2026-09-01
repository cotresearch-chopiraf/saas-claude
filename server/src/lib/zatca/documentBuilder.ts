// Bridges a real MIDAD invoice (server/src/db/schema.ts's invoices/
// invoiceItems, read via routes/invoices.ts's existing tenant-scoped
// lookup — never a second invoice model) into the Slice 1 pure document
// engine's CanonicalZatcaDocument shape (lib/zatca/types.ts). This is the
// ONLY place that mapping happens; everything downstream (xmlBuilder.ts,
// hash.ts, qr.ts, validation.ts) is reused completely unmodified.
//
// KNOWN LIMITATIONS (documented here rather than silently guessed):
//   - MIDAD's invoice model has exactly one tax rate per invoice (see
//     lib/money.ts's computeTotals(itemAmounts, taxRatePercent) — no
//     per-line rate exists), so every line and the single tax subtotal
//     bucket below share that one rate. This is a real MIDAD data-model
//     fact, not a ZATCA guess.
//   - companies.address / invoices.clientAddress are single free-text
//     fields; ZATCA's structured PostalAddress wants distinct
//     street/building/city/postal components MIDAD does not capture
//     separately. The whole string is placed in streetName and
//     countryCode is asserted as "SA" (ZATCA is Saudi-only) — this is a
//     genuine gap, not a fabrication, and is called out again in the
//     Slice 4 final report.
//   - invoices has no stored issue TIME (only issueDate) — issueTime is a
//     required caller-supplied input (the real clock time at document
//     preparation), passed through unchanged rather than computed here,
//     so a resubmission can regenerate byte-identical XML later (see this
//     file's BuildDocumentInput.issueTime comment).
//   - subtype is derived as "standard" (B2B/Clearance) when the invoice
//     has a clientTaxId (a registered business buyer) and "simplified"
//     (B2C/Reporting) otherwise — a MIDAD-side business rule within our
//     own control, not a ZATCA API detail.

import { computeTotals, roundMoney } from "../money.js";
import type {
  CanonicalZatcaDocument,
  ZatcaInvoiceLine,
  ZatcaTaxCategoryCode,
  ZatcaTaxSubtotal,
} from "./types.js";

export interface InvoiceForZatcaDocument {
  invoiceNumber: string;
  clientName: string;
  clientAddress: string | null;
  clientTaxId: string | null;
  taxRatePercent: string;
  taxCategory: string | null;
  issueDate: string;
}

export interface InvoiceItemForZatcaDocument {
  description: string;
  amount: string;
}

// Field names deliberately match domain/config.ts's ZatcaTenantIdentity
// exactly, so a route can pass getZatcaTenantIdentity()'s result straight
// through without an adapter step.
export interface SupplierIdentityForZatcaDocument {
  legalName: string;
  address: string | null;
  vatNumber: string | null;
  commercialRegistration: string | null;
}

export interface BuildDocumentInput {
  invoice: InvoiceForZatcaDocument;
  items: InvoiceItemForZatcaDocument[];
  supplier: SupplierIdentityForZatcaDocument;
  zatcaUuid: string;
  invoiceCounterValue: number;
  previousInvoiceHash: string;
  // Deliberately an explicit input, never `new Date()` computed inside
  // this function — a submission is prepared once but may be regenerated
  // byte-for-byte at submit time (see routes/zatca.ts's /submit handler,
  // which passes the ORIGINAL submission row's createdAt rather than the
  // current time) so the regenerated XML hashes identically to what was
  // already chained into the EGS unit's PIH pointer.
  issueTime: string; // HH:mm:ss
}

// MIDAD's own taxCategory free-text values (set by lib/compliance/*, see
// routes/invoices.ts) map onto the EN16931/UNCL5305 subset ZATCA uses.
// Defaults to Standard rated when unset or unrecognized — the same
// "standard_rate" default routes/invoices.ts itself uses when no
// compliance profile is configured.
export function mapZatcaTaxCategory(taxCategory: string | null, taxRatePercent: number): ZatcaTaxCategoryCode {
  if (taxRatePercent === 0) {
    if (taxCategory?.toLowerCase().includes("exempt")) return "E";
    return "Z";
  }
  return "S";
}

export function buildCanonicalDocumentFromInvoice(input: BuildDocumentInput): CanonicalZatcaDocument {
  const { invoice, items, supplier, zatcaUuid, invoiceCounterValue, previousInvoiceHash, issueTime } = input;
  const taxRatePercent = Number(invoice.taxRatePercent);
  const itemAmounts = items.map((i) => Number(i.amount));
  const totals = computeTotals(itemAmounts, taxRatePercent);
  const taxCategoryCode = mapZatcaTaxCategory(invoice.taxCategory, taxRatePercent);

  const lines: ZatcaInvoiceLine[] = items.map((item, index) => {
    const amount = roundMoney(Number(item.amount));
    return {
      id: String(index + 1),
      description: item.description,
      quantity: 1,
      unitPrice: amount,
      lineExtensionAmount: amount,
      taxCategoryCode,
      taxRatePercent,
      taxAmount: roundMoney((amount * taxRatePercent) / 100),
    };
  });

  const taxSubtotals: ZatcaTaxSubtotal[] = [
    {
      taxCategoryCode,
      taxRatePercent,
      taxableAmount: totals.subtotal,
      taxAmount: totals.taxAmount,
    },
  ];

  const subtype: CanonicalZatcaDocument["subtype"] = invoice.clientTaxId ? "standard" : "simplified";

  return {
    documentTypeCode: "388",
    subtype,
    uuid: zatcaUuid,
    id: invoice.invoiceNumber,
    issueDate: invoice.issueDate,
    issueTime,
    currencyCode: "SAR",
    supplier: {
      registrationName: supplier.legalName,
      vatNumber: supplier.vatNumber ?? undefined,
      commercialRegistrationNumber: supplier.commercialRegistration ?? undefined,
      address: { countryCode: "SA", streetName: supplier.address ?? undefined },
    },
    customer: {
      registrationName: invoice.clientName,
      vatNumber: invoice.clientTaxId ?? undefined,
      address: invoice.clientAddress ? { countryCode: "SA", streetName: invoice.clientAddress } : undefined,
    },
    previousInvoiceHash,
    invoiceCounterValue,
    lines,
    taxSubtotals,
    taxExclusiveAmount: totals.subtotal,
    totalTaxAmount: totals.taxAmount,
    taxInclusiveAmount: totals.total,
    payableAmount: totals.total,
  };
}
