import { Router } from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { auditEvents, companies } from "../db/schema.js";
import { computeOnboardingStatus, getZatcaTenantIdentity, type ZatcaOnboardingStatus } from "../lib/zatca/domain/index.js";

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
      // Selected ONLY to compute the hasCredential boolean below (Slice 4's
      // onboarding-status distribution) — reduced to a boolean immediately
      // and never included in any response value; see this file's header
      // comment on why secretRef must never leave this route.
      secretRef: true,
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

  // Slice 4 — per-tenant onboarding status distribution, reusing
  // domain/onboarding.ts's pure computeOnboardingStatus() (the SAME
  // function routes/zatca.ts's tenant-facing /onboarding-status uses) —
  // never a second status derivation. Only tenants with at least one EGS
  // unit are included (a tenant with none is definitionally
  // not_configured, not worth a full identity fetch to confirm).
  const unitsByCompany = new Map<string, typeof units>();
  for (const unit of units) {
    const list = unitsByCompany.get(unit.companyId) ?? [];
    list.push(unit);
    unitsByCompany.set(unit.companyId, list);
  }
  const onboardingByStatus: Record<ZatcaOnboardingStatus, number> = {
    not_configured: 0,
    configuration_incomplete: 0,
    ready_for_simulation: 0,
    simulation_connected: 0,
    simulation_failed: 0,
    production_not_enabled: 0,
  };
  await Promise.all(
    [...unitsByCompany.entries()].map(async ([companyId, companyUnits]) => {
      const identity = await getZatcaTenantIdentity(companyId);
      const summary = computeOnboardingStatus(
        identity,
        companyUnits.map((u) => ({ environment: u.environment, status: u.status, hasCredential: u.secretRef !== null })),
      );
      onboardingByStatus[summary.status] += 1;
    }),
  );

  // Slice 4 — real submission outcome counts, grouped in SQL (never a
  // full-table fetch just to count). Genuinely all-zero today since no
  // route yet auto-submits from invoice creation (Slice 4's /submit is
  // manually triggered and, in this environment, always ends in
  // compliance_failed at the signing boundary — see routes/zatca.ts).
  const stateCounts = await db.execute<{ state: string; count: number }>(
    sql`SELECT state, COUNT(*)::int AS count FROM zatca_submissions GROUP BY state`,
  );
  const submissionsByState: Record<string, number> = {};
  for (const row of stateCounts.rows) submissionsByState[row.state] = row.count;

  res.json({
    totalEgsUnits: units.length,
    byStatus,
    byEnvironment,
    onboardingByStatus,
    submissionsByState,
    expiringCertificates,
    recentFailedChecks,
    recentSubmissions: recentSubmissions.map((s) => ({ ...s, companyName: companyNameById.get(s.companyId) ?? null })),
  });
});
