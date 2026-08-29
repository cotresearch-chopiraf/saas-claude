import type { CountryComplianceAdapter, ComplianceRules, SeedVersionMeta } from "../types.js";

// SOURCES AND VERIFICATION STATUS — researched via web search on
// 2026-08-28, cross-corroborated across multiple independent professional
// tax-advisory sources (including Deloitte/KPMG tax alerts for the 2026
// retention update specifically). Kuwait's Ministry of Finance domain
// could not be directly fetched in this environment.
// `verificationStatus` is "unverified" — a human must confirm directly
// against the Kuwaiti MOF before relying on this for real filings.
//
// Kuwait has NOT implemented VAT and, unlike Qatar, has explicitly ruled
// it out for the current government's 4-year plan in favor of a Domestic
// Minimum Top-up Tax on large multinationals — represented the same
// honest way as Qatar: `vat.applicable: false`, `standardRatePercent: 0`,
// this is today's correct answer, not a placeholder.
//
// The one Kuwait-specific mechanism directly relevant to a construction
// SaaS: a mandatory 5% "tax retention" that ANY business (public or
// private) must withhold from a contract/transaction payment to an
// incorporated body, released only once the recipient produces a Tax
// Clearance Certificate from the Ministry of Finance — modeled here as a
// withholding rule under vendorType "incorporated_body" /
// serviceCategory "contract_payment" (as opposed to a classic
// cross-border non-resident withholding, which is a different mechanism
// this pack does not claim to have researched).

const SOURCE_URL = "https://www.mof.gov.kw/";

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
      {
        vendorType: "incorporated_body",
        serviceCategory: "contract_payment",
        ratePercent: 5,
      },
    ],
  },
  zakat: {
    applicable: false,
    reviewRequired: false,
    notes: "Not a Kuwaiti tax obligation in the Saudi sense.",
  },
  eInvoicing: {
    required: false,
    profile: null,
    notes: "No e-invoicing mandate identified for Kuwait as of this research date.",
  },
  invoice: {
    requiredFields: [],
    bilingualRequired: false,
  },
  localization: {
    currency: "KWD",
    language: "ar",
    direction: "rtl",
    dateFormat: "DD/MM/YYYY",
  },
  identifiers: [],
};

const seedVersionMeta: SeedVersionMeta = {
  version: "2026.08",
  effectiveFrom: "2026-03-29", // the 5% retention rule's own effective date, per MOF rules issuance
  sourceUrl: SOURCE_URL,
  sourceType: "official_government",
  publicationDate: "2026-03-29",
  verificationStatus: "unverified",
};

export const kuwaitPack: CountryComplianceAdapter = {
  countryCode: "KW",
  displayName: { ar: "الكويت", fr: "Koweït", en: "Kuwait" },
  getSeedRules: () => rules,
  getSeedVersionMeta: () => seedVersionMeta,
};
