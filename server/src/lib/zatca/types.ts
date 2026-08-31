// MIDAD ZATCA document engine — canonical input types.
//
// Deliberately NOT the same shape as db/schema.ts's `invoices`/`invoiceItems`
// tables: this is a translation layer. Nothing here reads from or writes to
// the database, and nothing in routes/invoices.ts or routes/quotes.ts calls
// into this module yet — see docs/ZATCA_IMPLEMENTATION_STATUS.md for why
// that wiring is a later, schema-gated slice, not this one.
//
// VERIFICATION STATUS: field presence/shape here follows the UBL 2.1 /
// EN16931 international standard (stable, publicly documented, not
// ZATCA-specific) plus ZATCA-specific customizations (InvoiceTypeCode name
// attribute, AdditionalDocumentReference usage for ICV/PIH) that were
// cross-corroborated across many independent secondary sources describing
// the official ZATCA Electronic Invoice XML Implementation Standard — this
// environment's network policy blocks fetching zatca.gov.sa directly, so
// nobody has read the primary XSD/Schematron in this session. Treat every
// ZATCA-specific field name/placement below as "unverified, cross-source
// consensus" until checked against the real SDK files, exactly like the
// existing lib/compliance/packs/saudiArabia.ts disclaimer.

// UNCL5305-derived tax category codes (EN16931 standard subset — not a
// ZATCA invention): Standard rate, Zero rated, Exempt, Out of scope.
export type ZatcaTaxCategoryCode = "S" | "Z" | "E" | "O";

// UBL/ZATCA document type codes: 388 = Tax Invoice (standard or simplified
// depending on subtype), 381 = Credit Note, 383 = Debit Note.
export type ZatcaDocumentTypeCode = "388" | "381" | "383";

// The single most consistently cross-corroborated ZATCA-specific fact in
// this research: subtype "standard" (B2B, subject to Clearance) encodes as
// InvoiceTypeCode name attribute "0100000"; "simplified" (B2C, subject to
// Reporting within 24h) encodes as "0200000".
export type ZatcaInvoiceSubtype = "standard" | "simplified";

export interface ZatcaPartyAddress {
  streetName?: string;
  buildingNumber?: string;
  additionalStreetName?: string;
  citySubdivisionName?: string;
  cityName?: string;
  postalZone?: string;
  countrySubentity?: string;
  // ISO 3166-1 alpha-2 (e.g. "SA") — required by UBL's PostalAddress.
  countryCode: string;
}

export interface ZatcaParty {
  registrationName: string;
  vatNumber?: string;
  commercialRegistrationNumber?: string;
  address?: ZatcaPartyAddress;
}

export interface ZatcaInvoiceLine {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number;
  // quantity * unitPrice before tax, matching money.ts's roundMoney() precision.
  lineExtensionAmount: number;
  taxCategoryCode: ZatcaTaxCategoryCode;
  taxRatePercent: number;
  taxAmount: number;
}

export interface ZatcaTaxSubtotal {
  taxCategoryCode: ZatcaTaxCategoryCode;
  taxRatePercent: number;
  taxableAmount: number;
  taxAmount: number;
}

// Credit/debit notes only (381/383) — the mandatory link back to the
// original invoice. Cross-corroborated as living in cac:BillingReference /
// cac:InvoiceDocumentReference; the note's own PIH chains to whatever
// document preceded it in the company's sequence, NOT necessarily to this
// referenced invoice — a distinct field, not folded into the reference.
export interface ZatcaBillingReference {
  invoiceId: string;
  issueDate: string; // YYYY-MM-DD
}

export interface CanonicalZatcaDocument {
  documentTypeCode: ZatcaDocumentTypeCode;
  subtype: ZatcaInvoiceSubtype;
  // A ZATCA submission UUID — deliberately a distinct concept from MIDAD's
  // internal invoices.id primary key (see docs/ZATCA_IMPLEMENTATION_STATUS.md
  // Phase 4 notes on why reusing the PK directly was rejected).
  uuid: string;
  // The human-facing document number (MIDAD's existing invoiceNumber/
  // quoteNumber convention, or a future credit/debit-note number).
  id: string;
  issueDate: string; // YYYY-MM-DD
  issueTime: string; // HH:mm:ss
  currencyCode: string; // ISO 4217, e.g. "SAR"
  supplier: ZatcaParty;
  customer?: ZatcaParty;
  billingReference?: ZatcaBillingReference;
  note?: string;
  // Base64 SHA-256 of the preceding document in the company's chain.
  // Genesis value (first document ever) is cross-corroborated as
  // Base64(SHA-256("0")) — see hash.ts's GENESIS_PREVIOUS_INVOICE_HASH.
  previousInvoiceHash: string;
  // Invoice Counter Value — a strictly sequential, gap-free, per-EGS-unit
  // counter. Deliberately NOT the same value as MIDAD's existing
  // invoiceNumber (see lib/numbering.ts): that counter can gap on a rolled
  // back transaction (documented in the ZATCA discovery report), which
  // would violate ICV's no-gap requirement. This field's real persistence
  // design is Phase 4/5 — out of scope for this pure-function slice.
  invoiceCounterValue: number;
  lines: ZatcaInvoiceLine[];
  taxSubtotals: ZatcaTaxSubtotal[];
  taxExclusiveAmount: number;
  totalTaxAmount: number;
  taxInclusiveAmount: number;
  payableAmount: number;
}
