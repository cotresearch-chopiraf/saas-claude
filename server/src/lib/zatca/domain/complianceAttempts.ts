// Tenant-scoped repository functions for zatca_compliance_attempts
// (Slice M). Mirrors csrInstances.ts/complianceLifecycles.ts exactly:
// companyId is always the first argument, every query filters by it, and
// a lookup returns undefined for both "doesn't exist" and "belongs to a
// different company" — callers must never be able to tell those two cases
// apart from the return value alone.
//
// Insert-only, like zatca_csr_instances — there is no update() here.
// Every field this table has is either a fixed historical fact about one
// real (or attempted) provider call, set once at creation, or the
// self-referencing retryOfAttemptId, which this slice's domain flow never
// sets (see db/schema.ts's file comment) and therefore has no update path
// either — a future slice with a real, verified retry identity can add
// one then.

import { and, eq } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { zatcaComplianceAttempts, type zatcaDocumentTypeEnum } from "../../../db/schema.js";

export interface CreateComplianceAttemptInput {
  complianceLifecycleId: string;
  documentType: (typeof zatcaDocumentTypeEnum.enumValues)[number];
  // Verbatim ZatcaSubmissionResult fields (provider/types.ts) when the
  // provider call returned one; null when it threw instead — see
  // domain/complianceInvoice.ts's file comment for exactly when each case
  // applies.
  correlationId: string | null;
  rawStatus: string | null;
  normalizedOutcome: string | null;
  attemptedAt: Date;
  // The thrown ZatcaError's own category, when the provider call itself
  // failed outright; null on a real (even "rejected") ZatcaSubmissionResult.
  errorCategory: string | null;
  // Reserved — see db/schema.ts's file comment on why this slice never
  // populates it (no distinct ZATCA-native error-code concept exists
  // anywhere in this codebase today).
  errorCode: string | null;
}

export async function createComplianceAttempt(companyId: string, input: CreateComplianceAttemptInput) {
  const [created] = await db
    .insert(zatcaComplianceAttempts)
    .values({
      companyId,
      complianceLifecycleId: input.complianceLifecycleId,
      documentType: input.documentType,
      correlationId: input.correlationId,
      rawStatus: input.rawStatus,
      normalizedOutcome: input.normalizedOutcome,
      attemptedAt: input.attemptedAt,
      errorCategory: input.errorCategory,
      errorCode: input.errorCode,
    })
    .returning();
  return created;
}

// Same "undefined means not found OR not yours" contract as getCsrInstance
// / getComplianceLifecycle.
export async function getComplianceAttempt(companyId: string, complianceAttemptId: string) {
  return db.query.zatcaComplianceAttempts.findFirst({
    where: and(eq(zatcaComplianceAttempts.id, complianceAttemptId), eq(zatcaComplianceAttempts.companyId, companyId)),
  });
}

// Full history for one Compliance Lifecycle, most recent first — every
// real (or attempted) Compliance Invoice call this lifecycle has ever
// had. Deliberately no uniqueness assumption anywhere in this query or
// the table itself — multiple attempts, including same-documentType
// attempts, are expected.
export async function listComplianceAttemptsForLifecycle(companyId: string, complianceLifecycleId: string) {
  return db.query.zatcaComplianceAttempts.findMany({
    where: and(eq(zatcaComplianceAttempts.companyId, companyId), eq(zatcaComplianceAttempts.complianceLifecycleId, complianceLifecycleId)),
    orderBy: (a, { desc }) => [desc(a.attemptedAt)],
  });
}
