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

// Slice Q-Implementation — deliberately NOT lib/zatca/types.ts's
// ZatcaInvoiceSubtype, despite the identical value set. See db/schema.ts's
// zatcaComplianceAttempts comment: that type/column concerns a real
// invoice's B2B/B2C business classification (derived from
// invoices.clientTaxId), an unrelated concept to which ZATCA compliance-
// test family a Compliance Attempt targeted. Declared once here (this
// table's own repository module) and imported by domain/complianceInvoice.ts
// rather than duplicated.
export type InvoiceFamily = "standard" | "simplified";

export interface CreateComplianceAttemptInput {
  complianceLifecycleId: string;
  documentType: (typeof zatcaDocumentTypeEnum.enumValues)[number];
  // Which ZATCA compliance-test family this attempt targeted — caller-
  // supplied, never derived (see domain/complianceInvoice.ts's CSR-
  // compatibility validation). Required: distinguishes an otherwise-
  // identical documentType "388" attempt under a "1100" CSR (which
  // supports both families) from its counterpart in the other family —
  // see db/schema.ts's column comment for the full historical-integrity
  // reasoning.
  invoiceFamily: InvoiceFamily;
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
      invoiceFamily: input.invoiceFamily,
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
