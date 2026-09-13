import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BackupManifest } from "../db/backup.js";

// MIDAD Final Pre-Launch audit, Phase 12 — Platform Backup Center.
// Read-only status over the SAME backups db/backup.ts's createBackup()
// already writes (server/backups/<dir>/manifest.json, gitignored) — no
// new persistence, no new backup mechanism. Never reads or reports a
// secret: manifest.json (see db/backup.ts's BackupManifest type) only
// ever contains checksums, row counts, and provider/size metadata by
// design — nothing here changes that contract.
//
// This is necessarily scoped to what's actually knowable from this
// server process's own local filesystem — the exact same "provider-
// agnostic, no hosting provider chosen yet" stance docs/
// BACKUP_STRATEGY.md already states for backup automation itself. If
// backups are actually produced/stored somewhere this process can't see
// (a different environment, an S3 bucket with no read-back configured),
// this honestly reports no local backup data rather than fabricating a
// status.

export interface BackupCenterStatus {
  found: boolean;
  backupDirectory: string;
  manifest: BackupManifest | null;
  ageSeconds: number | null;
  // Never automated — see this file's header comment. A real restore
  // drill is a manual, deliberately real (not mocked) procedure logged in
  // docs/BACKUP_STRATEGY.md; there is no structured record of "this
  // specific backup was restore-verified" for this route to read.
  restoreDrillTrackedIn: string;
}

function defaultBackupsDir(): string {
  // server/src/lib/backupStatus.ts -> server/backups
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "backups");
}

export async function getLatestBackupStatus(backupsDir: string = defaultBackupsDir()): Promise<BackupCenterStatus> {
  const notFound: BackupCenterStatus = {
    found: false,
    backupDirectory: backupsDir,
    manifest: null,
    ageSeconds: null,
    restoreDrillTrackedIn: "docs/BACKUP_STRATEGY.md",
  };

  if (!fs.existsSync(backupsDir)) return notFound;

  const entries = await fsp.readdir(backupsDir, { withFileTypes: true });
  const manifests: { manifest: BackupManifest; manifestPath: string }[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(backupsDir, entry.name, "manifest.json");
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8")) as BackupManifest;
      manifests.push({ manifest, manifestPath });
    } catch {
      // A malformed/partially-written manifest (e.g. a backup still in
      // progress) is skipped, not reported as the latest — never surface
      // a backup that can't even be parsed as the "last successful" one.
      continue;
    }
  }

  if (manifests.length === 0) return notFound;

  manifests.sort((a, b) => new Date(b.manifest.createdAt).getTime() - new Date(a.manifest.createdAt).getTime());
  const latest = manifests[0].manifest;

  return {
    found: true,
    backupDirectory: backupsDir,
    manifest: latest,
    ageSeconds: Math.floor((Date.now() - new Date(latest.createdAt).getTime()) / 1000),
    restoreDrillTrackedIn: "docs/BACKUP_STRATEGY.md",
  };
}
