// Tenant-scoped repository functions for zatca_provider_operations
// (Slice W). Mirrors csrInstances.ts/complianceAttempts.ts exactly:
// companyId is always the first argument, every query filters by it, and
// a lookup returns undefined for both "doesn't exist" and "belongs to a
// different company" — callers must never be able to tell those two cases
// apart from the return value alone.
//
// Insert-only, like every other historical-execution table in this
// domain — there is no update() here. A row is created once, after the
// provider call has genuinely concluded (see domain/productionCsid.ts),
// and never mutated afterward.

import { and, eq } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { zatcaProviderOperations, type zatcaProviderOperationTypeEnum, type zatcaProviderOperationStatusEnum } from "../../../db/schema.js";

export interface CreateProviderOperationInput {
  egsUnitId: string;
  operationType: (typeof zatcaProviderOperationTypeEnum.enumValues)[number];
  internalStatus: (typeof zatcaProviderOperationStatusEnum.enumValues)[number];
  providerRequestId: string | null;
  dispositionMessage: string | null;
  providerOutcome: string | null;
  secretRef: string | null;
  errorCategory: string | null;
  startedAt: Date;
  finishedAt: Date;
}

export async function createProviderOperation(companyId: string, input: CreateProviderOperationInput) {
  const [created] = await db
    .insert(zatcaProviderOperations)
    .values({
      companyId,
      egsUnitId: input.egsUnitId,
      operationType: input.operationType,
      internalStatus: input.internalStatus,
      providerRequestId: input.providerRequestId,
      dispositionMessage: input.dispositionMessage,
      providerOutcome: input.providerOutcome,
      secretRef: input.secretRef,
      errorCategory: input.errorCategory,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
    })
    .returning();
  return created;
}

// Same "undefined means not found OR not yours" contract as every other
// tenant-scoped lookup in this domain.
export async function getProviderOperation(companyId: string, providerOperationId: string) {
  return db.query.zatcaProviderOperations.findFirst({
    where: and(eq(zatcaProviderOperations.id, providerOperationId), eq(zatcaProviderOperations.companyId, companyId)),
  });
}

// Full history for one EGS unit, most recent first — every provider
// operation (of any operationType) this EGS unit has ever had recorded.
export async function listProviderOperationsForEgsUnit(companyId: string, egsUnitId: string) {
  return db.query.zatcaProviderOperations.findMany({
    where: and(eq(zatcaProviderOperations.companyId, companyId), eq(zatcaProviderOperations.egsUnitId, egsUnitId)),
    orderBy: (o, { desc }) => [desc(o.startedAt)],
  });
}
