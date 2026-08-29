import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requirePermission } from "../lib/permissions.js";
import { logger } from "../lib/logger.js";
import { COUNTRY_CODES } from "../lib/compliance/types.js";
import { listSupportedCountries, getCountryPack } from "../lib/compliance/packs/index.js";
import { createOrReplaceComplianceProfile, getComplianceProfile } from "../lib/compliance/profile.js";
import {
  createOverride,
  resetOverride,
  listActiveOverrides,
  listOverrideHistory,
  ComplianceValidationError,
  ComplianceConflictError,
} from "../lib/compliance/overrides.js";
import { resolveEffectiveRuleVersion, getZakatStatus } from "../lib/compliance/engine.js";
import { getRuleAtPath, OVERRIDABLE_SETTING_KEYS } from "../lib/compliance/rules.js";
import { listAuditEvents } from "../lib/audit.js";
import { db } from "../db/client.js";
import { complianceRuleVersions } from "../db/schema.js";
import { eq } from "drizzle-orm";

export const complianceRouter = Router();

const countryCodeSchema = z.enum(COUNTRY_CODES as [string, ...string[]]);

// GET /compliance/countries — which countries are actually implemented
// right now (drives the onboarding country picker; a country listed in
// COUNTRY_CODES but with no pack registered yet is deliberately excluded
// here rather than offered and then failing).
complianceRouter.get("/countries", async (_req, res) => {
  const codes = listSupportedCountries();
  res.json(
    codes.map((code) => {
      const pack = getCountryPack(code)!;
      return { countryCode: code, displayName: pack.displayName };
    }),
  );
});

// GET /compliance/profile
complianceRouter.get("/profile", async (req, res) => {
  const profile = await getComplianceProfile(req.companyId!);
  if (!profile) return res.status(404).json({ error: "لم يتم إعداد ملف الامتثال الضريبي لهذه الشركة بعد" });
  res.json(profile);
});

const createProfileSchema = z.object({
  countryCode: countryCodeSchema,
  legalEntityType: z.string().optional(),
  businessActivity: z.string().optional(),
  taxRegistrationStatus: z.string().optional(),
});

// POST /compliance/profile — country selection / onboarding step.
complianceRouter.post("/profile", requirePermission("compliance.manage"), async (req: Request, res: Response) => {
  const parsed = createProfileSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  try {
    const profile = await createOrReplaceComplianceProfile({
      companyId: req.companyId!,
      countryCode: parsed.data.countryCode as (typeof COUNTRY_CODES)[number],
      legalEntityType: parsed.data.legalEntityType,
      businessActivity: parsed.data.businessActivity,
      taxRegistrationStatus: parsed.data.taxRegistrationStatus,
      userId: req.userId!,
    });
    logger.info("financial_mutation", {
      action: "compliance.profile.set",
      userId: req.userId,
      companyId: req.companyId,
      countryCode: parsed.data.countryCode,
    });
    res.status(201).json(profile);
  } catch (err) {
    if (err instanceof Error) return res.status(400).json({ error: err.message });
    throw err;
  }
});

// GET /compliance/rules — the effective rules document for "today" (or an
// explicit ?asOf=YYYY-MM-DD), for review/display. Never used by the tax
// engine itself for a real transaction — invoices/quotes always pass their
// OWN transaction date to calculateTax(), not "today".
complianceRouter.get("/rules", async (req, res) => {
  const asOf = typeof req.query.asOf === "string" ? req.query.asOf : new Date().toISOString().slice(0, 10);
  const ctx = await resolveEffectiveRuleVersion(req.companyId!, asOf);
  if ("reviewRequired" in ctx) {
    return res.status(200).json({ status: "review_required", reason: ctx.reason });
  }
  res.json({
    status: "resolved",
    countryCode: ctx.countryCode,
    ruleVersion: ctx.ruleVersionLabel,
    ruleVersionId: ctx.ruleVersionId,
    rules: ctx.rules,
  });
});

// GET /compliance/status — the Compliance Center summary card.
complianceRouter.get("/status", async (req, res) => {
  const profile = await getComplianceProfile(req.companyId!);
  if (!profile) {
    return res.json({ status: "not_configured" });
  }
  const asOf = new Date().toISOString().slice(0, 10);
  const [zakat, overrides] = await Promise.all([
    getZakatStatus(req.companyId!, asOf),
    listActiveOverrides(req.companyId!),
  ]);
  const version = await db.query.complianceRuleVersions.findFirst({
    where: eq(complianceRuleVersions.id, profile.activeRuleVersionId),
  });

  res.json({
    status: profile.status,
    countryCode: profile.countryCode,
    ruleVersion: version?.version ?? null,
    zakat,
    overrideCount: overrides.length,
    lastUpdate: profile.updatedAt,
  });
});

