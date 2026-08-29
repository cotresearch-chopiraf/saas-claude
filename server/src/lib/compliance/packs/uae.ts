import type { CountryComplianceAdapter, ComplianceRules, SeedVersionMeta } from "../types.js";

// SOURCES AND VERIFICATION STATUS — same caveat as saudiArabia.ts: the
// standard VAT rate (5%, unchanged since January 2018), the mandatory/
// voluntary registration thresholds, the zero-rated/exempt categories, and
// the phased Peppol PINT-AE e-invoicing mandate were researched via web
// search on 2026-08-28 and cross-corroborated across multiple independent
// professional tax-advisory sources. The primary source domains (tax.gov.ae
// for the Federal Tax Authority, u.ae/mof.gov.ae for the Ministry of
// Finance) could not be directly fetched in this environment (network
// egress policy) — so despite citing the official domain,
// `verificationStatus` is honestly "unverified", not "verified". A human
// must confirm directly against tax.gov.ae before this is relied on for a
// real customer's filings.
//
// UAE corporate tax (9%, with Small Business Relief for qualifying
// residents under AED 3M revenue through end of 2026) is a real UAE tax
// but is NOT modeled here: it is an annual net-income tax filed separately
// from VAT, not a per-transaction rate this invoice-level engine computes
// — the same scope boundary already drawn for Saudi Zakat/corporate tax.
//
// Withholding tax is genuinely 0% across essentially all categories under
// current UAE Cabinet Decision — this is not an omission or a
// REVIEW_REQUIRED case, it is the actual current rule, hence
// `withholding.applicable: false` with an explicit empty rule set rather
// than zakat.ts-style uncertainty.

const SOURCE_URL = "https://mof.gov.ae/e-invoicing/";

const rules: ComplianceRules = {
  vat: {
    applicable: true,
    standardRatePercent: 5,
    categories: [
      { code: "standard_rate", label: { ar: "الأساسية", fr: "Taux standard", en: "Standard Rate" }, ratePercent: 5 },
      { code: "zero_rated", label: { ar: "نسبة صفر%", fr: "Taux zéro", en: "Zero-Rated" }, ratePercent: 0 },
      { code: "exempt", label: { ar: "مُعفاة", fr: "Exonéré", en: "Exempt" }, ratePercent: 0 },
    ],
  },
  withholding: {
    applicable: false,
    rules: [],
  },
  zakat: {
    applicable: false,
    reviewRequired: false,
    notes: "Zakat is not a UAE federal tax obligation for corporate entities in the way it is in Saudi Arabia.",
  },
  eInvoicing: {
    required: true,
    profile: "uae_peppol_pint_ae",
    notes:
      "Phased mandate under UAE Ministry of Finance Ministerial Decisions 243/244 of 2025: voluntary pilot from 1 July 2026; mandatory from 1 January 2027 for businesses with AED 50M+ revenue (via an Accredited Service Provider, appointed by 30 October 2026), and from 1 July 2027 for remaining businesses. Structured XML per the Peppol PINT-AE schema, transmitted through an ASP under a decentralized Continuous Transaction Control model — this platform's current PDF generator is not a compliant submission on its own, same caveat as the Saudi pack.",
  },
  invoice: {
    requiredFields: ["vatNumber"],
    bilingualRequired: false,
  },
  localization: {
    currency: "AED",
    language: "ar",
    direction: "rtl",
    dateFormat: "DD/MM/YYYY",
  },
  identifiers: [
    {
      type: "vat_number",
      label: { ar: "الرقم الضريبي (TRN)", fr: "Numéro de TVA (TRN)", en: "Tax Registration Number (TRN)" },
      required: true,
    },
  ],
};

const seedVersionMeta: SeedVersionMeta = {
  version: "2026.08",
  effectiveFrom: "2018-01-01",
  sourceUrl: SOURCE_URL,
  sourceType: "official_government",
  publicationDate: "2018-01-01",
  verificationStatus: "unverified",
};

export const uaePack: CountryComplianceAdapter = {
  countryCode: "AE",
  displayName: { ar: "الإمارات العربية المتحدة", fr: "Émirats Arabes Unis", en: "United Arab Emirates" },
  getSeedRules: () => rules,
  getSeedVersionMeta: () => seedVersionMeta,
};
