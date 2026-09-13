import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { createBackup } from "../src/db/backup.js";
import { restoreBackup } from "../src/db/restore.js";

// P0 hardening (MIDAD Final Pre-Launch audit, §9/§19) — this exercises the
// REAL pg_dump/pg_restore/createdb/dropdb binaries against an isolated
// scratch database, never against DATABASE_URL itself. It proves the
// documented backup/restore drill (docs/BACKUP_STRATEGY.md) actually
// works, not merely that a script exists: BACKUP CREATED -> RESTORED ->
// VERIFIED, end to end, with real data.

const execFileAsync = promisify(execFile);

function scratchDatabaseUrl(sourceUrl: string, scratchName: string): string {
  const u = new URL(sourceUrl);
  u.pathname = `/${scratchName}`;
  return u.toString();
}

// createdb/dropdb resolve connection params from the environment (PGHOST/
// PGUSER/etc.) by default, which does not match this sandbox's actual
// Postgres auth (DATABASE_URL uses TCP + password, not OS peer auth as
// whichever user runs the test process). Point them at the same server
// DATABASE_URL already connects to via its maintenance ("postgres") database.
function maintenanceUrl(sourceUrl: string): string {
  const u = new URL(sourceUrl);
  u.pathname = "/postgres";
  return u.toString();
}

async function createScratchDb(sourceUrl: string, name: string) {
  await execFileAsync("createdb", ["--maintenance-db", maintenanceUrl(sourceUrl), name]);
}

async function dropIfExists(sourceUrl: string, name: string) {
  await execFileAsync("dropdb", ["--if-exists", "--maintenance-db", maintenanceUrl(sourceUrl), name]).catch(() => {});
}

