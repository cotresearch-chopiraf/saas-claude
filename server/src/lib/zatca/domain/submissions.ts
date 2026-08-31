// Tenant-scoped repository functions for zatca_submissions.
//
// "Exactly one of invoiceId/creditNoteId/debitNoteId" is authoritatively
// enforced by the database CHECK constraint
// zatca_submissions_exactly_one_document_reference (see db/schema.ts and
// drizzle/0019_naive_scourge.sql) — the check here is defense-in-depth,
// giving a clear application-level error instead of a raw Postgres
// constraint-violation message, not the source of truth for the invariant.

import { and, eq } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { invoices, zatcaEgsUnits, zatcaSubmissions, type zatcaDocumentTypeEnum, type zatcaEnvironmentEnum } from "../../../db/schema.js";
import { EgsUnitNotFoundError } from "./egsUnits.js";

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
}

export async function createSubmission(companyId: string, input: CreateSubmissionInput) {
  const referenceCount = [input.invoiceId, input.creditNoteId, input.debitNoteId].filter(Boolean).length;
  if (referenceCount !== 1) {
    throw new InvalidDocumentReferenceError(
      `A submission must reference exactly one document (invoice, credit note, or debit note); got ${referenceCount}`,
    );
  }

  const egsUnit = await db.query.zatcaEgsUnits.findFirst({
    where: and(eq(zatcaEgsUnits.id, input.egsUnitId), eq(zatcaEgsUnits.companyId, companyId)),
    columns: { id: true },
  });
  if (!egsUnit) throw new EgsUnitNotFoundError(input.egsUnitId);

  if (input.invoiceId) {
    const invoice = await db.query.invoices.findFirst({
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

  const [created] = await db
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
    })
    .returning();
  return created;
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
