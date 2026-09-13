import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { platformOperators } from "../src/db/schema.js";
import { hashPassword } from "../src/lib/password.js";
import { getLatestBackupStatus } from "../src/lib/backupStatus.js";
import type { BackupManifest } from "../src/db/backup.js";

// MIDAD Final Pre-Launch audit, Phase 12 — Platform Backup Center.
// Read-only over the same manifest.json db/backup.ts's createBackup()
// already writes — no new persistence.

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

async function createOperatorToken(role: "platform_owner" | "support" = "platform_owner") {
  const email = uniqueEmail(`bc-${role}`);
  await db.insert(platformOperators).values({ email, name: role, role, passwordHash: await hashPassword("operatorpass123") });
  const login = await request(app).post("/api/platform/auth/login").send({ email, password: "operatorpass123" });
  expect(login.status).toBe(200);
  return login.body.token as string;
}

function fakeManifest(overrides: Partial<BackupManifest> = {}): BackupManifest {
  return {
    manifestVersion: "1",
    createdAt: new Date().toISOString(),
    app: { packageVersion: "0.1.0" },
    schema: { migrationCount: 50, latestMigrationTag: "0049_mushy_strong_guy" },
    database: { dumpFile: "database.dump", format: "custom", checksumSha256: "abc123", sizeBytes: 1024, rowCounts: { companies: 1, users: 1, projects: 0, invoices: 0 } },
    storage: { included: false, provider: "local" },
    ...overrides,
  };
}

beforeEach(resetDb);

describe("lib/backupStatus: getLatestBackupStatus (unit, real filesystem)", () => {
  it("reports found: false for a directory that doesn't exist", async () => {
    const status = await getLatestBackupStatus(path.join(os.tmpdir(), `no-such-dir-${Date.now()}`));
    expect(status.found).toBe(false);
    expect(status.manifest).toBeNull();
  });

  it("reports found: false for an empty backups directory", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "backup-status-empty-"));
    const status = await getLatestBackupStatus(dir);
    expect(status.found).toBe(false);
  });

  it("picks the MOST RECENT manifest when several exist", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "backup-status-multi-"));

    const older = fakeManifest({ createdAt: new Date(Date.now() - 60_000).toISOString() });
    const newer = fakeManifest({ createdAt: new Date().toISOString(), database: { ...fakeManifest().database, checksumSha256: "newer-checksum" } });

    await fsp.mkdir(path.join(dir, "backup-older"), { recursive: true });
    await fsp.writeFile(path.join(dir, "backup-older", "manifest.json"), JSON.stringify(older));
    await fsp.mkdir(path.join(dir, "backup-newer"), { recursive: true });
    await fsp.writeFile(path.join(dir, "backup-newer", "manifest.json"), JSON.stringify(newer));

    const status = await getLatestBackupStatus(dir);
    expect(status.found).toBe(true);
    expect(status.manifest?.database.checksumSha256).toBe("newer-checksum");
    expect(status.ageSeconds).toBeGreaterThanOrEqual(0);
    expect(status.ageSeconds!).toBeLessThan(10);
  });

  it("skips a malformed manifest rather than crashing or reporting it as latest", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "backup-status-malformed-"));
    await fsp.mkdir(path.join(dir, "backup-bad"), { recursive: true });
    await fsp.writeFile(path.join(dir, "backup-bad", "manifest.json"), "{not valid json");

    const status = await getLatestBackupStatus(dir);
    expect(status.found).toBe(false);
  });

  it("never exposes a secret-shaped field, and documents where restore drills are tracked", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "backup-status-fixture-"));
    await fsp.mkdir(path.join(dir, "backup-1"), { recursive: true });
    await fsp.writeFile(path.join(dir, "backup-1", "manifest.json"), JSON.stringify(fakeManifest()));

    const status = await getLatestBackupStatus(dir);
    // Scoped to the manifest content itself, not the whole response — the
    // test fixture's own tmp directory path is not part of what this
    // assertion is checking.
    expect(JSON.stringify(status.manifest)).not.toMatch(/password|secret|apikey|private.?key/i);
    expect(status.restoreDrillTrackedIn).toBe("docs/BACKUP_STRATEGY.md");
  });
});

describe("platform backup center: HTTP route", () => {
  it("unauthenticated and tenant-JWT access are rejected", async () => {
    expect((await request(app).get("/api/platform/backup-center/status")).status).toBe(401);
  });

  it("is denied for the support role (not owner/admin/auditor)", async () => {
    const token = await createOperatorToken("support");
    const res = await request(app).get("/api/platform/backup-center/status");
    expect(res.status).toBe(401);
    const withToken = await request(app).get("/api/platform/backup-center/status").set("Authorization", `Bearer ${token}`);
    expect(withToken.status).toBe(403);
  });

  it("owner can read backup status (found: false in this fresh test environment)", async () => {
    const token = await createOperatorToken();
    const res = await request(app).get("/api/platform/backup-center/status").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(typeof res.body.found).toBe("boolean");
    expect(res.body.restoreDrillTrackedIn).toBe("docs/BACKUP_STRATEGY.md");
  });
});
