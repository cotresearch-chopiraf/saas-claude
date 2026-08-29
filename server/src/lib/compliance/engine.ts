import { and, eq, gt, isNull, lte, or } from "drizzle-orm";
import { db } from "../../db/client.js";
import { companyComplianceProfiles, companyTaxOverrides, complianceRuleVersions } from "../../db/schema.js";
import { computeTotals, sumMoney } from "../money.js";
import { getRuleAtPath } from "./rules.js";
import type { ComplianceRules, CountryCode, TaxCategoryCode } from "./types.js";

export interface EffectiveRuleContext {
  countryCode: CountryCode;
  ruleVersionId: string;
  ruleVersionLabel: string;
  rules: ComplianceRules;
}

export interface ReviewRequired {
  reviewRequired: true;
  reason: string;
}

// The one function every other resolution in this file goes through: which
// published rule version actually applied on a given date, for a given
// company. This is deliberately keyed off the TRANSACTION date, not
// "today" — a transaction dated before a rule changed must resolve to the
// rule that was in force then, not whatever is current now (mission
// section 13). If no profile exists, or no published version covers the
// date, this returns REVIEW_REQUIRED rather than guessing a fallback.
export async function resolveEffectiveRuleVersion(
  companyId: string,
  asOfDate: string,
): Promise<EffectiveRuleContext | ReviewRequired> {
  const profile = await db.query.companyComplianceProfiles.findFirst({
    where: eq(companyComplianceProfiles.companyId, companyId),
  });
  if (!profile) return { reviewRequired: true, reason: "no_compliance_profile" };

  const version = await db.query.complianceRuleVersions.findFirst({
    where: and(
      eq(complianceRuleVersions.countryCode, profile.countryCode),
      eq(complianceRuleVersions.status, "published"),
      lte(complianceRuleVersions.effectiveFrom, asOfDate),
      or(isNull(complianceRuleVersions.effectiveTo), gt(complianceRuleVersions.effectiveTo, asOfDate)),
    ),
    orderBy: (v, { desc: d }) => [d(v.effectiveFrom)],
  });
  if (!version) return { reviewRequired: true, reason: "no_published_rule_version_for_date" };

  return {
    countryCode: profile.countryCode,
    ruleVersionId: version.id,
    ruleVersionLabel: version.version,
    rules: version.rules as ComplianceRules,
  };
}

export interface EffectiveSetting {
  value: unknown;
  overrideId: string | null;
  isOverridden: boolean;
}

// Official default, unless a company override is active as of this exact
// date — see overrides.ts for how a "change" (as opposed to a plain reset)
// closes the previous override's window instead of deleting it, which is
// what makes "what was effective on an older date" still answerable here.
export async function getEffectiveSettingValue(
  companyId: string,
  settingKey: string,
  asOfDate: string,
  ctx: EffectiveRuleContext,
): Promise<EffectiveSetting> {
  const override = await db.query.companyTaxOverrides.findFirst({
    where: and(
      eq(companyTaxOverrides.companyId, companyId),
      eq(companyTaxOverrides.settingKey, settingKey),
      eq(companyTaxOverrides.status, "active"),
      lte(companyTaxOverrides.effectiveFrom, asOfDate),
      or(isNull(companyTaxOverrides.effectiveTo), gt(companyTaxOverrides.effectiveTo, asOfDate)),
    ),
    orderBy: (o, { desc: d }) => [d(o.effectiveFrom)],
  });
  if (override) return { value: override.overrideValue, overrideId: override.id, isOverridden: true };
  return { value: getRuleAtPath(ctx.rules, settingKey), overrideId: null, isOverridden: false };
}

export interface TaxCalculationInput {
  companyId: string;
  transactionDate: string;
  taxCategory: TaxCategoryCode;
  itemAmounts: number[];
}

export interface TaxCalculationResult {
  status: "calculated" | "review_required";
  subtotal: number;
  taxRatePercent: number | null;
  taxAmount: number;
  total: number;
  taxCategory: string;
  countryCode: CountryCode | null;
  ruleVersionId: string | null;
  ruleVersion: string | null;
  overrideReference: string | null;
  reviewReason?: string;
}

