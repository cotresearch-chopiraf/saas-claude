import { eq, and, gte, lte } from "drizzle-orm";
import { auditEvents } from "../db/schema.js";
import { db } from "../db/client.js";

// The one canonical audit-event model for the whole product (approved
// Phase 1 decision: generalize now, without event-sourcing — this is a
// trail of who-changed-what-when, not a replay log; current state always
// lives in each domain's own table). Every domain going forward — Contract,
// BOQ, Cost Code, Budget Revision, and anything later (Procurement, IPC,
// Change Orders, financial corrections, permission-sensitive actions) —
// writes here via this one function, keyed by entityType/entityId rather
// than growing its own audit table.
//
// compliance_audit_events (the schema's older, compliance-specific audit
// table) is NOT dropped and NOT migrated — every row it already has stays
// exactly as it is, untouched. It is deprecated going forward: see
// lib/compliance/audit.ts, which now writes here instead.

export interface DbLike {
  insert: typeof db.insert;
}

export interface AuditEventInput {
  companyId: string;
  // Nullable: a future system/AI-originated event may have no human actor
  // — never fabricate one to satisfy a constraint that doesn't exist here
  // (actorUserId is nullable in the schema for exactly this reason).
  actorUserId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  beforeValue?: unknown;
  afterValue?: unknown;
  reason?: string | null;
  source?: string;
  metadata?: unknown;
}

// Call this INSIDE the same db.transaction() as the mutation it records —
// every call site in this codebase that does so gets atomicity between the
// mutation and its audit row for free from Postgres; this function does not
// enforce that itself (it just takes whatever `db` or `tx` you pass it).
export async function recordAuditEvent(dbOrTx: DbLike, input: AuditEventInput) {
  await dbOrTx.insert(auditEvents).values({
    companyId: input.companyId,
    actorUserId: input.actorUserId ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    beforeValue: input.beforeValue ?? null,
    afterValue: input.afterValue ?? null,
    reason: input.reason ?? null,
    source: input.source ?? "api",
    metadata: input.metadata ?? null,
  });
}

export interface ListAuditEventsFilter {
  entityType?: string;
  entityId?: string;
}

export async function listAuditEvents(companyId: string, filter: ListAuditEventsFilter = {}) {
  const conditions = [eq(auditEvents.companyId, companyId)];
  if (filter.entityType) conditions.push(eq(auditEvents.entityType, filter.entityType));
  if (filter.entityId) conditions.push(eq(auditEvents.entityId, filter.entityId));

  return db.query.auditEvents.findMany({
    where: and(...conditions),
    orderBy: (e, { desc }) => [desc(e.createdAt)],
  });
}

// MIDAD Phase C — Activity Timeline. A second, deliberately separate read
// path from listAuditEvents above (not a second audit STORE — same
// audit_events table, same companyId tenant scope, same insert path via
// recordAuditEvent): this one is always bounded (limit/offset are
// required, never optional, so a caller cannot accidentally load an
// unbounded history the way compliance.ts's /history route already does)
// and always joins the actor, which listAuditEvents' existing callers
// (compliance.ts) never asked for and shouldn't have their response shape
// silently changed by adding here.
export interface ListCompanyActivityFilter {
  entityType?: string;
  from?: Date;
  to?: Date;
}

export interface ListCompanyActivityPage {
  limit: number;
  offset: number;
}

export async function listCompanyActivity(
  companyId: string,
  filter: ListCompanyActivityFilter,
  { limit, offset }: ListCompanyActivityPage,
) {
  const conditions = [eq(auditEvents.companyId, companyId)];
  if (filter.entityType) conditions.push(eq(auditEvents.entityType, filter.entityType));
  if (filter.from) conditions.push(gte(auditEvents.createdAt, filter.from));
  if (filter.to) conditions.push(lte(auditEvents.createdAt, filter.to));

  return db.query.auditEvents.findMany({
    where: and(...conditions),
    // Newest first; id is a pure tiebreaker for events sharing the same
    // createdAt millisecond, so pagination stays deterministic across pages.
    orderBy: (e, { desc }) => [desc(e.createdAt), desc(e.id)],
    limit,
    offset,
    with: { actor: { columns: { id: true, name: true, email: true } } },
  });
}
