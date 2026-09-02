// Tenant-scoped repository functions for zatca_compliance_lifecycles
// (Slice L). Mirrors csrInstances.ts's structure and conventions exactly:
// companyId is always the first argument, every query filters by it, and
// a lookup returns undefined for both "doesn't exist" and "belongs to a
// different company" — callers must never be able to tell those two cases
// apart from the return value alone.
//
// No update()/status-transition function exists here — see db/schema.ts's
// file comment on zatcaComplianceLifecycleStatusEnum: nothing in this
// slice's domain flow (domain/complianceCsid.ts) ever transitions a row's
// status after insert, so a status-update function would be speculative,
// untested code. A future slice that adds a real, verified transition can
// add one then.

import { and, eq } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { zatcaComplianceLifecycles } from "../../../db/schema.js";

export interface CreateComplianceLifecycleInput {
  csrInstanceId: string;
  // Normalized by the provider layer (see provider/types.ts's
  // ZatcaComplianceCsidResult.requestId) — persisted verbatim here, never
  // re-derived or reinterpreted.
  requestId: string;
  dispositionMessage: string;
  // Opaque ZatcaSecretStore reference for the Compliance CSID credential
  // (binarySecurityToken + secret) — never the credential material
  // itself, and never the owning CSR Instance's own secretRef (see
  // domain/complianceCsid.ts's file comment).
  secretRef: string;
}

// Inserts the one-and-only Compliance Lifecycle row for a CSR Instance.
// Relies on the database's own unique index
// (zatca_compliance_lifecycles_csr_instance_unique) to enforce the CSR
// Instance (1) -> Compliance Lifecycle (0..1) cardinality — callers that
// need a friendlier pre-check should call
// getComplianceLifecycleForCsrInstance first (see
// domain/complianceCsid.ts), but this function itself does not silently
// swallow a duplicate: a second insert for the same csrInstanceId throws a
// raw Postgres unique-violation, propagated to the caller unchanged.
export async function createComplianceLifecycle(companyId: string, input: CreateComplianceLifecycleInput) {
  const [created] = await db
    .insert(zatcaComplianceLifecycles)
    .values({
      companyId,
      csrInstanceId: input.csrInstanceId,
      requestId: input.requestId,
      dispositionMessage: input.dispositionMessage,
      secretRef: input.secretRef,
    })
    .returning();
  return created;
}

// Same "undefined means not found OR not yours" contract as getCsrInstance.
export async function getComplianceLifecycle(companyId: string, complianceLifecycleId: string) {
  return db.query.zatcaComplianceLifecycles.findFirst({
    where: and(eq(zatcaComplianceLifecycles.id, complianceLifecycleId), eq(zatcaComplianceLifecycles.companyId, companyId)),
  });
}

// The CSR Instance's Compliance Lifecycle, if one has ever been created —
// at most one row can ever match, per the unique index. Used by
// domain/complianceCsid.ts both to enforce "one lifecycle per CSR
// Instance" before calling the provider (avoiding an unnecessary network
// round trip for a request that would fail anyway) and, more generally, as
// this table's tenant-scoped lookup by its actual foreign key.
export async function getComplianceLifecycleForCsrInstance(companyId: string, csrInstanceId: string) {
  return db.query.zatcaComplianceLifecycles.findFirst({
    where: and(eq(zatcaComplianceLifecycles.companyId, companyId), eq(zatcaComplianceLifecycles.csrInstanceId, csrInstanceId)),
  });
}