// The single authoritative tax calculation in this application — invoices,
// quotes, and (in the future) reports all call this rather than each
// computing their own tax figure (mission section 29). Reuses lib/money.ts
// for every arithmetic step; never does its own floating-point tax math.
export async function calculateTax(input: TaxCalculationInput): Promise<TaxCalculationResult> {
  const subtotal = sumMoney(input.itemAmounts);
  const ctx = await resolveEffectiveRuleVersion(input.companyId, input.transactionDate);

  if ("reviewRequired" in ctx) {
    return {
      status: "review_required",
      subtotal,
      taxRatePercent: null,
      taxAmount: 0,
      total: subtotal,
      taxCategory: input.taxCategory,
      countryCode: null,
      ruleVersionId: null,
      ruleVersion: null,
      overrideReference: null,
      reviewReason: ctx.reason,
    };
  }

  let ratePercent: number;
  let overrideId: string | null = null;

  if (input.taxCategory === "zero_rated" || input.taxCategory === "exempt" || input.taxCategory === "out_of_scope") {
    ratePercent = 0;
  } else if (input.taxCategory === "standard_rate") {
    const resolved = await getEffectiveSettingValue(
      input.companyId,
      "vat.standardRatePercent",
      input.transactionDate,
      ctx,
    );
    const parsed = Number(resolved.value);
    if (!Number.isFinite(parsed)) {
      return {
        status: "review_required",
        subtotal,
        taxRatePercent: null,
        taxAmount: 0,
        total: subtotal,
        taxCategory: input.taxCategory,
        countryCode: ctx.countryCode,
        ruleVersionId: ctx.ruleVersionId,
        ruleVersion: ctx.ruleVersionLabel,
        overrideReference: null,
        reviewReason: "unresolvable_vat_rate",
      };
    }
    ratePercent = parsed;
    overrideId = resolved.overrideId;
  } else {
    // Any other category (reverse_charge, withholding, or a country's own
    // custom code) must be defined in that country's published category
    // list — this engine does not fabricate a rate for a category it
    // cannot look up.
    const category = ctx.rules.vat.categories.find((c) => c.code === input.taxCategory);
    if (!category || category.ratePercent === null) {
      return {
        status: "review_required",
        subtotal,
        taxRatePercent: null,
        taxAmount: 0,
        total: subtotal,
        taxCategory: input.taxCategory,
        countryCode: ctx.countryCode,
        ruleVersionId: ctx.ruleVersionId,
        ruleVersion: ctx.ruleVersionLabel,
        overrideReference: null,
        reviewReason: "unresolvable_tax_category",
      };
    }
    ratePercent = category.ratePercent;
  }

  const totals = computeTotals(input.itemAmounts, ratePercent);
  return {
    status: "calculated",
    subtotal: totals.subtotal,
    taxRatePercent: ratePercent,
    taxAmount: totals.taxAmount,
    total: totals.total,
    taxCategory: input.taxCategory,
    countryCode: ctx.countryCode,
    ruleVersionId: ctx.ruleVersionId,
    ruleVersion: ctx.ruleVersionLabel,
    overrideReference: overrideId,
  };
}

export type ZakatStatusResult =
  | { status: "resolved"; applicable: boolean; reviewRequired: boolean; notes?: string }
  | { status: "review_required"; reason: string };

// Zakat applicability is read from the country pack's own published rules
// (which the pack author must have set reviewRequired: true on if it
// cannot confidently express applicability) — this function does not
// itself decide "SA = zakat" or any other shortcut.
export async function getZakatStatus(companyId: string, asOfDate: string): Promise<ZakatStatusResult> {
  const ctx = await resolveEffectiveRuleVersion(companyId, asOfDate);
  if ("reviewRequired" in ctx) return { status: "review_required", reason: ctx.reason };
  return {
    status: "resolved",
    applicable: ctx.rules.zakat.applicable,
    reviewRequired: ctx.rules.zakat.reviewRequired,
    notes: ctx.rules.zakat.notes,
  };
}

export type WithholdingResolution =
  | { status: "resolved"; ratePercent: number }
  | { status: "not_applicable" }
  | { status: "review_required"; reason: string };

export async function getWithholdingRate(
  companyId: string,
  vendorType: string,
  serviceCategory: string | null,
  asOfDate: string,
): Promise<WithholdingResolution> {
  const ctx = await resolveEffectiveRuleVersion(companyId, asOfDate);
  if ("reviewRequired" in ctx) return { status: "review_required", reason: ctx.reason };
  if (!ctx.rules.withholding.applicable) return { status: "not_applicable" };

  const rule = ctx.rules.withholding.rules.find(
    (r) => r.vendorType === vendorType && (r.serviceCategory === serviceCategory || r.serviceCategory === null),
  );
  if (!rule) return { status: "review_required", reason: "no_matching_withholding_rule" };
  return { status: "resolved", ratePercent: rule.ratePercent };
}
