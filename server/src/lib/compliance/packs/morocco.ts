import type { CountryComplianceAdapter, ComplianceRules, SeedVersionMeta } from "../types.js";

// SOURCES AND VERIFICATION STATUS — researched via web search on
// 2026-08-28 (in French, matching how Moroccan tax sources actually
// publish), cross-corroborated across multiple independent professional
// tax-advisory sources. The Direction Générale des Impôts's own domain
// (tax.gov.ma) could not be directly fetched in this environment.
// `verificationStatus` is "unverified" — a human must confirm directly
// against the DGI before relying on this for real filings.
//
// Morocco is an ADDITIONAL market pack, isolated from GCC-specific logic
// (no shared code path — see packs/index.ts) — the platform's dashboard
// and core product are not redesigned around it, per the mission's own
// instruction.
//
// TVA reform: since 1 January 2026 Morocco uses only two rates — the
// standard 20% and a reduced 10% (the former 7%/14% brackets were removed
// by the 2024-2026 reform). The reduced 10% rate itself has a further
// deductible/non-deductible sub-distinction (e.g. hospitality/catering/
// transport at 10% with input-VAT deduction vs. insurance brokers at 10%
// without) that this pack does not attempt to fully enumerate — only the
// two headline rates are modeled as tax categories; a case needing the
// finer sub-distinction should be flagged for professional review rather
// than guessed from this category list alone.
//
// Withholding: an 11.25% rate on dividends is current for 2026,
// SCHEDULED to drop to 10% from 2027 — modeled here as the 2026 rate, with
// this scheduled change noted explicitly so it is not silently missed
// when a new version is eventually published for 2027. A NEW 5%
// withholding on services payments (to CT-liable service providers) takes
// effect 1 July 2026 — directly relevant to a contractor paying
// subcontractors, so it's modeled even though it's very recent.

const SOURCE_URL = "https://www.tax.gov.ma/";

const rules: ComplianceRules = {
  vat: {
    applicable: true,
    standardRatePercent: 20,
    categories: [
      { code: "standard_rate", label: { ar: "النسبة العادية", fr: "Taux normal", en: "Standard Rate" }, ratePercent: 20 },
      { code: "reduced_rate", label: { ar: "النسبة المخفضة", fr: "Taux réduit", en: "Reduced Rate" }, ratePercent: 10 },
      { code: "exempt", label: { ar: "مُعفى", fr: "Exonéré", en: "Exempt" }, ratePercent: 0 },
    ],
  },
  withholding: {
    applicable: true,
    rules: [
      { vendorType: "resident_company", serviceCategory: "dividends", ratePercent: 11.25 },
      { vendorType: "resident_company", serviceCategory: "services", ratePercent: 5 },
    ],
  },
  zakat: {
    applicable: false,
    reviewRequired: false,
    notes: "Not a Moroccan tax obligation.",
  },
  eInvoicing: {
    required: false,
    profile: "morocco_dgi_clearance",
    notes:
      "Article 145-IX of the General Tax Code establishes a DGI clearance model (each invoice validated by the DGI platform before being legally issued, structured format, UBL 2.1 accepted) starting with large companies (turnover > 200M MAD) in 2026, then SMEs 2027-2028 — the implementing decree with exact thresholds and dates was still pending as of this research. `required: false` reflects that this platform's smaller contractor customers are not in the first wave, not that no mandate exists.",
  },
  invoice: {
    requiredFields: ["ice", "vatNumber"],
    bilingualRequired: true,
  },
  localization: {
    currency: "MAD",
    language: "fr",
    direction: "ltr",
    dateFormat: "DD/MM/YYYY",
  },
  identifiers: [
    {
      type: "ice",
      label: { ar: "التعريف الموحد للمقاولة (ICE)", fr: "Identifiant Commun de l'Entreprise (ICE)", en: "Common Enterprise Identifier (ICE)" },
      required: true,
    },
    {
      type: "vat_number",
      label: { ar: "المعرف الضريبي", fr: "Identifiant Fiscal (IF) / TVA", en: "Tax Identifier / VAT" },
      required: true,
    },
  ],
};

const seedVersionMeta: SeedVersionMeta = {
  version: "2026.08",
  effectiveFrom: "2026-01-01", // the two-rate (20%/10%) TVA reform's effective date
  sourceUrl: SOURCE_URL,
  sourceType: "official_government",
  publicationDate: "2026-01-01",
  verificationStatus: "unverified",
};

export const moroccoPack: CountryComplianceAdapter = {
  countryCode: "MA",
  displayName: { ar: "المغرب", fr: "Maroc", en: "Morocco" },
  getSeedRules: () => rules,
  getSeedVersionMeta: () => seedVersionMeta,
};