describe("backup/restore — real pg_dump/pg_restore against an isolated scratch database", () => {
  const app = buildApp();
  const sourceUrl = process.env.DATABASE_URL as string;
  const runId = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let tmpDir: string;

  beforeAll(async () => {
    await resetDb();
    await request(app)
      .post("/api/auth/register")
      .send({ companyName: "Backup Co", name: "Owner", email: `backupowner_${runId}@test.com`, password: "password123" });
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "midad-backup-test-"));
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("creates a backup manifest with a checksummed dump and accurate row counts", async () => {
    const { manifest, manifestPath } = await createBackup({
      databaseUrl: sourceUrl,
      outputDir: path.join(tmpDir, "b1"),
      storageProvider: "none",
    });

    expect(manifest.manifestVersion).toBe("1");
    expect(manifest.database.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.database.sizeBytes).toBeGreaterThan(0);
    expect(manifest.database.rowCounts.companies).toBeGreaterThanOrEqual(1);
    expect(manifest.schema.migrationCount).toBeGreaterThan(0);
    expect(manifest.schema.latestMigrationTag).not.toBe("none");
    expect(manifest.storage.included).toBe(false);

    const onDisk = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    expect(onDisk).toEqual(manifest);
  });

  it("restores a backup into an isolated scratch database and verifies checksum, connectivity, and row counts", async () => {
    const scratchDbName = `midad_backup_test_${runId}_a`;
    const { manifest, manifestPath } = await createBackup({
      databaseUrl: sourceUrl,
      outputDir: path.join(tmpDir, "b2"),
      storageProvider: "none",
    });

    await dropIfExists(sourceUrl, scratchDbName);
    await createScratchDb(sourceUrl, scratchDbName);
    try {
      const result = await restoreBackup({
        manifestPath,
        targetDatabaseUrl: scratchDatabaseUrl(sourceUrl, scratchDbName),
        sourceDatabaseUrl: sourceUrl,
      });

      expect(result.restored).toBe(true);
      expect(result.checksumMatch).toBe(true);
      expect(result.connectivityCheckPassed).toBe(true);
      expect(result.rowCountMatch).toBe(true);
      expect(result.verified).toBe(true);
      expect(result.actualRowCounts.companies).toBe(manifest.database.rowCounts.companies);
      expect(result.actualRowCounts.users).toBe(manifest.database.rowCounts.users);
    } finally {
      await dropIfExists(sourceUrl, scratchDbName);
    }
  });

  it("refuses to restore onto the same database as the source unless explicitly allowed", async () => {
    const { manifestPath } = await createBackup({
      databaseUrl: sourceUrl,
      outputDir: path.join(tmpDir, "b3"),
      storageProvider: "none",
    });

    await expect(
      restoreBackup({ manifestPath, targetDatabaseUrl: sourceUrl, sourceDatabaseUrl: sourceUrl }),
    ).rejects.toThrow(/identical to the source/);
  });

  it("refuses to restore a dump whose checksum does not match the manifest", async () => {
    const scratchDbName = `midad_backup_test_${runId}_b`;
    const outputDir = path.join(tmpDir, "b4");
    const { manifestPath } = await createBackup({ databaseUrl: sourceUrl, outputDir, storageProvider: "none" });

    // Simulate a corrupted/tampered backup file.
    await fs.appendFile(path.join(outputDir, "database.dump"), Buffer.from("corruption"));

    await dropIfExists(sourceUrl, scratchDbName);
    await createScratchDb(sourceUrl, scratchDbName);
    try {
      await expect(
        restoreBackup({
          manifestPath,
          targetDatabaseUrl: scratchDatabaseUrl(sourceUrl, scratchDbName),
          sourceDatabaseUrl: sourceUrl,
        }),
      ).rejects.toThrow(/checksum mismatch/i);
    } finally {
      await dropIfExists(sourceUrl, scratchDbName);
    }
  });

  it("backs up and restores local-disk document storage (uploads + private-uploads) as a checksummed archive", async () => {
    const fakeServerRoot = await fs.mkdtemp(path.join(os.tmpdir(), "midad-storage-root-"));
    await fs.mkdir(path.join(fakeServerRoot, "uploads"), { recursive: true });
    await fs.writeFile(path.join(fakeServerRoot, "uploads", "logo.png"), "fake-logo-bytes");
    await fs.mkdir(path.join(fakeServerRoot, "private-uploads", "documents"), { recursive: true });
    await fs.writeFile(path.join(fakeServerRoot, "private-uploads", "documents", "contract.pdf"), "fake-pdf-bytes");

    const outputDir = path.join(tmpDir, "b5");
    const { manifest, manifestPath } = await createBackup({
      databaseUrl: sourceUrl,
      outputDir,
      storageProvider: "local",
      storageRoot: fakeServerRoot,
    });

    expect(manifest.storage.included).toBe(true);
    expect(manifest.storage.provider).toBe("local");
    expect(manifest.storage.checksumSha256).toMatch(/^[0-9a-f]{64}$/);

    const scratchDbName = `midad_backup_test_${runId}_c`;
    await dropIfExists(sourceUrl, scratchDbName);
    await createScratchDb(sourceUrl, scratchDbName);
    const restoreToDir = path.join(tmpDir, "b5-restored");
    try {
      const result = await restoreBackup({
        manifestPath,
        targetDatabaseUrl: scratchDatabaseUrl(sourceUrl, scratchDbName),
        sourceDatabaseUrl: sourceUrl,
        restoreStorageTo: restoreToDir,
      });

      expect(result.verified).toBe(true);
      expect(result.storageRestored).toBe(true);

      const restoredLogo = await fs.readFile(path.join(restoreToDir, "uploads", "logo.png"), "utf8");
      expect(restoredLogo).toBe("fake-logo-bytes");
      const restoredContract = await fs.readFile(
        path.join(restoreToDir, "private-uploads", "documents", "contract.pdf"),
        "utf8",
      );
      expect(restoredContract).toBe("fake-pdf-bytes");
    } finally {
      await dropIfExists(sourceUrl, scratchDbName);
      await fs.rm(fakeServerRoot, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("does not include a storage archive when STORAGE_PROVIDER is s3 (durability delegated to the bucket provider)", async () => {
    const { manifest } = await createBackup({
      databaseUrl: sourceUrl,
      outputDir: path.join(tmpDir, "b6"),
      storageProvider: "s3",
    });
    expect(manifest.storage.included).toBe(false);
    expect(manifest.storage.provider).toBe("s3");
  });
});
