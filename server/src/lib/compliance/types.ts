// The shape every country pack's data must produce, and the shape of the
// code-level adapter each country pack registers. See packs/index.ts for
// the registry and packs/saudiArabia.ts for a concrete example.
//
// Nothing in this file (or anywhere in lib/compliance/) hard-codes a tax
// rate for any specific country — every actual number lives in a
// db/schema.ts `complianceRuleVersions.rules` row, seeded from a country
// pack's getSeedRules()/getSeedVersionMeta() and then versioned in the
// database from that point on. The engine (engine.ts) that reads these
// rules and produces a tax result is completely country-agnostic.

export type CountryCode = "SA" | "AE" | "QA" | "KW" | "BH" | "OM" | "MA";

export const COUNTRY_CODES: CountryCode[] = ["SA", "AE", "QA", "KW", "BH", "OM", "MA"];

export type SupportedLanguage = "ar" | "fr" | "en";

export type TaxCategoryCode =
  | "standard_rate"
  | "zero_rated"
  | "exempt"
  | "out_of_scope"
  | "reverse_charge"
  | "withholding"
  | (string & {});

export interface TaxCategoryDefinition {
  code: TaxCategoryCode;
  label: Partial<Record<SupportedLanguage, string>>;
  // null for a category whose rate isn't a single flat percentage (e.g.
  // withholding, which varies by vendor/service — see WithholdingRules).
  ratePercent: number | null;
}

export interface VatRules {
  applicable: boolean;
  standardRatePercent: number;
  categories: TaxCategoryDefinition[];
}

export interface WithholdingRule {
  vendorType: string;
  serviceCategory: string | null;
  ratePercent: number;
}

export interface WithholdingRules {
  applicable: boolean;
  rules: WithholdingRule[];
}

// Zakat applicability is never inferred from "country === SA" alone — see
// engine.ts getZakatStatus(). A pack that cannot confidently express
// applicability for every entity type it supports should set
// reviewRequired: true rather than guessing, per the mission's explicit
// "do not invent a zakat calculation" instruction.
export interface ZakatRules {
  applicable: boolean;
  reviewRequired: boolean;
  notes?: string;
}

export interface EInvoicingRules {
  required: boolean;
  // Opaque identifier for a specific e-invoicing regime/profile (e.g.
  // "zatca_fatoora_phase2"). Interpreted by a future e-invoicing adapter,
  // never by the generic engine — see routes/compliance.ts and the
  // implementation report for why actual e-invoice submission integration
  // is out of scope for this phase (PDF generation is not compliant
  // e-invoicing, and no provider integration exists yet).
  profile: string | null;
  notes?: string;
}

export interface InvoiceRuleset {
  requiredFields: string[];
  bilingualRequired: boolean;
}

export interface LocalizationRules {
  currency: string; // ISO 4217
  language: SupportedLanguage;
  direction: "rtl" | "ltr";
  dateFormat: string;
}

export interface RequiredIdentifier {
  type: string;
  label: Partial<Record<SupportedLanguage, string>>;
  required: boolean;
}

// The complete payload stored in complianceRuleVersions.rules (JSONB).
export interface ComplianceRules {
  vat: VatRules;
  withholding: WithholdingRules;
  zakat: ZakatRules;
  eInvoicing: EInvoicingRules;
  invoice: InvoiceRuleset;
  localization: LocalizationRules;
  identifiers: RequiredIdentifier[];
}

export type SourceType = "official_government" | "official_regulation" | "verified_professional";
export type VerificationStatus = "verified" | "unverified" | "review_required";

export interface SeedVersionMeta {
  version: string;
  effectiveFrom: string; // YYYY-MM-DD
  sourceUrl: string;
  sourceType: SourceType;
  publicationDate: string | null;
  verificationStatus: VerificationStatus;
}

// The code-level contract every country pack implements. Deliberately
// small: the pack's job is to supply sourced, versioned DATA (getSeedRules
// + getSeedVersionMeta) plus any genuinely country-specific validation
// logic — it does not implement effective-date resolution, override
// handling, or tax arithmetic itself; that is all in engine.ts and applies
// identically to every country.
export interface CountryComplianceAdapter {
  countryCode: CountryCode;
  displayName: Partial<Record<SupportedLanguage, string>>;
  getSeedRules(): ComplianceRules;
  getSeedVersionMeta(): SeedVersionMeta;
  // Optional: an extra, country-specific business-validation warning for an
  // override attempt, beyond the generic technical bounds (0-100%, etc.)
  // the engine already enforces for every country. Return null for "no
  // additional warning for this value."
  validateOverride?(settingKey: string, value: unknown, currentRules: ComplianceRules): string | null;
}
