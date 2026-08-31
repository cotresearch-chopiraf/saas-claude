// PIH (Previous Invoice Hash) chain pointer — one mutable pointer per EGS
// unit (zatca_egs_units.last_document_hash), read and updated only under a
// row lock so two concurrent submissions for the same EGS can never both
// read the same "previous hash" and race to update it. Genesis handling
// (what the pointer means when it is still NULL) and the actual hashing
// function live in ../hash.ts; this module only manages the persisted
// pointer, tenant-scoped.
//
// No submission function calls this yet — this slice adds the primitive
// only, not a caller.

import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { db } from "../../../db/client.js";
import { zatcaEgsUnits } from "../../../db/schema.js";
import type * as schema from "../../../db/schema.js";
import { GENESIS_PREVIOUS_INVOICE_HASH } from "../hash.js";
import { EgsUnitNotFoundError } from "./egsUnits.js";

type Tx = NodePgDatabase<typeof schema>;

// Must be called inside an existing db.transaction(async (tx) => {...}) —
// the caller passes that tx so the row lock this function takes lives for
// the lifetime of the caller's own transaction, not just this one
// statement. Returns the genesis hash when no document has been submitted
// for this EGS yet (last_document_hash still NULL), matching the
// cross-corroborated ZATCA convention documented in ../hash.ts.
export async function lockAndReadPihPointer(tx: Tx, companyId: string, egsUnitId: string): Promise<string> {
  const rows = await tx.execute<{ last_document_hash: string | null }>(sql`
    SELECT last_document_hash FROM zatca_egs_units
    WHERE id = ${egsUnitId} AND company_id = ${companyId}
    FOR UPDATE
  `);
  if (rows.rows.length === 0) throw new EgsUnitNotFoundError(egsUnitId);
  return rows.rows[0].last_document_hash ?? GENESIS_PREVIOUS_INVOICE_HASH;
}

// Must be called with the SAME tx (and therefore the same held row lock)
// as the preceding lockAndReadPihPointer call in the same operation.
export async function updatePihPointer(tx: Tx, companyId: string, egsUnitId: string, newHash: string): Promise<void> {
  await tx
    .update(zatcaEgsUnits)
    .set({ lastDocumentHash: newHash, updatedAt: new Date() })
    .where(and(eq(zatcaEgsUnits.id, egsUnitId), eq(zatcaEgsUnits.companyId, companyId)));
}

// Read-only, no lock — for display/diagnostics only (e.g. showing the
// current chain position without intending to submit anything).
export async function peekPihPointer(companyId: string, egsUnitId: string): Promise<string> {
  const unit = await db.query.zatcaEgsUnits.findFirst({
    where: and(eq(zatcaEgsUnits.id, egsUnitId), eq(zatcaEgsUnits.companyId, companyId)),
    columns: { lastDocumentHash: true },
  });
  if (!unit) throw new EgsUnitNotFoundError(egsUnitId);
  return unit.lastDocumentHash ?? GENESIS_PREVIOUS_INVOICE_HASH;
}
