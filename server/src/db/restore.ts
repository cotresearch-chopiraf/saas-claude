// P0 hardening (MIDAD Final Pre-Launch, SaaS & Sale-Readiness Audit, §9/§19).
//
// Companion to backup.ts. Implements exactly the restore-verification
// drill docs/BACKUP_STRATEGY.md already documents step-by-step ("Restore
// verification drill (mandatory, isolated)") as a real, testable
// capability: pg_restore into an isolated database, then verify —
// checksum integrity, connectivity (the same SELECT 1 /api/health/ready
// runs), and row counts against the manifest recorded at backup time.
//
// This never touches the live source database: it refuses to restore
// onto a target identical to the source DATABASE_URL unless explicitly
// overridden, matching the doc's own "⚠️ DESTRUCTIVE" warnings.
import "dotenv/config";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { getKeyTableRowCounts, type BackupManifest } from "./backup.js";

const execFileAsync = promisify(execFile);

export interface RestoreOptions {
  manifestPath: string;
  targetDatabaseUrl: string;
  /** Defaults to process.env.DATABASE_URL. Used only for the same-database safety check. */
  sourceDatabaseUrl?: string;
  /** Required to restore onto a target equal to sourceDatabaseUrl. Never pass this for the mandatory isolated drill. */
  allowSameDatabase?: boolean;
  /** If the manifest includes a storage archive, extract it here. Omit to skip storage restore. */
  restoreStorageTo?: string;
}

export interface RestoreResult {
  restored: true;
  verified: boolean;
  checksumMatch: boolean;
  connectivityCheckPassed: boolean;
  rowCountMatch: boolean;
  expectedRowCounts: Record<string, number>;
  actualRowCounts: Record<string, number>;
  storageRestored: boolean;
  details: string[];
}

async function sha256OfFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  return hash.digest("hex");
}

export async function restoreBackup(options: RestoreOptions): Promise<RestoreResult> {
  const details: string[] = [];

  const sourceUrl = options.sourceDatabaseUrl ?? process.env.DATABASE_URL;
  if (!options.allowSameDatabase && sourceUrl && sourceUrl === options.targetDatabaseUrl) {
    throw new Error(
      "Refusing to restore: targetDatabaseUrl is identical to the source DATABASE_URL. This would overwrite " +
        "the live database the backup was taken from. The restore-verification drill must run against a " +
        "genuinely isolated scratch database (see docs/BACKUP_STRATEGY.md). Pass allowSameDatabase: true only " +
        "if this is a deliberate, real restore-over-source operation (e.g. disaster recovery), never for a drill.",
    );
  }

  const manifest = JSON.parse(await fsp.readFile(options.manifestPath, "utf8")) as BackupManifest;
  const backupDir = path.dirname(options.manifestPath);
  const dumpPath = path.join(backupDir, manifest.database.dumpFile);

  const actualDumpChecksum = await sha256OfFile(dumpPath);
  const checksumMatch = actualDumpChecksum === manifest.database.checksumSha256;
  details.push(
    checksumMatch
      ? "Dump file checksum matches manifest — backup file integrity confirmed."
      : `Dump file checksum MISMATCH: manifest expected ${manifest.database.checksumSha256}, found ${actualDumpChecksum}.`,
  );
  if (!checksumMatch) {
    throw new Error(
      "Backup dump file failed integrity check (checksum mismatch) — refusing to restore a possibly " +
        "corrupted or tampered backup.",
    );
  }

  await execFileAsync("pg_restore", ["--clean", "--if-exists", "--dbname", options.targetDatabaseUrl, dumpPath]);
  details.push("pg_restore completed against the target database.");

  let storageRestored = false;
  if (manifest.storage.included && manifest.storage.archiveFile && options.restoreStorageTo) {
    const archivePath = path.join(backupDir, manifest.storage.archiveFile);
    const actualArchiveChecksum = await sha256OfFile(archivePath);
    if (manifest.storage.checksumSha256 && actualArchiveChecksum !== manifest.storage.checksumSha256) {
      throw new Error(
        `Storage archive failed integrity check: manifest expected ${manifest.storage.checksumSha256}, ` +
          `found ${actualArchiveChecksum}.`,
      );
    }
    await fsp.mkdir(options.restoreStorageTo, { recursive: true });
    await execFileAsync("tar", ["-xzf", archivePath, "-C", options.restoreStorageTo]);
    storageRestored = true;
    details.push(`Storage archive restored to ${options.restoreStorageTo}.`);
  }

  const pool = new Pool({ connectionString: options.targetDatabaseUrl });
  let connectivityCheckPassed = false;
  let actualRowCounts: Record<string, number> = {};
  try {
    // The same query GET /api/health/ready runs (server/src/routes/health.ts) —
    // a pass here is the same signal a production readiness probe would see.
    const { rows } = await pool.query<{ ok: number }>("SELECT 1 AS ok");
    connectivityCheckPassed = Number(rows[0]?.ok) === 1;
    actualRowCounts = await getKeyTableRowCounts(pool);
  } finally {
    await pool.end();
  }
  details.push(
    connectivityCheckPassed
      ? "Connectivity check (SELECT 1, same query as /api/health/ready) passed."
      : "Connectivity check FAILED.",
  );

  const expectedRowCounts = manifest.database.rowCounts as Record<string, number>;
  const rowCountMatch = Object.keys(expectedRowCounts).every((table) => expectedRowCounts[table] === actualRowCounts[table]);
  details.push(
    rowCountMatch
      ? `Row counts match the manifest for every key table: ${JSON.stringify(actualRowCounts)}.`
      : `Row count MISMATCH — expected ${JSON.stringify(expectedRowCounts)}, got ${JSON.stringify(actualRowCounts)}.`,
  );

  const verified = checksumMatch && connectivityCheckPassed && rowCountMatch;

  return {
    restored: true,
    verified,
    checksumMatch,
    connectivityCheckPassed,
    rowCountMatch,
    expectedRowCounts,
    actualRowCounts,
    storageRestored,
    details,
  };
}

async function main() {
  const manifestPath = process.argv[2];
  const targetDatabaseUrl = process.argv[3];
  const allowSameDatabase = process.argv.includes("--allow-same-database");
  const restoreStorageToFlagIdx = process.argv.indexOf("--restore-storage-to");
  const restoreStorageTo = restoreStorageToFlagIdx !== -1 ? process.argv[restoreStorageToFlagIdx + 1] : undefined;

  if (!manifestPath || !targetDatabaseUrl) {
    console.error(
      "Usage: tsx src/db/restore.ts <manifest.json> <targetDatabaseUrl> [--allow-same-database] " +
        "[--restore-storage-to <dir>]",
    );
    process.exit(1);
  }

  console.log("RESTORING...");
  const result = await restoreBackup({ manifestPath, targetDatabaseUrl, allowSameDatabase, restoreStorageTo });
  console.log("RESTORED");
  console.log(result.verified ? "VERIFIED: PASS" : "VERIFIED: FAIL");
  for (const line of result.details) console.log(` - ${line}`);
  if (!result.verified) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
