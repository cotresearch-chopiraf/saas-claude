import type { ComplianceRules } from "./types.js";

// Overrides address a setting by a dotted path into the ComplianceRules
// document (e.g. "vat.standardRatePercent") rather than one dedicated
// column per setting — this is what lets the override layer, the audit
// trail, and the API stay generic across every country pack and every
// setting a pack chooses to expose, without a schema change every time a
// pack turns out to need one more overridable field.
export function getRuleAtPath(rules: ComplianceRules, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = rules;
  for (const part of parts) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

// The known, engine-relevant override paths a customer can currently
// change. Kept as an explicit allowlist rather than "any path" so a client
// can never write to an arbitrary/unintended location in the rules
// document (e.g. tampering with `identifiers` or `invoice.requiredFields`
// through the override endpoint).
export const OVERRIDABLE_SETTING_KEYS = [
  "vat.standardRatePercent",
  "vat.applicable",
] as const;

export type OverridableSettingKey = (typeof OVERRIDABLE_SETTING_KEYS)[number];

export function isOverridableSettingKey(key: string): key is OverridableSettingKey {
  return (OVERRIDABLE_SETTING_KEYS as readonly string[]).includes(key);
}
