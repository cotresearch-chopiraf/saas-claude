// Tenant-scoped repository functions for zatca_csr_instances (Slice J).
//
// This table is deliberately insert-only/historical from this module's
// point of view: there is no update() here for invoiceType, secretRef, or
// egsUnitId — those fields are immutable historical facts about one real
// CSR generation event (see db/schema.ts's file comment on the table).
// The only mutation this module offers is markSuperseded(), used when a
// later CSR generation for the same EGS unit replaces an earlier one.
//
// Same tenant-isolation contract as every other domain/ repository in this
// project: companyId is always the first argument, every query filters by
// it, and a lookup returns undefined/null for both "doesn't exist" and
// "belongs to a different company" — callers must never be able to tell
// those two cases apart from the return value alone.

import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { db } from "../../../db/client.js";
import { zatcaCsrInstances } from "../../../db/schema.js";
import type * as schema from "../../../db/schema.js";

type Tx = NodePgDatabase<typeof schema>;

export interface CreateCsrInstanceInput {
  egsUnitId: string;
  // See db/schema.ts's file comment — deliberately unconstrained and, in
  // this slice, never populated by any caller (undefined/null). The
  // column exists so a future verified taxonomy can be written here
  // without a schema change; nothing here invents one.
  purpose?: string | null;
  // The exact 4-digit value already validated by csr/csrBuilder.ts's
  // validateZatcaCsrFields — persisted verbatim, never reinterpreted.
  invoiceType: string;
  // Opaque ZatcaSecretStore reference for the key pair this CSR
  // generation produced — never the credential material itself.
  secretRef: string;
}

// Accepts an optional tx so this insert can share one transaction with
// the EGS-level projection updates it accompanies (see domain/csr.ts's
// generateCsrForEgsUnit) — same convention as domain/submissions.ts's
// createSubmission.
export async function createCsrInstance(companyId: string, input: CreateCsrInstanceInput, dbOrTx: Tx | typeof db = db) {
  const [created] = await dbOrTx
    .insert(zatcaCsrInstances)
    .values({
      companyId,
      egsUnitId: input.egsUnitId,
      purpose: input.purpose ?? null,
      invoiceType: input.invoiceType,
      secretRef: input.secretRef,
    })
    .returning();
  return created;
}

// Same "undefined means not found OR not yours" contract as getEgsUnit.
export async function getCsrInstance(companyId: string, csrInstanceId: string) {
  return db.query.zatcaCsrInstances.findFirst({
    where: and(eq(zatcaCsrInstances.id, csrInstanceId), eq(zatcaCsrInstances.companyId, companyId)),
  });
}

// Full history for one EGS unit, most recent first — every CSR generation
// this unit has ever had, per this slice's whole purpose.
export async function listCsrInstancesForEgsUnit(companyId: string, egsUnitId: string) {
  return db.query.zatcaCsrInstances.findMany({
    where: and(eq(zatcaCsrInstances.companyId, companyId), eq(zatcaCsrInstances.egsUnitId, egsUnitId)),
    orderBy: (c, { desc }) => [desc(c.generatedAt)],
  });
}

// The EGS unit's current (not-yet-superseded) CSR Instance, if any — used
// by generateCsrForEgsUnit to know which prior row (if any) a new
// generation supersedes. Accepts dbOrTx so the caller can run this inside
// the same transaction as the insert/update that follows it.
export async function findCurrentCsrInstance(companyId: string, egsUnitId: string, dbOrTx: Tx | typeof db = db) {
  return dbOrTx.query.zatcaCsrInstances.findFirst({
    where: and(
      eq(zatcaCsrInstances.companyId, companyId),
      eq(zatcaCsrInstances.egsUnitId, egsUnitId),
      eq(zatcaCsrInstances.status, "generated"),
    ),
    orderBy: (c, { desc }) => [desc(c.generatedAt)],
  });
}

// Slice K — does ANY CSR Instance for this company currently own this
// exact secretRef? Used by confirmCsidForEgsUnit to decide whether a
// secretRef it's about to replace is safe to delete from ZatcaSecretStore
// (no historical owner) or must be preserved (a zatca_csr_instances row
// still points to it — see db/schema.ts's file comment: a CSR Instance's
// own secretRef is set once at generation time and never updated, so this
// is a simple existence check, not a "current" lookup). Scoped to
// companyId only (not egsUnitId) since a secretRef is already a
// company-scoped, globally-unique-in-practice opaque string — matching
// every other tenant-isolated lookup in this module.
export async function findCsrInstanceBySecretRef(companyId: string, secretRef: string) {
  return db.query.zatcaCsrInstances.findFirst({
    where: and(eq(zatcaCsrInstances.companyId, companyId), eq(zatcaCsrInstances.secretRef, secretRef)),
  });
}

// Marks an earlier CSR Instance as superseded by a later one. Never
// deletes or overwrites the earlier row's own historical fields
// (invoiceType, secretRef, generatedAt) — only records the forward
// pointer. Returns undefined if the row doesn't exist or isn't this
// company's, matching every other repository function's contract.
export async function markCsrInstanceSuperseded(
  companyId: string,
  csrInstanceId: string,
  supersededByCsrInstanceId: string,
  dbOrTx: Tx | typeof db = db,
) {
  const [updated] = await dbOrTx
    .update(zatcaCsrInstances)
    .set({ status: "superseded", supersededBy: supersededByCsrInstanceId, updatedAt: new Date() })
    .where(and(eq(zatcaCsrInstances.id, csrInstanceId), eq(zatcaCsrInstances.companyId, companyId)))
    .returning();
  return updated;
}
