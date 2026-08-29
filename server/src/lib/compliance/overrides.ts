import { and, eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { companyComplianceProfiles, companyTaxOverrides, complianceRuleVersions } from "../../db/schema.js";
import { recordAuditEvent } from "./audit.js";
import { getRuleAtPath, isOverridableSettingKey } from "./rules.js";
import type { ComplianceRules } from "./types.js";

export class ComplianceValidationError extends Error {}

// Thrown when the database's partial unique index (TC-03 fix, see
// schema.ts's companyTaxOverrides) rejects a concurrent createOverride
// call that raced another one for the same company+settingKey. Distinct
// from ComplianceValidationError so the route can map it to 409 (a
// transient conflict to retry) rather than 400 (a permanently invalid
// request).
export class ComplianceConflictError extends Error {}

const UNIQUE_VIOLATION = "23505";

// Technical validation only (0-100% bounds, correct type) — this is a hard
// stop, distinct from the softer "significant deviation from default"
// business warning the API layer surfaces before the customer confirms
// (routes/compliance.ts), which this function does not decide.
function validateTechnical(settingKey: string, value: unknown) {
  if (settingKey === "vat.standardRatePercent") {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
      throw new ComplianceValidationError("VAT rate must be a number between 0 and 100");
    }
  }
  if (settingKey === "vat.applicable" && typeof value !== "boolean") {
    throw new ComplianceValidationError("vat.applicable must be true or false");
  }
}

export interface CreateOverrideInput {
  companyId: string;
  settingKey: string;
  value: unknown;
  effectiveFrom: string;
  effectiveTo?: string | null;
  reason?: string;
  userId: string;
}

// Never mutates the country pack (complianceRuleVersions is only ever
// written to by the publish workflow, not here). A prior open-ended active
// override for the same setting has its window CLOSED (effectiveTo set to
// the new override's effectiveFrom) rather than deleted or reset — so a
// historical lookup for a date before the change still finds the old
// value, while resetOverride (below) is the only path that actually turns
// a setting back off.
export async function createOverride(input: CreateOverrideInput) {
  if (!isOverridableSettingKey(input.settingKey)) {
    throw new ComplianceValidationError(`"${input.settingKey}" is not an overridable setting`);
  }
  validateTechnical(input.settingKey, input.value);

  try {
    return await runCreateOverride(input);
  } catch (err) {
    // Postgres reports the partial unique index violation with SQLSTATE
    // 23505 regardless of driver — surfaced here rather than deep inside
    // the transaction so runCreateOverride stays a plain happy-path function.
    if (err && typeof err === "object" && "code" in err && (err as { code: unknown }).code === UNIQUE_VIOLATION) {
      throw new ComplianceConflictError(
        `a concurrent request already created an active override for "${input.settingKey}" — reload and retry`,
      );
    }
    throw err;
  }
}

async function runCreateOverride(input: CreateOverrideInput) {
  return db.transaction(async (tx) => {
    const profile = await tx.query.companyComplianceProfiles.findFirst({
      where: eq(companyComplianceProfiles.companyId, input.companyId),
    });
    if (!profile) throw new ComplianceValidationError("no compliance profile configured for this company");

    const version = await tx.query.complianceRuleVersions.findFirst({
      where: eq(complianceRuleVersions.id, profile.activeRuleVersionId),
    });
    if (!version) throw new ComplianceValidationError("active rule version not found");
    const rules = version.rules as ComplianceRules;
    const officialDefault = getRuleAtPath(rules, input.settingKey);

    const priorActive = await tx.query.companyTaxOverrides.findFirst({
      where: and(
        eq(companyTaxOverrides.companyId, input.companyId),
        eq(companyTaxOverrides.settingKey, input.settingKey),
        eq(companyTaxOverrides.status, "active"),
      ),
    });
    let previousValue = officialDefault;
    if (priorActive) {
      previousValue = priorActive.overrideValue;
      await tx
        .update(companyTaxOverrides)
        .set({ effectiveTo: input.effectiveFrom })
        .where(eq(companyTaxOverrides.id, priorActive.id));
    }

    const [override] = await tx
      .insert(companyTaxOverrides)
      .values({
        companyId: input.companyId,
        settingKey: input.settingKey,
        overrideValue: input.value,
        officialDefaultSnapshot: officialDefault,
        ruleVersionId: version.id,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo ?? null,
        reason: input.reason ?? null,
        createdBy: input.userId,
      })
      .returning();

    await recordAuditEvent(tx, {
      companyId: input.companyId,
      eventType: "override.created",
      entityId: override.id,
      settingKey: input.settingKey,
      previousValue,
      newValue: input.value,
      officialDefaultAtTime: officialDefault,
      countryCode: profile.countryCode,
      ruleVersionId: version.id,
      changedBy: input.userId,
      reason: input.reason,
      effectiveFrom: input.effectiveFrom,
      effectiveTo: input.effectiveTo,
    });

    return override;
  });
}

export interface ResetOverrideInput {
  companyId: string;
  overrideId: string;
  userId: string;
  reason?: string;
}

// The override row is never deleted — only marked reset, so the audit
// trail survives (mission-required invariant: "reset removes override but
// preserves audit history").
//
// TC-04 fix: the UPDATE itself carries `status = 'active'` in its WHERE
// clause (not a separate SELECT-then-UPDATE) — the same atomic
// conditional-UPDATE discipline as changeOrders.ts / boq.ts's publish
// route. Two concurrent reset calls on the same override can now never
// both succeed: the second UPDATE affects zero rows and this returns null,
// where before both calls' unconditional-by-id UPDATE would succeed and
// both write a "reset" audit event for the same override.
export async function resetOverride(input: ResetOverrideInput) {
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(companyTaxOverrides)
      .set({ status: "reset", resetAt: new Date(), resetBy: input.userId })
      .where(
        and(
          eq(companyTaxOverrides.id, input.overrideId),
          eq(companyTaxOverrides.companyId, input.companyId),
          eq(companyTaxOverrides.status, "active"),
        ),
      )
      .returning();
    if (!updated) return null;

    const profile = await tx.query.companyComplianceProfiles.findFirst({
      where: eq(companyComplianceProfiles.companyId, input.companyId),
    });

    await recordAuditEvent(tx, {
      companyId: input.companyId,
      eventType: "override.reset",
      entityId: updated.id,
      settingKey: updated.settingKey,
      previousValue: updated.overrideValue,
      newValue: updated.officialDefaultSnapshot,
      officialDefaultAtTime: updated.officialDefaultSnapshot,
      countryCode: profile?.countryCode ?? null,
      ruleVersionId: updated.ruleVersionId,
      changedBy: input.userId,
      reason: input.reason ?? "reset_to_country_default",
    });

    return updated;
  });
}

export async function listActiveOverrides(companyId: string) {
  return db.query.companyTaxOverrides.findMany({
    where: and(eq(companyTaxOverrides.companyId, companyId), eq(companyTaxOverrides.status, "active")),
    orderBy: (o, { desc: d }) => [d(o.createdAt)],
  });
}

export async function listOverrideHistory(companyId: string) {
  return db.query.companyTaxOverrides.findMany({
    where: eq(companyTaxOverrides.companyId, companyId),
    orderBy: (o, { desc: d }) => [d(o.createdAt)],
  });
}
