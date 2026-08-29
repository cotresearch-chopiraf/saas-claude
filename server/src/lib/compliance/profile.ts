import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { companyComplianceProfiles } from "../../db/schema.js";
import { recordAuditEvent } from "./audit.js";
import { getCountryPack } from "./packs/index.js";
import { ensureInitialRuleVersion } from "./publish.js";
import type { CountryCode } from "./types.js";

export class ComplianceProfileError extends Error {}

export interface CreateProfileInput {
  companyId: string;
  countryCode: CountryCode;
  legalEntityType?: string;
  businessActivity?: string;
  taxRegistrationStatus?: string;
  userId: string;
}

// The onboarding flow: select country -> automatic configuration -> review
// -> activate. This is the "activate" step — it does not ask the customer
// to hand-configure VAT rates, invoice rules, or anything else the country
// pack already knows; it just attaches the company to that country's
// current published rule version. Everything from here on is
// official-default-unless-overridden (see engine.ts / overrides.ts).
export async function createOrReplaceComplianceProfile(input: CreateProfileInput) {
  const pack = getCountryPack(input.countryCode);
  if (!pack) {
    throw new ComplianceProfileError(`"${input.countryCode}" is not yet a supported country pack`);
  }

  const ruleVersionId = await ensureInitialRuleVersion(input.countryCode);
  const rules = pack.getSeedRules();
  const status = rules.zakat.reviewRequired ? "review_required" : "configured";

  return db.transaction(async (tx) => {
    const existing = await tx.query.companyComplianceProfiles.findFirst({
      where: eq(companyComplianceProfiles.companyId, input.companyId),
    });

    let profile;
    if (existing) {
      [profile] = await tx
        .update(companyComplianceProfiles)
        .set({
          countryCode: input.countryCode,
          legalEntityType: input.legalEntityType ?? existing.legalEntityType,
          businessActivity: input.businessActivity ?? existing.businessActivity,
          taxRegistrationStatus: input.taxRegistrationStatus ?? existing.taxRegistrationStatus,
          activeRuleVersionId: ruleVersionId,
          status,
          updatedAt: new Date(),
        })
        .where(eq(companyComplianceProfiles.id, existing.id))
        .returning();
    } else {
      [profile] = await tx
        .insert(companyComplianceProfiles)
        .values({
          companyId: input.companyId,
          countryCode: input.countryCode,
          legalEntityType: input.legalEntityType,
          businessActivity: input.businessActivity,
          taxRegistrationStatus: input.taxRegistrationStatus,
          activeRuleVersionId: ruleVersionId,
          status,
        })
        .returning();
    }

    await recordAuditEvent(tx, {
      companyId: input.companyId,
      eventType: existing ? "profile.updated" : "profile.created",
      entityId: profile.id,
      settingKey: "profile.countryCode",
      previousValue: existing?.countryCode ?? null,
      newValue: input.countryCode,
      countryCode: input.countryCode,
      ruleVersionId,
      changedBy: input.userId,
    });

    return profile;
  });
}

export async function getComplianceProfile(companyId: string) {
  return db.query.companyComplianceProfiles.findFirst({
    where: eq(companyComplianceProfiles.companyId, companyId),
  });
}
