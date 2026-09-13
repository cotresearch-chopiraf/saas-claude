import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { companies, platformOperators, featureFlags, plans, incidents } from "../db/schema.js";
import { requirePlatformCapability } from "../lib/platformPermissions.js";
import { getLatestBackupStatus } from "../lib/backupStatus.js";
import { readMigrationStateFromServerRoot } from "../lib/tenantExport.js";

// MIDAD Final Pre-Launch audit, Phase 17 — Sale/Handover Center. A single,
// read-only aggregate snapshot of the platform's operational state for a
// prospective buyer's or new operator's technical due diligence — the
// living counterpart to docs/PRODUCTION_LAUNCH_CHECKLIST.md, built entirely
// by calling existing read paths (Phase 4's organization counts, Phase 12's
// backup status, Phase 13's incident counts, db/backup.ts's migration
// state) rather than introducing any new store or duplicating their logic.
//
// Deliberately narrow: every field here is something this codebase can
// actually prove from its own database or filesystem. It never claims
// production-hosting facts (backup provider chosen, PITR enabled,
// production ZATCA Sandbox access) this codebase has no way to observe —
// see notAvailable below, same honesty discipline as Phase 7's Security
// Center and Phase 12's Backup Center.
export const platformHandoverRouter = Router();

platformHandoverRouter.get("/summary", requirePlatformCapability("handover.read"), async (_req, res) => {
  const [companyCounts] = await db
    .select({
      total: sql<number>`count(*)::int`,
      active: sql<number>`count(*) filter (where status = 'active')::int`,
      suspended: sql<number>`count(*) filter (where status = 'suspended')::int`,
    })
    .from(companies);

  const [operatorCounts] = await db
    .select({
      total: sql<number>`count(*)::int`,
      owners: sql<number>`count(*) filter (where role = 'platform_owner')::int`,
      admins: sql<number>`count(*) filter (where role = 'platform_admin')::int`,
      active: sql<number>`count(*) filter (where status = 'active')::int`,
    })
    .from(platformOperators);

  const [flagCounts] = await db
    .select({
      total: sql<number>`count(*)::int`,
      globallyEnabled: sql<number>`count(*) filter (where global_enabled)::int`,
    })
    .from(featureFlags);

  const [planCounts] = await db
    .select({
      total: sql<number>`count(*)::int`,
      active: sql<number>`count(*) filter (where is_active)::int`,
    })
    .from(plans);

  const [incidentCounts] = await db
    .select({
      open: sql<number>`count(*) filter (where status = 'open')::int`,
      investigating: sql<number>`count(*) filter (where status = 'investigating')::int`,
    })
    .from(incidents);

  const backup = await getLatestBackupStatus();
  const schema = readMigrationStateFromServerRoot();

  res.json({
    organizations: companyCounts,
    platformOperators: operatorCounts,
    featureFlags: flagCounts,
    plans: planCounts,
    openIncidents: { open: incidentCounts.open, investigating: incidentCounts.investigating },
    backup: { found: backup.found, ageSeconds: backup.ageSeconds, restoreDrillTrackedIn: backup.restoreDrillTrackedIn },
    schema: { migrationCount: schema.migrationCount, latestMigrationTag: schema.latestMigrationTag },
    zatca: {
      liveExternalVerification: false,
      statusDocument: "docs/zatca/LIVE_SANDBOX_VERIFICATION.md",
    },
    // Honest about what a real due-diligence review still needs, which
    // this codebase cannot observe about itself or its (not yet chosen)
    // hosting provider — see docs/PRODUCTION_LAUNCH_CHECKLIST.md's own
    // "EXTERNAL CONFIRMATION REQUIRED" items for the full list.
    notAvailable: ["productionHostingProvider", "automatedBackupsEnabled", "pointInTimeRecovery", "productionZatcaSandboxAccess"],
    launchChecklistDocument: "docs/PRODUCTION_LAUNCH_CHECKLIST.md",
  });
});
