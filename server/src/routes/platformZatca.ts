import { Router } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { auditEvents, companies } from "../db/schema.js";

// MIDAD Admin Dashboard — ZATCA operations (Slice 3). Mounted behind
// platformAuth (never requireAuth), the same structurally-separate
// PLATFORM_SCOPE posture as routes/platformOrganizations.ts — no
// req.companyId exists here, this deliberately reads across every tenant.
// Read-only: no mutation route exists on this resource. Every field
// selected below is explicitly allowlisted for this view — secretRef is
// never selected from zatca_egs_units, and no ZatcaSecretStore function is
// ever imported here, so there is no code path in this file capable of
// returning credential material even by mistake.
export const platformZatcaRouter = Router();

const CERT_EXPIRY_WINDOW_DAYS = 30;
const RECENT_LIMIT = 20;

platformZatcaRouter.get("/", async (_req, res) => {
  const units = await db.query.zatcaEgsUnits.findMany({
    columns: {
      id: true,
      companyId: true,
      name: true,
      environment: true,
      status: true,
      csidStatus: true,
      certificateExpiresAt: true,
      lastCommunicationAt: true,
      createdAt: true,
    },
    orderBy: (e, { desc }) => [desc(e.createdAt)],
  });

  const companyIds = [...new Set(units.map((u) => u.companyId))];
  const companyRows = companyIds.length
    ? await db.query.companies.findMany({ where: inArray(companies.id, companyIds), columns: { id: true, name: true } })
    : [];
  const companyNameById = new Map(companyRows.map((c) => [c.id, c.name]));

  const byStatus: Record<string, number> = {};
  const byEnvironment: Record<string, number> = {};
  const expiryThreshold = new Date(Date.now() + CERT_EXPIRY_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const expiringCertificates: Array<{
    egsUnitId: string;
    companyId: string;
    companyName: string | null;
    environment: string;
    certificateExpiresAt: Date;
  }> = [];

  for (const unit of units) {
    byStatus[unit.status] = (byStatus[unit.status] ?? 0) + 1;
    byEnvironment[unit.environment] = (byEnvironment[unit.environment] ?? 0) + 1;
    if (unit.certificateExpiresAt && unit.certificateExpiresAt <= expiryThreshold) {
      expiringCertificates.push({
        egsUnitId: unit.id,
        companyId: unit.companyId,
        companyName: companyNameById.get(unit.companyId) ?? null,
        environment: unit.environment,
        certificateExpiresAt: unit.certificateExpiresAt,
      });
    }
  }

  // Connection-check history — written only by routes/zatca.ts's
  // /verify-connection route, whose audit events (see recordAuditEvent
  // calls there) never carry credential material, only
  // {connected, correlationId, detail} or {category, message}.
  const recentCheckEvents = await db.query.auditEvents.findMany({
    where: and(eq(auditEvents.entityType, "zatca_egs_unit"), inArray(auditEvents.action, ["zatca.connectionCheck.attempted", "zatca.connectionCheck.error"])),
    orderBy: (e, { desc }) => [desc(e.createdAt)],
    limit: 50,
    columns: { id: true, companyId: true, entityId: true, action: true, afterValue: true, createdAt: true },
  });
  const recentFailedChecks = recentCheckEvents
    .filter((e) => e.action === "zatca.connectionCheck.error" || (e.afterValue as { connected?: boolean } | null)?.connected === false)
    .slice(0, RECENT_LIMIT)
    .map((e) => ({
      id: e.id,
      companyId: e.companyId,
      companyName: companyNameById.get(e.companyId) ?? null,
      egsUnitId: e.entityId,
      action: e.action,
      detail: e.afterValue,
      createdAt: e.createdAt,
    }));

  // No submission-creation route exists yet in this slice (Slice 3
  // deliberately does not auto-hook invoice creation into ZATCA — see the
  // Slice 3 discovery report's STEP 9 decision), so this is genuinely
  // empty in every deployment today; included now so the dashboard needs
  // no further change once a future slice starts writing rows here.
  const recentSubmissions = await db.query.zatcaSubmissions.findMany({
    orderBy: (s, { desc }) => [desc(s.createdAt)],
    limit: RECENT_LIMIT,
    columns: {
      id: true,
      companyId: true,
      egsUnitId: true,
      environment: true,
      state: true,
      documentTypeCode: true,
      zatcaErrorCode: true,
      zatcaErrorMessage: true,
      createdAt: true,
      respondedAt: true,
    },
  });

  res.json({
    totalEgsUnits: units.length,
    byStatus,
    byEnvironment,
    expiringCertificates,
    recentFailedChecks,
    recentSubmissions: recentSubmissions.map((s) => ({ ...s, companyName: companyNameById.get(s.companyId) ?? null })),
  });
});
