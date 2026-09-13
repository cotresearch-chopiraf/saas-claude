import { Router } from "express";
import { z } from "zod";
import { and, eq, ilike, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { companies, plans, projects, userSessions, users, zatcaEgsUnits } from "../db/schema.js";
import { recordAuditEvent } from "../lib/audit.js";

// MIDAD Phase D1 — the first PLATFORM_SCOPE route. Mounted behind
// middleware/platformAuth.ts's platformAuth (never requireAuth), so it
// runs with req.platformOperatorId set and req.userId/req.companyId
// always undefined — there is no tenant company context to accidentally
// use here, structurally, not just by convention. Read-only: no mutation
// route exists on this resource in D1 (D3/D4 in the Phase D report are
// explicitly not authorized yet).
export const platformOrganizationsRouter = Router();

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
  // Whitespace-only/empty is treated as "no search" rather than a
  // meaningless filter — transformed to undefined here so the query below
  // has one single "is a search active" branch to worry about.
  search: z
    .string()
    .optional()
    .transform((value) => {
      const trimmed = value?.trim();
      return trimmed ? trimmed : undefined;
    }),
});

platformOrganizationsRouter.get("/", async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { limit, offset, search } = parsed.data;

  // Same "fetch one extra row" bounded-pagination trick as Phase C's
  // audit-events route — no index exists on companies.createdAt (or, now,
  // companies.name) today, so a separate COUNT(*) would cost as much as
  // the page query itself.
  const rows = await db.query.companies.findMany({
    where: search ? ilike(companies.name, `%${search}%`) : undefined,
    orderBy: (c, { desc }) => [desc(c.createdAt), desc(c.id)],
    limit: limit + 1,
    offset,
    // Deliberately NOT columns:true / a bare findMany() — only the three
    // fields explicitly authorized for this view (Phase D report §8):
    // never taxId/address/phone/logoPath/featureFlags/numbering counters,
    // and never anything from a joined table (no financial data, no
    // tenant secrets). Search never widens this allowlist.
    columns: { id: true, name: true, createdAt: true },
  });
  const hasMore = rows.length > limit;
  const organizations = hasMore ? rows.slice(0, limit) : rows;

  res.json({ organizations, limit, offset, hasMore });
});

// P0 hardening (MIDAD Final Pre-Launch audit, Phase 4) — detail view.
// Same allowlist discipline as the list route above: aggregate counts and
// plan/status/ZATCA summary only — never owner name/email, never a user
// list, never taxId/address/phone/logoPath/featureFlags, and never
// anything from a joined table beyond the two explicit counts and the
// plan's own key/name. A platform operator who needs to inspect a specific
// user or a company's actual audit trail goes through the dedicated
// (not-yet-built) Phase 5 user-management surface or the existing
// requireSupportSession-gated support-session flow (routes/
// platformSupportSessions.ts) — never through this route.
platformOrganizationsRouter.get("/:id", async (req, res) => {
  const company = await db.query.companies.findFirst({
    where: eq(companies.id, req.params.id),
    columns: { id: true, name: true, createdAt: true, status: true, planId: true },
  });
  if (!company) return res.status(404).json({ error: "الشركة غير موجودة" });

  const [plan, [userRow], [projectRow], zatcaRows] = await Promise.all([
    company.planId
      ? db.query.plans.findFirst({ where: eq(plans.id, company.planId), columns: { key: true, name: true } })
      : Promise.resolve(null),
    db.select({ count: sql<number>`count(*)::int` }).from(users).where(eq(users.companyId, company.id)),
    db.select({ count: sql<number>`count(*)::int` }).from(projects).where(eq(projects.companyId, company.id)),
    db
      .select({ status: zatcaEgsUnits.status, count: sql<number>`count(*)::int` })
      .from(zatcaEgsUnits)
      .where(eq(zatcaEgsUnits.companyId, company.id))
      .groupBy(zatcaEgsUnits.status),
  ]);

  const zatcaByStatus: Record<string, number> = {};
  let zatcaTotal = 0;
  for (const row of zatcaRows) {
    zatcaByStatus[row.status] = row.count;
    zatcaTotal += row.count;
  }

  res.json({
    id: company.id,
    name: company.name,
    createdAt: company.createdAt,
    status: company.status,
    plan: plan ? { key: plan.key, name: plan.name } : null,
    usage: { userCount: userRow?.count ?? 0, projectCount: projectRow?.count ?? 0 },
    zatca: { egsUnitCount: zatcaTotal, byStatus: zatcaByStatus },
  });
});