// GET /compliance/overrides — currently active overrides only.
complianceRouter.get("/overrides", async (req, res) => {
  const overrides = await listActiveOverrides(req.companyId!);
  res.json(overrides);
});

const createOverrideSchema = z.object({
  settingKey: z.string(),
  value: z.union([z.number(), z.boolean(), z.string()]),
  effectiveFrom: z.string(),
  effectiveTo: z.string().optional(),
  reason: z.string().optional(),
  confirmed: z.boolean().optional().default(false),
});

// Deviation threshold for the "confirm this unusual value" warning — see
// mission section 36. Technical validity (0-100%, etc.) is enforced inside
// createOverride() itself and cannot be bypassed by `confirmed`.
function significantDeviationWarning(officialDefault: unknown, value: unknown): string | null {
  if (typeof officialDefault === "number" && typeof value === "number") {
    if (Math.abs(officialDefault - value) >= 5) {
      return `You are changing the country default from ${officialDefault}% to ${value}%. This may affect tax calculations, invoices, and reports. The platform does not verify that this custom setting is legally applicable to your specific company.`;
    }
  }
  return null;
}

// POST /compliance/overrides
complianceRouter.post("/overrides", requirePermission("compliance.manage"), async (req: Request, res: Response) => {
  const parsed = createOverrideSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const ctx = await resolveEffectiveRuleVersion(req.companyId!, parsed.data.effectiveFrom);
  if ("reviewRequired" in ctx) {
    return res.status(409).json({ error: "لا يمكن إنشاء استثناء قبل إعداد ملف الامتثال الضريبي" });
  }
  const officialDefault = getRuleAtPath(ctx.rules, parsed.data.settingKey);
  const warning = significantDeviationWarning(officialDefault, parsed.data.value);
  if (warning && !parsed.data.confirmed) {
    return res.status(200).json({ status: "confirmation_required", warning, officialDefault });
  }

  try {
    const override = await createOverride({
      companyId: req.companyId!,
      settingKey: parsed.data.settingKey,
      value: parsed.data.value,
      effectiveFrom: parsed.data.effectiveFrom,
      effectiveTo: parsed.data.effectiveTo,
      reason: parsed.data.reason,
      userId: req.userId!,
    });
    logger.info("financial_mutation", {
      action: "compliance.override.created",
      userId: req.userId,
      companyId: req.companyId,
      settingKey: parsed.data.settingKey,
    });
    res.status(201).json({ status: "created", override });
  } catch (err) {
    if (err instanceof ComplianceConflictError) return res.status(409).json({ error: err.message });
    if (err instanceof ComplianceValidationError) return res.status(400).json({ error: err.message });
    throw err;
  }
});

// POST /compliance/overrides/:id/reset
complianceRouter.post(
  "/overrides/:id/reset",
  requirePermission("compliance.manage"),
  async (req: Request<{ id: string }>, res: Response) => {
    const updated = await resetOverride({
      companyId: req.companyId!,
      overrideId: req.params.id,
      userId: req.userId!,
      reason: typeof req.body?.reason === "string" ? req.body.reason : undefined,
    });
    if (!updated) return res.status(404).json({ error: "لا يوجد استثناء نشط بهذا المعرّف" });

    logger.info("financial_mutation", {
      action: "compliance.override.reset",
      userId: req.userId,
      companyId: req.companyId,
      overrideId: req.params.id,
    });
    res.json(updated);
  },
);

// GET /compliance/overrides/history — includes reset overrides too, for
// the "Custom Override Dashboard"'s History action.
complianceRouter.get("/overrides/history", async (req, res) => {
  const history = await listOverrideHistory(req.companyId!);
  res.json(history);
});

// GET /compliance/history — this company's slice of the canonical audit
// trail (read-only; no route anywhere allows updating or deleting an
// audit_events row). Prior to this phase this queried a compliance-only
// audit table; it now queries the same canonical audit_events table every
// other domain (Contract, BOQ, Cost Code, Budget Revision, ...) writes to,
// filtered to just the compliance-related entity types.
complianceRouter.get("/history", async (req, res) => {
  const [profileEvents, overrideEvents] = await Promise.all([
    listAuditEvents(req.companyId!, { entityType: "company_compliance_profile" }),
    listAuditEvents(req.companyId!, { entityType: "company_tax_override" }),
  ]);
  const events = [...profileEvents, ...overrideEvents].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  res.json(events);
});

// Static allowlist of what a company is actually permitted to override —
// exposed so the frontend doesn't need to hard-code it separately.
complianceRouter.get("/overridable-settings", async (_req, res) => {
  res.json(OVERRIDABLE_SETTING_KEYS);
});
