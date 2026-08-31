// Tenant-scoped repository functions for zatca_egs_units.
//
// Every function requires companyId as its first, mandatory argument and
// every query filters by it — there is no function anywhere in this module
// that fetches a row by id alone. No route calls into this module yet (see
// the file-level comment on ../types.ts) — these are pure data-access
// functions a future route will call with req.companyId (the server-
// verified value from requireAuth), never a client-supplied value.

import { and, eq } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { zatcaEgsUnits, type zatcaEnvironmentEnum } from "../../../db/schema.js";

// The single source of truth for this error — icv.ts and pih.ts both
// import it from here rather than each declaring their own copy.
export class EgsUnitNotFoundError extends Error {
  constructor(egsUnitId: string) {
    super(`EGS unit ${egsUnitId} not found for this company`);
    this.name = "EgsUnitNotFoundError";
  }
}

export interface CreateEgsUnitInput {
  name: string;
  environment: (typeof zatcaEnvironmentEnum.enumValues)[number];
}

export async function createEgsUnit(companyId: string, input: CreateEgsUnitInput) {
  const [created] = await db
    .insert(zatcaEgsUnits)
    .values({ companyId, name: input.name, environment: input.environment })
    .returning();
  return created;
}

// Returns null both when the id doesn't exist AND when it belongs to a
// different company — the caller cannot distinguish "not found" from
// "not yours" from this function's return value alone, which is the
// correct behavior for a tenant-isolated lookup (mirrors every
// findOwned*() helper elsewhere in this codebase, e.g. routes/invoices.ts's
// findOwnedInvoice).
export async function getEgsUnit(companyId: string, egsUnitId: string) {
  return db.query.zatcaEgsUnits.findFirst({
    where: and(eq(zatcaEgsUnits.id, egsUnitId), eq(zatcaEgsUnits.companyId, companyId)),
  });
}

export async function listEgsUnits(companyId: string) {
  return db.query.zatcaEgsUnits.findMany({
    where: eq(zatcaEgsUnits.companyId, companyId),
    orderBy: (e, { desc }) => [desc(e.createdAt)],
  });
}