// Shared by /suspend and /revoke-sessions below — same bulk-revocation
// semantics as a user removing themselves everywhere, just scoped to every
// user in the company rather than one user (see userSessions' own schema
// comment for why this table/pattern exists). Deliberately inlined as a
// closure over tx rather than a standalone typed helper: this file has no
// existing precedent for a shared cross-route transaction-typed function,
// and inventing one for two call sites is not worth the type-signature
// complexity it would add.
async function revokeAllCompanySessions(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  companyId: string,
): Promise<number> {
  const companyUsers = await tx.select({ id: users.id }).from(users).where(eq(users.companyId, companyId));
  const userIds = companyUsers.map((u) => u.id);
  if (userIds.length === 0) return 0;
  const revoked = await tx
    .update(userSessions)
    .set({ revokedAt: new Date() })
    .where(and(inArray(userSessions.userId, userIds), isNull(userSessions.revokedAt)))
    .returning({ id: userSessions.id });
  return revoked.length;
}

const suspendSchema = z.object({ reason: z.string().trim().min(3, "سبب التعليق مطلوب") });

// Suspend blocks every user in the company on their very next request (see
// middleware/auth.ts's requireAuth — it re-reads companies.status on every
// call) and forces immediate re-authentication everywhere by revoking all
// currently-active sessions in the same transaction, rather than leaving
// already-issued tokens to work until they separately hit the status check.
platformOrganizationsRouter.post("/:id/suspend", async (req, res) => {
  const parsed = suspendSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const company = await db.query.companies.findFirst({
    where: eq(companies.id, req.params.id),
    columns: { id: true, status: true },
  });
  if (!company) return res.status(404).json({ error: "الشركة غير موجودة" });
  if (company.status === "suspended") return res.status(409).json({ error: "الشركة معلّقة بالفعل" });

  const revokedSessionCount = await db.transaction(async (tx) => {
    await tx.update(companies).set({ status: "suspended" }).where(eq(companies.id, req.params.id));
    const revoked = await revokeAllCompanySessions(tx, req.params.id);

    await recordAuditEvent(tx, {
      companyId: req.params.id,
      actorUserId: null,
      action: "organization.suspended",
      entityType: "company",
      entityId: req.params.id,
      beforeValue: { status: "active" },
      afterValue: { status: "suspended" },
      reason: parsed.data.reason,
      source: "platform_admin",
      metadata: { platformOperatorId: req.platformOperatorId, revokedSessionCount: revoked },
    });

    return revoked;
  });

  res.json({ id: req.params.id, status: "suspended", revokedSessionCount });
});

const reactivateSchema = z.object({ reason: z.string().trim().min(3).optional() });

platformOrganizationsRouter.post("/:id/reactivate", async (req, res) => {
  const parsed = reactivateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const company = await db.query.companies.findFirst({
    where: eq(companies.id, req.params.id),
    columns: { id: true, status: true },
  });
  if (!company) return res.status(404).json({ error: "الشركة غير موجودة" });
  if (company.status === "active") return res.status(409).json({ error: "الشركة مفعّلة بالفعل" });

  await db.transaction(async (tx) => {
    await tx.update(companies).set({ status: "active" }).where(eq(companies.id, req.params.id));

    await recordAuditEvent(tx, {
      companyId: req.params.id,
      actorUserId: null,
      action: "organization.reactivated",
      entityType: "company",
      entityId: req.params.id,
      beforeValue: { status: "suspended" },
      afterValue: { status: "active" },
      reason: parsed.data.reason ?? null,
      source: "platform_admin",
      metadata: { platformOperatorId: req.platformOperatorId },
    });
  });

  res.json({ id: req.params.id, status: "active" });
});

const revokeSessionsSchema = z.object({ reason: z.string().trim().min(3, "السبب مطلوب") });

// Forces re-login for every current user in the company WITHOUT suspending
// it — for a security incident (e.g. a suspected compromised account)
// where access itself should keep working but every existing session must
// not be trusted anymore. Deliberately a separate route from /suspend
// rather than a side effect only suspend has, since this is a legitimate
// standalone action.
platformOrganizationsRouter.post("/:id/revoke-sessions", async (req, res) => {
  const parsed = revokeSessionsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const company = await db.query.companies.findFirst({ where: eq(companies.id, req.params.id), columns: { id: true } });
  if (!company) return res.status(404).json({ error: "الشركة غير موجودة" });

  const revokedSessionCount = await db.transaction(async (tx) => {
    const revoked = await revokeAllCompanySessions(tx, req.params.id);

    await recordAuditEvent(tx, {
      companyId: req.params.id,
      actorUserId: null,
      action: "organization.sessions_revoked",
      entityType: "company",
      entityId: req.params.id,
      reason: parsed.data.reason,
      source: "platform_admin",
      metadata: { platformOperatorId: req.platformOperatorId, revokedSessionCount: revoked },
    });

    return revoked;
  });

  res.json({ id: req.params.id, revokedSessionCount });
});
