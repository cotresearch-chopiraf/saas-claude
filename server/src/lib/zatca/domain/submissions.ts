// Tenant-scoped repository functions for zatca_submissions.
//
// "Exactly one of invoiceId/creditNoteId/debitNoteId" is authoritatively
// enforced by the database CHECK constraint
// zatca_submissions_exactly_one_document_reference (see db/schema.ts and
// drizzle/0019_naive_scourge.sql) — the check here is defense-in-depth,
// giving a clear application-level error instead of a raw Postgres
// constraint-violation message, not the source of truth for the invariant.

import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { db } from "../../../db/client.js";
import {
  invoices,
  zatcaEgsUnits,
  zatcaSubmissions,
  type zatcaDocumentTypeEnum,
  type zatcaEnvironmentEnum,
  type zatcaSubmissionStateEnum,
} from "../../../db/schema.js";
import type * as schema from "../../../db/schema.js";
import { EgsUnitNotFoundError } from "./egsUnits.js";

type Tx = NodePgDatabase<typeof schema>;

export class InvalidDocumentReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDocumentReferenceError";
  }
}

export class CrossTenantReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrossTenantReferenceError";
  }
}

export interface CreateSubmissionInput {
  egsUnitId: string;
  invoiceId?: string;
  creditNoteId?: string;
  debitNoteId?: string;
  documentTypeCode: (typeof zatcaDocumentTypeEnum.enumValues)[number];
  subtype: "standard" | "simplified";
  zatcaUuid: string;
  icv: number;
  pih: string;
  documentHash: string;
  environment: (typeof zatcaEnvironmentEnum.enumValues)[number];
  // Optional — omitted entirely leaves the schema's own default
  // ("not_submitted") in place, unchanged from Slice 2. Slice 4's
  // /prepare route passes "ready_for_submission" explicitly once XML/
  // hash/ICV/PIH are all real; every other existing caller is unaffected.
  state?: (typeof zatcaSubmissionStateEnum.enumValues)[number];
}

// Slice 4 — accepts an optional tx so this insert can share the same
// transaction as claimNextIcv/updatePihPointer during document prepare
// (see routes/zatca.ts's /prepare handler): if the submission insert
// fails, the ICV claim and PIH advancement roll back with it, so a
// document is never "counted" without a corresponding persisted record.
export async function createSubmission(companyId: string, input: CreateSubmissionInput, dbOrTx: Tx | typeof db = db) {
  const referenceCount = [input.invoiceId, input.creditNoteId, input.debitNoteId].filter(Boolean).length;
  if (referenceCount !== 1) {
    throw new InvalidDocumentReferenceError(
      `A submission must reference exactly one document (invoice, credit note, or debit note); got ${referenceCount}`,
    );
  }

  const egsUnit = await dbOrTx.query.zatcaEgsUnits.findFirst({
    where: and(eq(zatcaEgsUnits.id, input.egsUnitId), eq(zatcaEgsUnits.companyId, companyId)),
    columns: { id: true },
  });
  if (!egsUnit) throw new EgsUnitNotFoundError(input.egsUnitId);

  if (input.invoiceId) {
    const invoice = await dbOrTx.query.invoices.findFirst({
      where: and(eq(invoices.id, input.invoiceId), eq(invoices.companyId, companyId)),
      columns: { id: true },
    });
    if (!invoice) {
      throw new CrossTenantReferenceError(`Invoice ${input.invoiceId} does not belong to this company`);
    }
  }
  // creditNoteId/debitNoteId ownership checks will be added once those
  // tables exist (a later, separately-gated slice) — see
  // docs/ZATCA_IMPLEMENTATION_STATUS.md.

  const [created] = await dbOrTx
    .insert(zatcaSubmissions)
    .values({
      companyId,
      egsUnitId: input.egsUnitId,
      invoiceId: input.invoiceId,
      creditNoteId: input.creditNoteId,
      debitNoteId: input.debitNoteId,
      documentTypeCode: input.documentTypeCode,
      subtype: input.subtype,
      zatcaUuid: input.zatcaUuid,
      icv: input.icv,
      pih: input.pih,
      documentHash: input.documentHash,
      environment: input.environment,
      ...(input.state ? { state: input.state } : {}),
    })
    .returning();
  return created;
}

