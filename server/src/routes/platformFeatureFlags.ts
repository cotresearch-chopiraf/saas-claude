import { Router } from "express";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { featureFlags, companyFeatureFlagOverrides, companies } from "../db/schema.js";
import { recordAuditEvent } from "../lib/audit.js";
import { logger } from "../lib/logger.js";
import { requirePlatformCapability } from "../lib/platformPermissions.js";

// P0 hardening (MIDAD Final Pre-Launch, SaaS & Sale-Readiness Audit) —
// platform-admin CRUD over the feature-flag registry and per-company
// overrides. Mounted behind platformAuth (never requireAuth) in app.ts, so
// req.platformOperatorId is always set and req.userId/req.companyId are
// always undefined — same discipline every other routes/platform*.ts file
// already follows.
//
// Global-scope mutations (create a flag, change its globalEnabled/
// defaultEnabledForOrgs/enabledEnvironments) have no single tenant to
// attach an audit_events row to (that table's companyId is NOT NULL by
// design — it is a tenant-scoped trail, not a platform-wide one), so these
// are recorded via structured logging instead, matching the existing
// "financial_mutation" logger.info() precedent elsewhere in this codebase.
// Per-company override mutations DO have a natural companyId and are
// recorded in audit_events, exactly like platformSupportSessions.ts's own
// supportSession.granted event.
export const platformFeatureFlagsRouter = Router();

platformFeatureFlagsRouter.get("/", requirePlatformCapability("featureFlags.read"), async (_req, res) => {
  const flags = await db.query.featureFlags.findMany({ orderBy: (f, { asc }) => [asc(f.key)] });
  res.json({ flags });
});

const createFlagSchema = z.object({
  key: z
    .string()
    .trim()
    .min(2, "مفتاح الميزة قصير جداً")
    .regex(/^[a-z][a-z0-9_]*$/, "المفتاح يجب أن يكون بأحرف إنجليزية صغيرة وأرقام وشرطة سفلية فقط، ويبدأ بحرف"),
  description: z.string().trim().min(3, "الوصف قصير جداً"),
  globalEnabled: z.boolean().optional().default(false),
  defaultEnabledForOrgs: z.boolean().optional().default(false),
  enabledEnvironments: z.array(z.string()).nullable().optional(),
});

platformFeatureFlagsRouter.post("/", requirePlatformCapability("featureFlags.manage"), async (req, res) => {
  const parsed = createFlagSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const existing = await db.query.featureFlags.findFirst({ where: eq(featureFlags.key, parsed.data.key) });
  if (existing) return res.status(409).json({ error: "مفتاح الميزة مستخدم بالفعل" });

  const [created] = await db
    .insert(featureFlags)
    .values({
      key: parsed.data.key,
      description: parsed.data.description,
      globalEnabled: parsed.data.globalEnabled,
      defaultEnabledForOrgs: parsed.data.defaultEnabledForOrgs,
      enabledEnvironments: parsed.data.enabledEnvironments ?? null,
    })
    .returning();

  logger.info("feature_flag_created", {
    platformOperatorId: req.platformOperatorId,
    flagKey: created.key,
    globalEnabled: created.globalEnabled,
    defaultEnabledForOrgs: created.defaultEnabledForOrgs,
    requestId: req.requestId,
  });

  res.status(201).json(created);
});

const updateFlagSchema = z.object({
  description: z.string().trim().min(3, "الوصف قصير جداً").optional(),
  globalEnabled: z.boolean().optional(),
  defaultEnabledForOrgs: z.boolean().optional(),
  enabledEnvironments: z.array(z.string()).nullable().optional(),
});

platformFeatureFlagsRouter.patch("/:key", requirePlatformCapability("featureFlags.manage"), async (req, res) => {
  const parsed = updateFlagSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const existing = await db.query.featureFlags.findFirst({ where: eq(featureFlags.key, req.params.key) });
  if (!existing) return res.status(404).json({ error: "الميزة غير موجودة" });

  const [updated] = await db
    .update(featureFlags)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(featureFlags.key, req.params.key))
    .returning();

  logger.info("feature_flag_updated", {
    platformOperatorId: req.platformOperatorId,
    flagKey: updated.key,
    before: {
      globalEnabled: existing.globalEnabled,
      defaultEnabledForOrgs: existing.defaultEnabledForOrgs,
      enabledEnvironments: existing.enabledEnvironments,
    },
    after: {
      globalEnabled: updated.globalEnabled,
      defaultEnabledForOrgs: updated.defaultEnabledForOrgs,
      enabledEnvironments: updated.enabledEnvironments,
    },
    requestId: req.requestId,
  });

  res.json(updated);
});

