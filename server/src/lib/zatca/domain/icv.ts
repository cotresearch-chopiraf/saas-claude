// Tenant-scoped, race-safe ICV (Invoice Counter Value) claiming — a
// dedicated counter per (companyId, egsUnitId), deliberately never
// companies.next_invoice_number (see schema.ts's file-level comment on the
// zatca_* tables for why).

import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { db } from "../../../db/client.js";
import { zatcaEgsUnits, zatcaIcvCounters } from "../../../db/schema.js";
import type * as schema from "../../../db/schema.js";
import { EgsUnitNotFoundError } from "./egsUnits.js";

type Tx = NodePgDatabase<typeof schema>;

// Single-statement upsert-and-increment: handles both "first claim ever
// for this (company, EGS)" and every subsequent claim atomically via
// Postgres's ON CONFLICT DO UPDATE, so there is no separate
// exists-then-insert race window the way a naive
// "SELECT ... ; INSERT IF MISSING ; UPDATE" sequence would have.
//
// Verifies the EGS unit itself belongs to companyId BEFORE touching the
// counter — the counter table's own two FKs (company_id→companies,
// egs_unit_id→zatca_egs_units) do not by themselves guarantee that
// particular egs_unit_id's own company_id matches; this explicit check is
// what actually closes that gap.
// Slice 4 — accepts an optional tx (the SAME transaction a caller is
// already holding, e.g. document-prepare's PIH row lock) so ICV claiming
// and PIH advancement commit or roll back together. Defaults to the
// module-level db for every existing (Slice 2/3) call site, unchanged.
export async function claimNextIcv(companyId: string, egsUnitId: string, dbOrTx: Tx | typeof db = db): Promise<number> {
  const egsUnit = await dbOrTx.query.zatcaEgsUnits.findFirst({
    where: and(eq(zatcaEgsUnits.id, egsUnitId), eq(zatcaEgsUnits.companyId, companyId)),
    columns: { id: true },
  });
  if (!egsUnit) throw new EgsUnitNotFoundError(egsUnitId);

  const result = await dbOrTx.execute<{ value: number }>(sql`
    INSERT INTO zatca_icv_counters (company_id, egs_unit_id, value)
    VALUES (${companyId}, ${egsUnitId}, 1)
    ON CONFLICT (company_id, egs_unit_id)
    DO UPDATE SET value = zatca_icv_counters.value + 1, updated_at = now()
    RETURNING value
  `);
  return result.rows[0].value;
}

// Read-only — for display/diagnostics, never for claiming (claimNextIcv is
// the only function that increments).
export async function getIcvCounter(companyId: string, egsUnitId: string) {
  return db.query.zatcaIcvCounters.findFirst({
    where: and(eq(zatcaIcvCounters.companyId, companyId), eq(zatcaIcvCounters.egsUnitId, egsUnitId)),
  });
}
