import { Router } from "express";
import { requirePlatformCapability } from "../lib/platformPermissions.js";
import { getLatestBackupStatus } from "../lib/backupStatus.js";

// MIDAD Final Pre-Launch audit, Phase 12 — Platform Backup Center.
// Read-only, gated by "security.read" (owner/admin/auditor — backup
// status is exactly the kind of operational-health oversight an auditor
// role covers, same reasoning as Phase 7's Security Center). Never
// exposes a secret — see lib/backupStatus.ts's own header comment for
// why that's structurally true, not just a convention here.
export const platformBackupCenterRouter = Router();

platformBackupCenterRouter.get("/status", requirePlatformCapability("security.read"), async (_req, res) => {
  const status = await getLatestBackupStatus();
  res.json(status);
});
