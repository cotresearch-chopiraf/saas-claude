import type { CountryComplianceAdapter, ComplianceRules, SeedVersionMeta } from "../types.js";

// SOURCES AND VERIFICATION STATUS — researched via web search on
// 2026-08-28, cross-corroborated across multiple independent professional
// tax-advisory sources. The Oman Tax Authority's own domain
// (tms.taxoman.gov.om) could not be directly fetched in this environment.
// `verificationStatus` is "unverified" — a human must confirm directly
// against the OTA before relying on this for real filings.
//
// Withholding tax on dividends and interest to non-resident investors was
// suspended by Royal Directive on 11 January 2023 and is modeled here as
// 0% for those categories (a real, sourced fact, not an omission);
// royalties/management fees/services to a non-resident without a
// permanent establishment in Oman remain subject to 10%.

const SOURCE_URL = "https://tms.taxoman.gov.om/portal/vat-faqs";

const rules: ComplianceRules = {
  vat: {
    applicable: true,
    standardRatePercent: 5,
    categories: [
      { code: "standard_rate", label: { ar: "الأساسية", fr: "Taux standard", en: "Standard Rate" }, ratePercent: 5 },
      {
        code: "zero_rated",
        label: { ar: "نسبة صفر%", fr: "Taux zéro", en: "Zero-Rated" },
        ratePercent: 0,
      },
      { code: "exempt", label: { ar: "مُعفاة", fr: "Exonéré", en: "Exempt" }, ratePercent: 0 },
    ],
  },
  withholding: {
    applicable: true,
    rules: [
      { vendorType: "non_resident_no_pe", serviceCategory: "royalties", ratePercent: 10 },
      { vendorType: "non_resident_no_pe", serviceCategory: "management_fees", ratePercent: 10 },
      { vendorType: "non_resident_no_pe", serviceCategory: "services", ratePercent: 10 },
      { vendorType: "non_resident_no_pe", serviceCategory: "dividends", ratePercent: 0 },
      { vendorType: "non_resident_no_pe", serviceCategory: "interest", ratePercent: 0 },
    ],
  },
  zakat: {
    applicable: false,
    reviewRequired: false,
    notes: "Not an Omani tax obligation.",
  },
  eInvoicing: {
    required: false,
    profile: null,
    notes: "No mandatory e-invoicing regime identified for Oman as of this research date.",
  },
  invoice: {
    requiredFields: ["vatNumber"],
    bilingualRequired: false,
  },
  localization: {
    currency: "OMR",
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
  effectiveFrom: "2021-04-16", // Oman VAT went into effect this date
  sourceUrl: SOURCE_URL,
  sourceType: "official_government",
  publicationDate: "2021-04-16",
  verificationStatus: "unverified",
};

export const omanPack: CountryComplianceAdapter = {
  countryCode: "OM",
  displayName: { ar: "عُمان", fr: "Oman", en: "Oman" },
  getSeedRules: () => rules,
  getSeedVersionMeta: () => seedVersionMeta,
};
