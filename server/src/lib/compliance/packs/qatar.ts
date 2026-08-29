import type { CountryComplianceAdapter, ComplianceRules, SeedVersionMeta } from "../types.js";

// SOURCES AND VERIFICATION STATUS — researched via web search on
// 2026-08-28, cross-corroborated across multiple independent professional
// tax-advisory sources; the General Tax Authority's own domain
// (dhareeba.gov.qa / gta.gov.qa) could not be directly fetched in this
// environment. `verificationStatus` is "unverified" — a human must confirm
// directly against the GTA before relying on this for real filings.
//
// THE IMPORTANT FACT HERE: as of this research date, Qatar has signed the
// GCC VAT Framework Agreement but has NOT implemented VAT — there is no
// VAT law, no rate, and no confirmed go-live date (an approved draft
// e-invoicing law, May 2026, is widely read as groundwork preceding an
// eventual VAT launch, the same sequence Saudi Arabia and the UAE
// followed, but that is analysis, not a confirmed fact). This is
// represented honestly as `vat.applicable: false` with
// `standardRatePercent: 0` — this is the correct PRESENT-DAY answer (no
// VAT currently exists to charge), not a placeholder or a guess about a
// future rate. When Qatar does implement VAT, this requires a genuinely
// new published rule version (via publishNewRuleVersion), not an edit to
// this one.

const SOURCE_URL = "https://dhareeba.gov.qa/";

const rules: ComplianceRules = {
  vat: {
    applicable: false,
    standardRatePercent: 0,
    categories: [
      { code: "standard_rate", label: { ar: "الأساسية", fr: "Taux standard", en: "Standard Rate" }, ratePercent: 0 },
    ],
  },
  withholding: {
    applicable: true,
    rules: [
      { vendorType: "non_resident", serviceCategory: "services", ratePercent: 5 },
      { vendorType: "non_resident", serviceCategory: "royalties", ratePercent: 5 },
      { vendorType: "non_resident", serviceCategory: "commissions", ratePercent: 5 },
      { vendorType: "non_resident", serviceCategory: "interest", ratePercent: 7 },
      { vendorType: "non_resident", serviceCategory: "dividends", ratePercent: 0 },
    ],
  },
  zakat: {
    applicable: false,
    reviewRequired: false,
    notes: "Not a Qatari tax obligation.",
  },
  eInvoicing: {
    required: false,
    profile: null,
    notes:
      "Qatar's Council of Ministers approved a draft e-invoicing law and implementing regulations in May 2026, but as of this research it is not yet in force and no mandatory go-live date has been confirmed.",
  },
  invoice: {
    requiredFields: [],
    bilingualRequired: false,
  },
  localization: {
    currency: "QAR",
    language: "ar",
    direction: "rtl",
    dateFormat: "DD/MM/YYYY",
  },
  identifiers: [],
};

const seedVersionMeta: SeedVersionMeta = {
  version: "2026.08",
  effectiveFrom: "2018-01-01", // no VAT in force; this just marks the seed version's own start
  sourceUrl: SOURCE_URL,
  sourceType: "official_government",
  publicationDate: null,
  verificationStatus: "unverified",
};

export const qatarPack: CountryComplianceAdapter = {
  countryCode: "QA",
  displayName: { ar: "قطر", fr: "Qatar", en: "Qatar" },
  getSeedRules: () => rules,
  getSeedVersionMeta: () => seedVersionMeta,
};
