import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { readMigrationState } from "../db/backup.js";
import {
  TENANT_TABLE_ORDER,
  TENANT_DIRECT_TABLES,
  TENANT_PROJECT_SCOPED_TABLES,
  TENANT_PARENT_SCOPED_TABLES,
  TENANT_REDACTED_COLUMNS,
  TENANT_EXCLUDED_TABLES,
  TENANT_EXPORT_INCLUDES_DOCUMENT_BYTES,
} from "./tenantDataTables.js";

// MIDAD Final Pre-Launch audit, Phase 10 — Tenant Export. Builds a single
// JSON-serializable bundle for one company: its own row plus every
// company-scoped table in lib/tenantDataTables.ts's TENANT_TABLE_ORDER,
// filtered correctly per that table's own scoping kind (direct
// company_id, project_id-scoped, or parent-row-scoped). Read-only —
// nothing here writes anything.

export interface TenantExportManifest {
  manifestVersion: "1";
  exportedAt: string;
  schema: { migrationCount: number; latestMigrationTag: string };
  companyId: string;
  companyName: string;
  includesAuditEvents: true;
  includesDocumentBytes: boolean;
  redactedColumns: Record<string, string[]>;
  excludedTables: readonly string[];
  tableRowCounts: Record<string, number>;
  checksumSha256: string;
}

export interface TenantExportBundle {
  manifest: TenantExportManifest;
  company: Record<string, unknown>;
  tables: Record<string, Record<string, unknown>[]>;
}

function redactRow(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const redacted = TENANT_REDACTED_COLUMNS[table];
  if (!redacted) return row;
  const copy = { ...row };
  for (const column of redacted) delete copy[column];
  return copy;
}

async function fetchDirectTable(table: string, companyId: string): Promise<Record<string, unknown>[]> {
  const result = await db.execute(
    // Every table in this codebase has "id" as its primary key (verified
    // — see lib/tenantDataTables.ts's header comment on how this table
    // set was derived), so ordering by id alone is deterministic and
    // universal without needing to know each table's own timestamp
    // column name (not every table calls it created_at — e.g.
    // client_project_access uses granted_at).
    sql`SELECT * FROM ${sql.identifier(table)} WHERE company_id = ${companyId} ORDER BY id`,
  );
  return result.rows.map((row) => redactRow(table, row as Record<string, unknown>));
}

async function fetchProjectScopedTable(table: string, companyId: string): Promise<Record<string, unknown>[]> {
  const result = await db.execute(
    sql`SELECT t.* FROM ${sql.identifier(table)} t
        JOIN projects p ON p.id = t.project_id
        WHERE p.company_id = ${companyId}
        ORDER BY t.id`,
  );
  return result.rows.map((row) => redactRow(table, row as Record<string, unknown>));
}

async function fetchParentScopedTable(
  table: string,
  parentTable: string,
  parentIdColumn: string,
  companyId: string,
): Promise<Record<string, unknown>[]> {
  const result = await db.execute(
    sql`SELECT t.* FROM ${sql.identifier(table)} t
        JOIN ${sql.identifier(parentTable)} parent ON parent.id = t.${sql.identifier(parentIdColumn)}
        WHERE parent.company_id = ${companyId}
        ORDER BY t.id`,
  );
  return result.rows.map((row) => redactRow(table, row as Record<string, unknown>));
}

function serverRootDir(): string {
  // server/src/lib/tenantExport.ts -> server/
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

// Exported for lib/tenantImport.ts's validateTenantImport / routes/
// platformTenantData.ts, which need the SAME "current schema version" the
// export manifest itself was stamped with.
export function readMigrationStateFromServerRoot(): { migrationCount: number; latestMigrationTag: string } {
  return readMigrationState(serverRootDir());
}

export async function buildTenantExport(companyId: string): Promise<TenantExportBundle> {
  // Fetched via raw SQL, NOT db.query.companies.findFirst() — Drizzle's
  // relational query API maps rows to camelCase JS property names
  // (logoPath, taxId, ...), but the actual Postgres columns are snake_case
  // (logo_path, tax_id, ...). Every other table in this export is already
  // fetched via raw SQL (real column names); the company row must match,
  // or lib/tenantImport.ts's insertRows (which builds INSERT column lists
  // directly from each row's own object keys) would generate invalid
  // column names for this one row.
  const companyResult = await db.execute(sql`SELECT * FROM companies WHERE id = ${companyId}`);
  const companyRow = companyResult.rows[0] as Record<string, unknown> | undefined;
  if (!companyRow) throw new Error(`Company ${companyId} not found`);

  const directSet = new Set<string>(TENANT_DIRECT_TABLES);
  const projectSet = new Set<string>(TENANT_PROJECT_SCOPED_TABLES);
  const parentByTable = new Map<string, (typeof TENANT_PARENT_SCOPED_TABLES)[number]>(
    TENANT_PARENT_SCOPED_TABLES.map((p) => [p.table, p]),
  );

  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const table of TENANT_TABLE_ORDER) {
    if (directSet.has(table)) {
      tables[table] = await fetchDirectTable(table, companyId);
    } else if (projectSet.has(table)) {
      tables[table] = await fetchProjectScopedTable(table, companyId);
    } else {
      const parent = parentByTable.get(table);
      if (!parent) throw new Error(`Table ${table} has no configured scoping — see lib/tenantDataTables.ts`);
      tables[table] = await fetchParentScopedTable(parent.table, parent.parentTable, parent.parentIdColumn, companyId);
    }
  }

  const tableRowCounts: Record<string, number> = {};
  for (const [table, rows] of Object.entries(tables)) tableRowCounts[table] = rows.length;

  // Checksum is over the company row + every table's rows, in the fixed
  // TENANT_TABLE_ORDER — deterministic regardless of any incidental
  // object-key ordering JS might otherwise introduce, since the table
  // list order is fixed and each table's rows are themselves ordered by
  // the SELECT's own ORDER BY.
  const checksumInput = JSON.stringify({ company: companyRow, tables: TENANT_TABLE_ORDER.map((t) => tables[t]) });
  const checksumSha256 = createHash("sha256").update(checksumInput).digest("hex");

  const migrationState = readMigrationState(serverRootDir());

  const manifest: TenantExportManifest = {
    manifestVersion: "1",
    exportedAt: new Date().toISOString(),
    schema: migrationState,
    companyId,
    companyName: companyRow.name as string,
    includesAuditEvents: true,
    includesDocumentBytes: TENANT_EXPORT_INCLUDES_DOCUMENT_BYTES,
    redactedColumns: TENANT_REDACTED_COLUMNS,
    excludedTables: TENANT_EXCLUDED_TABLES,
    tableRowCounts,
    checksumSha256,
  };

  return { manifest, company: redactRow("companies", companyRow), tables };
}