platformFeatureFlagsRouter.get("/:key/overrides", requirePlatformCapability("featureFlags.read"), async (req, res) => {
  const flag = await db.query.featureFlags.findFirst({ where: eq(featureFlags.key, req.params.key) });
  if (!flag) return res.status(404).json({ error: "الميزة غير موجودة" });

  const overrides = await db.query.companyFeatureFlagOverrides.findMany({
    where: eq(companyFeatureFlagOverrides.flagKey, req.params.key),
    orderBy: (o, { desc }) => [desc(o.updatedAt)],
  });
  res.json({ overrides });
});

const setOverrideSchema = z.object({ enabled: z.boolean() });

platformFeatureFlagsRouter.put("/:key/overrides/:companyId", requirePlatformCapability("featureFlags.manage"), async (req, res) => {
  const parsed = setOverrideSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const flag = await db.query.featureFlags.findFirst({ where: eq(featureFlags.key, req.params.key) });
  if (!flag) return res.status(404).json({ error: "الميزة غير موجودة" });

  const company = await db.query.companies.findFirst({ where: eq(companies.id, req.params.companyId) });
  if (!company) return res.status(404).json({ error: "الشركة غير موجودة" });

  const override = await db.transaction(async (tx) => {
    const existing = await tx.query.companyFeatureFlagOverrides.findFirst({
      where: and(
        eq(companyFeatureFlagOverrides.companyId, req.params.companyId),
        eq(companyFeatureFlagOverrides.flagKey, req.params.key),
      ),
    });

    const [row] = existing
      ? await tx
          .update(companyFeatureFlagOverrides)
          .set({ enabled: parsed.data.enabled, setByPlatformOperatorId: req.platformOperatorId!, updatedAt: new Date() })
          .where(eq(companyFeatureFlagOverrides.id, existing.id))
          .returning()
      : await tx
          .insert(companyFeatureFlagOverrides)
          .values({
            companyId: req.params.companyId,
            flagKey: req.params.key,
            enabled: parsed.data.enabled,
            setByPlatformOperatorId: req.platformOperatorId!,
          })
          .returning();

    await recordAuditEvent(tx, {
      companyId: req.params.companyId,
      actorUserId: null,
      action: "featureFlag.overrideSet",
      entityType: "feature_flag_override",
      entityId: row.id,
      beforeValue: existing ? { enabled: existing.enabled } : null,
      afterValue: { enabled: row.enabled },
      source: "platform_admin",
      metadata: { flagKey: req.params.key, platformOperatorId: req.platformOperatorId, requestId: req.requestId },
    });

    return row;
  });

  res.json(override);
});

platformFeatureFlagsRouter.delete("/:key/overrides/:companyId", requirePlatformCapability("featureFlags.manage"), async (req, res) => {
  const existing = await db.query.companyFeatureFlagOverrides.findFirst({
    where: and(
      eq(companyFeatureFlagOverrides.companyId, req.params.companyId),
      eq(companyFeatureFlagOverrides.flagKey, req.params.key),
    ),
  });
  if (!existing) return res.status(404).json({ error: "لا يوجد استثناء لهذه الشركة على هذه الميزة" });

  await db.transaction(async (tx) => {
    await tx.delete(companyFeatureFlagOverrides).where(eq(companyFeatureFlagOverrides.id, existing.id));

    await recordAuditEvent(tx, {
      companyId: req.params.companyId,
      actorUserId: null,
      action: "featureFlag.overrideCleared",
      entityType: "feature_flag_override",
      entityId: existing.id,
      beforeValue: { enabled: existing.enabled },
      afterValue: null,
      source: "platform_admin",
      metadata: { flagKey: req.params.key, platformOperatorId: req.platformOperatorId, requestId: req.requestId },
    });
  });

  res.status(204).end();
});