// Slice 4 — idempotency lookup: "does a submission already exist for this
// exact (company, EGS unit, invoice) tuple?" Called BEFORE claiming a new
// ICV/PIH slot so a repeated prepare request reuses the existing
// submission instead of consuming another counter value or creating a
// duplicate row. Same tenant-isolation contract as getSubmission.
export async function findSubmissionForInvoice(companyId: string, egsUnitId: string, invoiceId: string) {
  return db.query.zatcaSubmissions.findFirst({
    where: and(
      eq(zatcaSubmissions.companyId, companyId),
      eq(zatcaSubmissions.egsUnitId, egsUnitId),
      eq(zatcaSubmissions.invoiceId, invoiceId),
    ),
  });
}

export interface SubmissionOutcomeInput {
  state: (typeof zatcaSubmissionStateEnum.enumValues)[number];
  zatcaStatus?: string | null;
  zatcaErrorCode?: string | null;
  zatcaErrorMessage?: string | null;
  requestId?: string | null;
  correlationId?: string | null;
  submittedAt?: Date;
  respondedAt?: Date;
  incrementRetryCount?: boolean;
}

// Slice 4 — persists the real result of a submit attempt (success or
// failure alike). Never called with anything but values already derived
// from a real provider response or a real ZatcaError — see routes/zatca.ts's
// /submit handler. Never accepts or writes response body/header/secret
// material; the caller is responsible for having already reduced the
// provider's response to these safe, structured fields.
export async function recordSubmissionOutcome(companyId: string, submissionId: string, input: SubmissionOutcomeInput) {
  const existing = await getSubmission(companyId, submissionId);
  if (!existing) return undefined;

  const [updated] = await db
    .update(zatcaSubmissions)
    .set({
      state: input.state,
      zatcaStatus: input.zatcaStatus ?? existing.zatcaStatus,
      zatcaErrorCode: input.zatcaErrorCode ?? null,
      zatcaErrorMessage: input.zatcaErrorMessage ?? null,
      requestId: input.requestId ?? existing.requestId,
      correlationId: input.correlationId ?? existing.correlationId,
      submittedAt: input.submittedAt ?? existing.submittedAt,
      respondedAt: input.respondedAt ?? existing.respondedAt,
      retryCount: input.incrementRetryCount ? existing.retryCount + 1 : existing.retryCount,
      updatedAt: new Date(),
    })
    .where(and(eq(zatcaSubmissions.id, submissionId), eq(zatcaSubmissions.companyId, companyId)))
    .returning();
  return updated;
}

// Slice 4 — company-wide submission history (the tenant UI's History tab),
// unlike listSubmissionsForEgsUnit which is scoped to one unit.
export async function listSubmissionsForCompany(companyId: string) {
  return db.query.zatcaSubmissions.findMany({
    where: eq(zatcaSubmissions.companyId, companyId),
    orderBy: (s, { desc }) => [desc(s.createdAt)],
  });
}

// Same "null means not found OR not yours" contract as getEgsUnit.
export async function getSubmission(companyId: string, submissionId: string) {
  return db.query.zatcaSubmissions.findFirst({
    where: and(eq(zatcaSubmissions.id, submissionId), eq(zatcaSubmissions.companyId, companyId)),
  });
}

export async function listSubmissionsForEgsUnit(companyId: string, egsUnitId: string) {
  return db.query.zatcaSubmissions.findMany({
    where: and(eq(zatcaSubmissions.companyId, companyId), eq(zatcaSubmissions.egsUnitId, egsUnitId)),
    orderBy: (s, { desc }) => [desc(s.createdAt)],
  });
}
