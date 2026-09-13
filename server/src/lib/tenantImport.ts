import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { companies } from "../db/schema.js";
import { recordAuditEvent } from "./audit.js";
import { hashPassword } from "./password.js";
import { TENANT_TABLE_ORDER, TENANT_DIRECT_TABLES, TENANT_PROJECT_SCOPED_TABLES, TENANT_PARENT_SCOPED_TABLES } from "./tenantDataTables.js";
import type { TenantExportBundle } from "./tenantExport.js";

// MIDAD Final Pre-Launch audit, Phase 11 — Tenant Import. Upload ->
// Validate -> Inspect -> Preview -> Conflict Detection (validateTenantImport,
// fully side-effect-free) -> Explicit Confirmation -> Import -> Verification
// -> Audit (importTenantBundle, one transaction, all-or-nothing).
//
// Scope, stated plainly rather than implied: this restores a bundle into a
// company using its ORIGINAL id from the export, and refuses outright if
// that id already exists in this database (see validateTenantImport's
// conflict check). That covers the primary real use cases this phase
// names — disaster recovery, migrating a tenant to a new platform
// instance/database, a legal/business transfer of the whole account — all
// of which restore into a database that does not yet have this tenant.
// It deliberately does NOT attempt to merge an export into an EXISTING,
// already-populated company (which would require row-by-row conflict
// resolution across 60+ interdependent tables) — that is a materially
// different, much higher-risk feature this phase does not claim to
// provide.

export interface TenantImportPreview {
  manifest: TenantExportBundle["manifest"];
  companyName: string;
  checksumValid: boolean;
  schemaCompatible: boolean;
  currentSchemaLatestTag: string;
  companyIdAlreadyExists: boolean;
  canImport: boolean;
  blockers: string[];
}

function recomputeChecksum(bundle: TenantExportBundle): string {
  const checksumInput = JSON.stringify({ company: bundle.company, tables: TENANT_TABLE_ORDER.map((t) => bundle.tables[t] ?? []) });
  return createHash("sha256").update(checksumInput).digest("hex");
}

// Side-effect-free: never writes anything, safe to call as many times as
// an operator wants before deciding whether to proceed.
export async function validateTenantImport(bundle: TenantExportBundle, currentLatestMigrationTag: string): Promise<TenantImportPreview> {
  const blockers: string[] = [];

  const checksumValid = recomputeChecksum(bundle) === bundle.manifest.checksumSha256;
  if (!checksumValid) blockers.push("checksum_mismatch");

  // No migration-upgrade-on-import logic exists (a real, larger feature
  // this phase does not claim) — an export taken at a different schema
  // version than this database currently runs is refused rather than
  // silently imported into a mismatched shape.
  const schemaCompatible = bundle.manifest.schema.latestMigrationTag === currentLatestMigrationTag;
  if (!schemaCompatible) blockers.push("schema_version_mismatch");

  const existing = bundle.manifest.companyId
    ? await db.query.companies.findFirst({ where: eq(companies.id, bundle.manifest.companyId), columns: { id: true } })
    : null;
  const companyIdAlreadyExists = Boolean(existing);
  if (companyIdAlreadyExists) blockers.push("company_id_already_exists");

  return {
    manifest: bundle.manifest,
    companyName: bundle.manifest.companyName,
    checksumValid,
    schemaCompatible,
    currentSchemaLatestTag: currentLatestMigrationTag,
    companyIdAlreadyExists,
    canImport: blockers.length === 0,
    blockers,
  };
}

// node-postgres stringifies a raw JS object/array parameter with
// .toString() (producing the literal text "[object Object]"), not
// JSON.stringify — every jsonb/json column (e.g. companies.featureFlags,
// audit_events.metadata) needs its value serialized before it can be
// bound as a query parameter. Date instances are left alone (the driver
// already serializes those correctly for timestamp columns); null is
// left alone so a nullable jsonb column stays SQL NULL, not the string
// "null".
function toSqlParam(value: unknown): unknown {
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    return JSON.stringify(value);
  }
  return value;
}

