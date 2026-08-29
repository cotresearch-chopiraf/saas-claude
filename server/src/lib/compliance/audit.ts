import { recordAuditEvent as recordCanonicalAuditEvent, type DbLike } from "../audit.js";
import type { CountryCode } from "./types.js";

export type { DbLike };

// Compliance-domain vocabulary, translated into the canonical audit-event
// shape (lib/audit.ts) rather than compliance owning its own audit table
// going forward — see that file's header comment for why. This wrapper
// exists so overrides.ts/profile.ts keep their familiar, compliance-shaped
// call sites instead of every call site hand-building a generic metadata
// object.
export interface AuditEventInput {
  companyId: string;
  eventType: string;
  // The compliance row this event is about (a company_compliance_profiles
  // id for a profile.* event, a company_tax_overrides id for an
  // override.* event) — required so the canonical table's entityId is
  // always a real, queryable reference, not a guess.
  entityId: string;
  settingKey?: string | null;
  previousValue?: unknown;
  newValue?: unknown;
  officialDefaultAtTime?: unknown;
  countryCode?: CountryCode | null;
  ruleVersionId?: string | null;
  changedBy: string;
  reason?: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
}

const ENTITY_TYPE_BY_EVENT_PREFIX: Record<string, string> = {
  profile: "company_compliance_profile",
  override: "company_tax_override",
};

export async function recordAuditEvent(db: DbLike, input: AuditEventInput) {
  const prefix = input.eventType.split(".")[0];
  const entityType = ENTITY_TYPE_BY_EVENT_PREFIX[prefix] ?? "compliance";

  await recordCanonicalAuditEvent(db, {
    companyId: input.companyId,
    actorUserId: input.changedBy,
    action: input.eventType,
    entityType,
    entityId: input.entityId,
    beforeValue: input.previousValue,
    afterValue: input.newValue,
    reason: input.reason,
    source: "api",
    metadata: {
      settingKey: input.settingKey ?? null,
      officialDefaultAtTime: input.officialDefaultAtTime ?? null,
      countryCode: input.countryCode ?? null,
      ruleVersionId: input.ruleVersionId ?? null,
      effectiveFrom: input.effectiveFrom ?? null,
      effectiveTo: input.effectiveTo ?? null,
    },
  });
}
