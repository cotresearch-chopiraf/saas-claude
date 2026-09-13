// P0 hardening (MIDAD Final Pre-Launch, SaaS & Sale-Readiness Audit, §9/§19).
//
// docs/BACKUP_STRATEGY.md already documents the provider-agnostic pg_dump
// path this script implements, as raw shell commands, and explicitly
// states this repository intentionally does not implement
// provider-specific backup automation (no hosting provider is chosen yet,
// and hardcoding one would be speculative infrastructure). This script
// does not change that stance — it is the same pg_dump/pg_restore
// commands the doc already documents, turned into a real, committed,
// testable capability instead of copy-pasted bash, with a manifest
// (checksum, schema/migration version, row-count fingerprint) so a
// restore can actually be verified rather than merely attempted. It
// remains provider-agnostic: it only needs a Postgres connection string
// and the local filesystem, exactly like the documented commands.
import "dotenv/config";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const execFileAsync = promisify(execFile);

// Matches the exact table set docs/BACKUP_STRATEGY.md's own "Local
// demonstration" section already used for its row-count sanity check,
// plus `invoices` (the audit's own suggestion for a financial-data
// fingerprint). This is a fingerprint for restore verification, not a
// claim these are the only tables backed up — pg_dump backs up the whole
// database, every table in schema.ts.
const KEY_TABLES = ["companies", "users", "projects", "invoices"] as const;
type KeyTable = (typeof KEY_TABLES)[number];

export interface BackupManifest {
  manifestVersion: "1";
  createdAt: string;
  app: { packageVersion: string };
  schema: { migrationCount: number; latestMigrationTag: string };
  database: {
    dumpFile: string;
    format: "custom";
    checksumSha256: string;
    sizeBytes: number;
    rowCounts: Record<KeyTable, number>;
  };
  storage: {
    included: boolean;
    provider: "local" | "s3" | "none";
    archiveFile?: string;
    checksumSha256?: string;
    sizeBytes?: number;
  };
}

export interface CreateBackupOptions {
  databaseUrl?: string;
  outputDir?: string;
  /** Defaults to process.env.STORAGE_PROVIDER, then "local". Pass "none" to skip storage backup entirely. */
  storageProvider?: "local" | "s3" | "none";
  /** Root directory containing drizzle/ and package.json (used for migration/version metadata). Defaults to the real server/ root. */
  serverRoot?: string;
  /** Root directory containing uploads/ and private-uploads/ for local storage backup. Defaults to serverRoot. */
  storageRoot?: string;
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

export async function getKeyTableRowCounts(pool: Pool): Promise<Record<KeyTable, number>> {
  const counts = {} as Record<KeyTable, number>;
  for (const table of KEY_TABLES) {
    const { rows } = await pool.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM "${table}"`);
    counts[table] = Number(rows[0].count);
  }
  return counts;
}

function readMigrationState(serverRoot: string): { migrationCount: number; latestMigrationTag: string } {
  const journalPath = path.join(serverRoot, "drizzle", "meta", "_journal.json");
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as { entries: Array<{ tag: string }> };
  return {
    migrationCount: journal.entries.length,
    latestMigrationTag: journal.entries[journal.entries.length - 1]?.tag ?? "none",
  };
}

function readPackageVersion(serverRoot: string): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(serverRoot, "package.json"), "utf8")) as { version: string };
  return pkg.version;
}

// Local-disk storage lives in two sibling roots (see
// lib/storage/localDiskProvider.ts: storageRoot="uploads",
// privateStorageRoot="private-uploads"), deliberately not nested inside
// each other. Back up whichever of the two actually exist.
async function backupLocalStorage(storageRoot: string, archivePath: string): Promise<boolean> {
  const candidates = ["uploads", "private-uploads"];
  const existing = candidates.filter((d) => fs.existsSync(path.join(storageRoot, d)));
  if (existing.length === 0) return false;
  await execFileAsync("tar", ["-czf", archivePath, "-C", storageRoot, ...existing]);
  return true;
}

export async function createBackup(
  options: CreateBackupOptions = {},
): Promise<{ manifest: BackupManifest; manifestPath: string }> {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set (pass databaseUrl explicitly, or set the environment variable).");
  }

  const serverRoot = options.serverRoot ?? path.resolve(fileURLToPath(import.meta.url), "../../..");
  const storageRoot = options.storageRoot ?? serverRoot;
  const outputDir =
    options.outputDir ?? path.join(serverRoot, "backups", `backup-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await fsp.mkdir(outputDir, { recursive: true });

  const dumpFile = "database.dump";
  const dumpPath = path.join(outputDir, dumpFile);
  await execFileAsync("pg_dump", ["--format=custom", "--file", dumpPath, databaseUrl]);
  const dumpStat = await fsp.stat(dumpPath);
  const dumpChecksum = await sha256OfFile(dumpPath);

  const pool = new Pool({ connectionString: databaseUrl });
  let rowCounts: Record<KeyTable, number>;
  try {
    rowCounts = await getKeyTableRowCounts(pool);
  } finally {
    await pool.end();
  }

  const schemaInfo = readMigrationState(serverRoot);
  const storageProviderName = options.storageProvider ?? (process.env.STORAGE_PROVIDER as "local" | "s3" | undefined) ?? "local";

  let storage: BackupManifest["storage"];
  if (storageProviderName === "s3") {
    // Durability for S3-compatible storage is delegated to the bucket
    // provider (versioning/replication) — see docs/BACKUP_STRATEGY.md's
    // "Storage failure" scenario. This repository's backup tooling has no
    // basis to reach into an unconfigured, unchosen bucket provider.
    storage = { included: false, provider: "s3" };
  } else if (storageProviderName === "local") {
    const archiveFile = "storage.tar.gz";
    const archivePath = path.join(outputDir, archiveFile);
    const included = await backupLocalStorage(storageRoot, archivePath);
    storage = included
      ? {
          included: true,
          provider: "local",
          archiveFile,
          checksumSha256: await sha256OfFile(archivePath),
          sizeBytes: (await fsp.stat(archivePath)).size,
        }
      : { included: false, provider: "local" };
  } else {
    storage = { included: false, provider: "none" };
  }

  const manifest: BackupManifest = {
    manifestVersion: "1",
    createdAt: new Date().toISOString(),
    app: { packageVersion: readPackageVersion(serverRoot) },
    schema: schemaInfo,
    database: {
      dumpFile,
      format: "custom",
      checksumSha256: dumpChecksum,
      sizeBytes: dumpStat.size,
      rowCounts,
    },
    storage,
  };

  const manifestPath = path.join(outputDir, "manifest.json");
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  return { manifest, manifestPath };
}

async function main() {
  const outputDirArg = process.argv[2];
  const { manifest, manifestPath } = await createBackup(outputDirArg ? { outputDir: outputDirArg } : {});
  console.log("BACKUP CREATED");
  console.log(`Manifest: ${manifestPath}`);
  console.log(JSON.stringify(manifest, null, 2));
}

// Guarded so importing this module for tests (or from restore.ts's types)
// never triggers a real pg_dump — only running it directly does.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
