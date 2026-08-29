import type { CountryComplianceAdapter, ComplianceRules, SeedVersionMeta } from "../types.js";

// SOURCES AND VERIFICATION STATUS — read before trusting any number below.
//
// The standard VAT rate (15%), the zero-rated/exempt category list, the
// mandatory/voluntary VAT registration thresholds, and the ZATCA e-invoicing
// (Fatoora) Phase 2 requirements were researched via web search on
// 2026-08-28 and cross-corroborated across multiple independent
// professional tax-advisory sources, all of which agreed with each other
// and with publicly known, long-stable facts (the 15% rate has been
// unchanged since July 2020). Several zatca.gov.sa document URLs were
// located and confirmed to exist via search (see sourceUrl), but this
// environment's network egress policy blocked directly fetching
// zatca.gov.sa to read the primary text — so despite the government-domain
// citation, `verificationStatus` below is honestly recorded as
// "unverified", not "verified": no one has actually read the primary
// source in this session. A human must verify directly against
// zatca.gov.sa before this pack is relied on for a real customer's tax
// filings — this is the disclaimer mission section 73 asks for, and it is
// true, not boilerplate.
//
// The withholding-tax table below deliberately excludes a "technical
// services" / "consulting services" category: independent sources gave
// conflicting rates for it (5% in some, 15% in others). Rather than guess
// between them, that category is simply not in the table — a lookup for it
// falls through to REVIEW REQUIRED in engine.ts, which is the correct
// behavior per mission section 41, not a bug.
//
// Zakat applicability is NOT set to true just because the country is Saudi
// Arabia. Saudi Zakat/income-tax treatment genuinely depends on the
// company's ownership structure (Saudi/GCC-owned share pays Zakat,
// foreign-owned share pays 20% corporate income tax, mixed ownership pays
// a blend) — information this onboarding flow does not collect. Guessing
// here would violate mission section 21 ("do not invent a zakat
// calculation") outright, so zakat.reviewRequired is true and the profile
// status this produces is "review_required", surfaced honestly in the
// Compliance Center rather than hidden.

const SOURCE_URL = "https://zatca.gov.sa/en/E-Invoicing/Pages/default.aspx";

const rules: ComplianceRules = {
  vat: {
    applicable: true,
    standardRatePercent: 15,
    categories: [
      { code: "standard_rate", label: { ar: "الأساسية", fr: "Taux standard", en: "Standard Rate" }, ratePercent: 15 },
      {
        code: "zero_rated",
        label: { ar: "نسبة صفر%", fr: "Taux zéro", en: "Zero-Rated" },
        ratePercent: 0,
      },
      {
        code: "exempt",
        label: { ar: "مُعفاة", fr: "Exonéré", en: "Exempt" },
        ratePercent: 0,
      },
    ],
  },
  withholding: {
    applicable: true,
    rules: [
      { vendorType: "non_resident", serviceCategory: "dividends", ratePercent: 5 },
      { vendorType: "non_resident", serviceCategory: "interest", ratePercent: 5 },
      { vendorType: "non_resident", serviceCategory: "royalties", ratePercent: 15 },
      { vendorType: "non_resident", serviceCategory: "management_fees", ratePercent: 20 },
    ],
  },
  zakat: {
    applicable: false,
    reviewRequired: true,
    notes:
      "Zakat vs. corporate income tax treatment in Saudi Arabia depends on the company's Saudi/GCC vs. foreign ownership share, which this platform's onboarding does not currently collect. Requires professional determination before this can be marked resolved.",
  },
  eInvoicing: {
    required: true,
    profile: "zatca_fatoora_phase2",
    notes:
      "ZATCA Fatoora is rolled out in waves by taxable-turnover threshold, not to every company on the same date — a company must confirm its own wave/deadline with ZATCA. Phase 2 requires XML (UBL 2.1) or PDF/A-3 with embedded XML, a QR code, a ZATCA-issued cryptographic stamp identifier (CSID), and real-time API integration with ZATCA's platform (Clearance model for B2B, Reporting model within 24h for B2C). This platform's current PDF generator produces a human-readable invoice only — it is NOT a ZATCA-compliant e-invoice submission on its own; see the implementation report for why real Fatoora integration is out of scope for this phase.",
  },
  invoice: {
    requiredFields: ["vatNumber", "clientTaxId"],
    bilingualRequired: true,
  },
  localization: {
    currency: "SAR",
    language: "ar",
    direction: "rtl",
    dateFormat: "DD/MM/YYYY",
  },
  identifiers: [
    {
      type: "vat_number",
      label: { ar: "الرقم الضريبي", fr: "Numéro de TVA", en: "VAT Number" },
      required: true,
    },
    {
      type: "commercial_registration",
      label: { ar: "السجل التجاري", fr: "Registre du commerce", en: "Commercial Registration" },
      required: true,
    },
  ],
};

const seedVersionMeta: SeedVersionMeta = {
  version: "2026.08",
  effectiveFrom: "2020-07-01", // the 15% rate has been in effect since this date
  sourceUrl: SOURCE_URL,
  sourceType: "official_government",
  publicationDate: "2020-07-01",
  verificationStatus: "unverified",
};

export const saudiArabiaPack: CountryComplianceAdapter = {
  countryCode: "SA",
  displayName: { ar: "المملكة العربية السعودية", fr: "Arabie Saoudite", en: "Saudi Arabia" },
  getSeedRules: () => rules,
  getSeedVersionMeta: () => seedVersionMeta,
};
