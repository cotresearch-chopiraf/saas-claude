// Tenant-scoped repository functions for zatca_egs_units.
//
// Every function requires companyId as its first, mandatory argument and
// every query filters by it — there is no function anywhere in this module
// that fetches a row by id alone. Consumed by routes/zatca.ts (Slice 3)
// with req.companyId (the server-verified value from requireAuth), never a
// client-supplied value.

import { and, eq } from "drizzle-orm";
import { db } from "../../../db/client.js";
import {
  zatcaEgsUnits,
  type zatcaEgsStatusEnum,
  type zatcaEnvironmentEnum,
  type zatcaCsidStatusEnum,
} from "../../../db/schema.js";

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

// Slice 3 — associates a secretRef (an opaque reference into
// ZatcaSecretStore, never real credential material) with an EGS unit.
// Returns undefined when the unit doesn't exist or isn't this company's,
// matching getEgsUnit's tenant-isolation contract.
export async function setEgsUnitSecretRef(companyId: string, egsUnitId: string, secretRef: string | null) {
  const [updated] = await db
    .update(zatcaEgsUnits)
    .set({ secretRef, updatedAt: new Date() })
    .where(and(eq(zatcaEgsUnits.id, egsUnitId), eq(zatcaEgsUnits.companyId, companyId)))
    .returning();
  return updated;
}

// Slice 3 — records the outcome of a real connection-check/onboarding
// transition. Deliberately narrow: the only writer of zatca_egs_units.status
// outside creation, called only from the /verify-connection route and only
// with a status this codebase itself derived from a real provider response
// (never a client-supplied value — see routes/zatca.ts).
export async function updateEgsUnitStatus(
  companyId: string,
  egsUnitId: string,
  status: (typeof zatcaEgsStatusEnum.enumValues)[number],
  options: { lastCommunicationAt?: Date } = {},
) {
  const [updated] = await db
    .update(zatcaEgsUnits)
    .set({
      status,
      updatedAt: new Date(),
      ...(options.lastCommunicationAt ? { lastCommunicationAt: options.lastCommunicationAt } : {}),
    })
    .where(and(eq(zatcaEgsUnits.id, egsUnitId), eq(zatcaEgsUnits.companyId, companyId)))
    .returning();
  return updated;
}

// Slice 5 continuation — records a real CSID lifecycle transition (never
// a client-supplied value; only domain/csr.ts calls this, and only after
// generating a real CSR or confirming a real certificate — see its own
// file comment). certificateExpiresAt is set only when a real certificate
// was just parsed (CSID confirmation), never guessed.
export async function updateEgsUnitCsidStatus(
  companyId: string,
  egsUnitId: string,
  csidStatus: (typeof zatcaCsidStatusEnum.enumValues)[number],
  options: { certificateExpiresAt?: Date } = {},
) {
  const [updated] = await db
    .update(zatcaEgsUnits)
    .set({
      csidStatus,
      updatedAt: new Date(),
      ...(options.certificateExpiresAt ? { certificateExpiresAt: options.certificateExpiresAt } : {}),
    })
    .where(and(eq(zatcaEgsUnits.id, egsUnitId), eq(zatcaEgsUnits.companyId, companyId)))
    .returning();
  return updated;
}

// Slice 3 — records that a communication attempt happened without
// necessarily changing the unit's status (e.g. a rejected/failed check).
export async function touchEgsUnitLastCommunication(companyId: string, egsUnitId: string, at: Date) {
  await db
    .update(zatcaEgsUnits)
    .set({ lastCommunicationAt: at, updatedAt: new Date() })
    .where(and(eq(zatcaEgsUnits.id, egsUnitId), eq(zatcaEgsUnits.companyId, companyId)));
}
