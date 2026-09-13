import { Router } from "express";
import { z } from "zod";
import { db } from "../db/client.js";
import { companies } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { requirePlatformCapability } from "../lib/platformPermissions.js";
import { buildTenantExport, readMigrationStateFromServerRoot } from "../lib/tenantExport.js";
import { validateTenantImport, importTenantBundle } from "../lib/tenantImport.js";
import type { TenantExportBundle } from "../lib/tenantExport.js";
import { logger } from "../lib/logger.js";

// MIDAD Final Pre-Launch audit, Phase 10-11 — Tenant Export / Import.
// Mounted behind platformAuth, gated by the "tenantData.manage"
// capability (owner/admin only). See lib/tenantExport.ts and lib/
// tenantImport.ts for the actual mechanics and their own scope
// disclaimers — this file is just the HTTP surface + confirmation gate.
export const platformTenantExportRouter = Router();
export const platformTenantImportRouter = Router();

platformTenantExportRouter.post("/:id/export", requirePlatformCapability("tenantData.manage"), async (req, res) => {
  const company = await db.query.companies.findFirst({ where: eq(companies.id, req.params.id), columns: { id: true, name: true } });
  if (!company) return res.status(404).json({ error: "الشركة غير موجودة" });

  const bundle = await buildTenantExport(req.params.id);

  logger.info("tenant_export_created", {
    companyId: company.id,
    companyName: company.name,
    platformOperatorId: req.platformOperatorId,
    tableRowCounts: bundle.manifest.tableRowCounts,
    requestId: req.requestId,
  });

  res.json(bundle);
});

const bundleSchema = z.object({
  manifest: z.object({
    manifestVersion: z.literal("1"),
    exportedAt: z.string(),
    schema: z.object({ migrationCount: z.number(), latestMigrationTag: z.string() }),
    companyId: z.string().uuid(),
    companyName: z.string(),
    includesAuditEvents: z.literal(true),
    includesDocumentBytes: z.boolean(),
    redactedColumns: z.record(z.array(z.string())),
    excludedTables: z.array(z.string()),
    tableRowCounts: z.record(z.number()),
    checksumSha256: z.string(),
  }),
  company: z.record(z.unknown()),
  tables: z.record(z.array(z.record(z.unknown()))),
});

platformTenantImportRouter.post("/validate", requirePlatformCapability("tenantData.manage"), async (req, res) => {
  const parsed = bundleSchema.safeParse(req.body?.bundle);
  if (!parsed.success) return res.status(400).json({ error: "ملف الاستيراد غير صالح: " + parsed.error.issues[0].message });

  const currentSchema = readMigrationStateFromServerRoot();
  const preview = await validateTenantImport(parsed.data as TenantExportBundle, currentSchema.latestMigrationTag);
  res.json(preview);
});

const confirmSchema = z.object({
  bundle: bundleSchema,
  // "Explicit Confirmation" — the operator types the company name back,
  // exactly, the same discipline Phase 9's ownership transfer already
  // established for its own confirmationEmail field, so an import can
  // never proceed from a misclick alone.
  confirmationCompanyName: z.string(),
});

platformTenantImportRouter.post("/confirm", requirePlatformCapability("tenantData.manage"), async (req, res) => {
  const parsed = confirmSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const bundle = parsed.data.bundle as TenantExportBundle;

  if (parsed.data.confirmationCompanyName !== bundle.manifest.companyName) {
    return res.status(400).json({ error: "اسم الشركة للتأكيد لا يطابق اسم الشركة في ملف الاستيراد" });
  }

  // Re-validated server-side rather than trusting a client-supplied
  // "already validated" flag — the same discipline every other mutation
  // route in this codebase re-checks its own preconditions from freshly
  // loaded state rather than the request body.
  const currentSchema = readMigrationStateFromServerRoot();
  const preview = await validateTenantImport(bundle, currentSchema.latestMigrationTag);
  if (!preview.canImport) {
    return res.status(409).json({ error: "لا يمكن إتمام الاستيراد", blockers: preview.blockers });
  }

  const result = await importTenantBundle(bundle, req.requestId);

  logger.info("tenant_import_completed", {
    companyId: result.companyId,
    companyName: result.companyName,
    platformOperatorId: req.platformOperatorId,
    verified: result.verified,
    requestId: req.requestId,
  });

  res.status(201).json(result);
});