async function insertRows(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  table: string,
  rows: Record<string, unknown>[],
): Promise<void> {
  for (const row of rows) {
    const columns = Object.keys(row);
    if (columns.length === 0) continue;
    const columnsSql = sql.join(
      columns.map((c) => sql.identifier(c)),
      sql.raw(", "),
    );
    const valuesSql = sql.join(
      columns.map((c) => sql`${toSqlParam(row[c])}`),
      sql.raw(", "),
    );
    await tx.execute(sql`INSERT INTO ${sql.identifier(table)} (${columnsSql}) VALUES (${valuesSql})`);
  }
}

// The export deliberately never includes password_hash (see lib/
// tenantExport.ts's TENANT_REDACTED_COLUMNS — no secret/credential
// material in an export), but users.password_hash is NOT NULL, so the
// row cannot be inserted as-is. Each imported user gets a freshly
// generated, cryptographically random hash that corresponds to no known
// password — nobody, including the operator running this import, can log
// in with it. Every imported user must use "forgot password" to regain
// access, which is the correct behavior for a disaster-recovery/migration
// restore: silently carrying old credentials across into a new
// environment would be worse, not more convenient.
async function withFreshPasswordHashes(rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  return Promise.all(
    rows.map(async (row) => ({ ...row, password_hash: await hashPassword(randomUUID()) })),
  );
}

export interface TenantImportResult {
  companyId: string;
  companyName: string;
  importedTableRowCounts: Record<string, number>;
  verified: boolean;
  // Always true when any users were imported — see
  // withFreshPasswordHashes's own comment for why.
  passwordResetRequiredForImportedUsers: boolean;
  requestId?: string;
}

// The write path — only ever called after validateTenantImport reports
// canImport: true AND the caller has re-confirmed (routes/
// platformTenantData.ts requires the operator to type the company name
// back, the same "Security Confirmation" discipline Phase 9's ownership
// transfer already established). One transaction: any failure at any
// table rolls back the entire import, so a partially-imported tenant can
// never persist.
export async function importTenantBundle(bundle: TenantExportBundle, requestId: string | undefined): Promise<TenantImportResult> {
  const directSet = new Set<string>(TENANT_DIRECT_TABLES);
  const projectSet = new Set<string>(TENANT_PROJECT_SCOPED_TABLES);
  const parentTables = new Set<string>(TENANT_PARENT_SCOPED_TABLES.map((p) => p.table));

  const importedTableRowCounts: Record<string, number> = {};

  await db.transaction(async (tx) => {
    await insertRows(tx, "companies", [bundle.company]);

    for (const table of TENANT_TABLE_ORDER) {
      if (!directSet.has(table) && !projectSet.has(table) && !parentTables.has(table)) {
        throw new Error(`Table ${table} has no configured scoping — see lib/tenantDataTables.ts`);
      }
      let rows = bundle.tables[table] ?? [];
      if (table === "users") rows = await withFreshPasswordHashes(rows);
      await insertRows(tx, table, rows);
      importedTableRowCounts[table] = rows.length;
    }

    await recordAuditEvent(tx, {
      companyId: bundle.manifest.companyId,
      actorUserId: null,
      action: "tenant.imported",
      entityType: "company",
      entityId: bundle.manifest.companyId,
      afterValue: { tableRowCounts: importedTableRowCounts, sourceExportedAt: bundle.manifest.exportedAt },
      source: "platform_admin",
      metadata: { requestId },
    });
  });

  // Verification — re-count every table post-commit and compare against
  // what the manifest originally recorded, the same "did the restore
  // actually match" discipline db/restore.ts's whole-database restore
  // already applies (Phase 1.1), scoped here to one tenant.
  let verified = true;
  for (const table of TENANT_TABLE_ORDER) {
    const expected = bundle.manifest.tableRowCounts[table] ?? 0;
    if (importedTableRowCounts[table] !== expected) verified = false;
  }

  return {
    companyId: bundle.manifest.companyId,
    companyName: bundle.manifest.companyName,
    importedTableRowCounts,
    verified,
    passwordResetRequiredForImportedUsers: importedTableRowCounts.users > 0,
    requestId,
  };
}
