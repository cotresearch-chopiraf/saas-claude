import type { CountryComplianceAdapter, ComplianceRules, SeedVersionMeta } from "../types.js";

// SOURCES AND VERIFICATION STATUS — researched via web search on
// 2026-08-28, cross-corroborated across multiple independent professional
// tax-advisory sources. The National Bureau for Revenue's own domain could
// not be directly fetched in this environment. `verificationStatus` is
// "unverified" — a human must confirm directly against the NBR before
// relying on this for real filings.
//
// Note directly relevant to this platform's target market: construction is
// among the categories reported as zero-rated in Bahrain (alongside basic
// food, healthcare, education, local transport, and exports) — worth a
// contractor's own professional confirmation before assuming it applies to
// every service a specific project provides, but flagged here rather than
// left undocumented.
//
// Bahrain currently has no withholding tax on payments to non-residents
// (dividends, interest, royalties), and a draft corporate income tax law
// (10%, referred to the legislature December 2025) was still pending as of
// this research — not yet in force, so not modeled as an active rule here.
// E-invoicing is expected but has no published technical format or
// confirmed mandatory date yet.

const SOURCE_URL = "https://www.nbr.gov.bh/";

const rules: ComplianceRules = {
  vat: {
    applicable: true,
    standardRatePercent: 10,
    categories: [
      { code: "standard_rate", label: { ar: "الأساسية", fr: "Taux standard", en: "Standard Rate" }, ratePercent: 10 },
      {
        code: "zero_rated",
        label: { ar: "نسبة صفر%", fr: "Taux zéro", en: "Zero-Rated" },
        ratePercent: 0,
      },
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
    notes: "Not a Bahraini tax obligation.",
  },
  eInvoicing: {
    required: false,
    profile: null,
    notes:
      "The National Bureau for Revenue has signaled a phased e-invoicing mandate (large taxpayers first) but had not published a technical format or confirmed mandatory date as of this research.",
  },
  invoice: {
    requiredFields: ["vatNumber"],
    bilingualRequired: false,
  },
  localization: {
    currency: "BHD",
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
  ],
};

const seedVersionMeta: SeedVersionMeta = {
  version: "2026.08",
  effectiveFrom: "2022-01-01", // the 5% -> 10% rate rise took effect this date
  sourceUrl: SOURCE_URL,
  sourceType: "official_government",
  publicationDate: "2022-01-01",
  verificationStatus: "unverified",
};

export const bahrainPack: CountryComplianceAdapter = {
  countryCode: "BH",
  displayName: { ar: "البحرين", fr: "Bahreïn", en: "Bahrain" },
  getSeedRules: () => rules,
  getSeedVersionMeta: () => seedVersionMeta,
};
