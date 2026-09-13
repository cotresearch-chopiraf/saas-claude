import { Router } from "express";
import { z } from "zod";
import { and, eq, ilike, inArray, isNull, ne, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { companies, plans, projects, userSessions, users, zatcaEgsUnits } from "../db/schema.js";
import { recordAuditEvent } from "../lib/audit.js";
import { getCompanyLimits } from "../lib/entitlements.js";
import { requirePlatformCapability } from "../lib/platformPermissions.js";

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

platformOrganizationsRouter.get("/", requirePlatformCapability("organizations.read"), async (req, res) => {
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
platformOrganizationsRouter.get("/:id", requirePlatformCapability("organizations.read"), async (req, res) => {
  const company = await db.query.companies.findFirst({
    where: eq(companies.id, req.params.id),
    columns: { id: true, name: true, createdAt: true, status: true, planId: true },
  });
  if (!company) return res.status(404).json({ error: "الشركة غير موجودة" });

  const [plan, [userRow], [projectRow], zatcaRows, entitlements] = await Promise.all([
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
    // Same centralized evaluation every enforcement point uses (lib/
    // entitlements.ts) — this view never recomputes limits itself, so it
    // can never drift from what's actually enforced.
    getCompanyLimits(company.id),
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
    entitlements,
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
platformOrganizationsRouter.post("/:id/suspend", requirePlatformCapability("organizations.manage"), async (req, res) => {
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

platformOrganizationsRouter.post("/:id/reactivate", requirePlatformCapability("organizations.manage"), async (req, res) => {
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
platformOrganizationsRouter.post("/:id/revoke-sessions", requirePlatformCapability("organizations.manage"), async (req, res) => {
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

// ---------------------------------------------------------------------
// Phase 5 — Platform User Management. Visibility and support-driven
// control over the users *within* one organization — a deliberately
// different surface from the org-detail view above: that view is a
// PII-free aggregate (Phase 4's own allowlist discipline); this one is
// the explicit, per-user, per-organization surface that view's own
// comment named as where a specific user should be inspected instead.
// Never touches platform_operators — this router only ever reads/writes
// users and userSessions for a named target organization + named target
// user, structurally distinct from platformAuth's own operator identity.
// ---------------------------------------------------------------------

platformOrganizationsRouter.get("/:id/users", requirePlatformCapability("users.read"), async (req, res) => {
  const company = await db.query.companies.findFirst({ where: eq(companies.id, req.params.id), columns: { id: true } });
  if (!company) return res.status(404).json({ error: "الشركة غير موجودة" });

  const rows = await db.query.users.findMany({
    where: eq(users.companyId, req.params.id),
    columns: { id: true, name: true, email: true, role: true, status: true, createdAt: true },
    orderBy: (u, { asc }) => [asc(u.createdAt)],
  });

  res.json({ users: rows });
});

platformOrganizationsRouter.get("/:id/users/:userId", requirePlatformCapability("users.read"), async (req, res) => {
  const user = await db.query.users.findFirst({
    where: and(eq(users.id, req.params.userId), eq(users.companyId, req.params.id)),
    columns: { id: true, name: true, email: true, role: true, status: true, createdAt: true },
  });
  if (!user) return res.status(404).json({ error: "المستخدم غير موجود" });

  const [activeRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(userSessions)
    .where(and(eq(userSessions.userId, user.id), isNull(userSessions.revokedAt)));

  res.json({ ...user, activeSessionCount: activeRow?.count ?? 0 });
});

// "active"/"deactivated" — the exact same userStatusEnum values and
// semantics routes/company.ts's tenant-owner-driven PATCH /members/:id
// already uses (not a new "suspended" concept for users; only companies
// got that in Phase 4). Reusing the existing enum rather than inventing
// platform-specific status values is what keeps middleware/auth.ts's
// existing per-request requireAuth check the single enforcement point —
// no new status value for it to learn about.
const userStatusSchema = z
  .object({
    status: z.enum(["active", "deactivated"]),
    reason: z.string().trim().min(3, "السبب مطلوب").optional(),
  })
  .refine((data) => data.status === "active" || !!data.reason, {
    message: "سبب التعطيل مطلوب",
    path: ["reason"],
  });

platformOrganizationsRouter.patch("/:id/users/:userId/status", requirePlatformCapability("users.manage"), async (req, res) => {
  const parsed = userStatusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const existing = await db.query.users.findFirst({
    where: and(eq(users.id, req.params.userId), eq(users.companyId, req.params.id)),
  });
  if (!existing) return res.status(404).json({ error: "المستخدم غير موجود" });
  if (existing.status === parsed.data.status) return res.status(409).json({ error: "لا تغيير — الحالة كما هي بالفعل" });

  // Same invariant routes/company.ts's PATCH /members/:id already enforces
  // for the tenant-owner path: a company can never be left with zero
  // active owners through ANY administrative surface, platform-admin
  // included ("Platform Admin must never bypass business/security rules
  // merely because the endpoint is administrative"). Deliberately
  // duplicated here rather than extracted into a shared helper — this
  // route and the tenant route are independently tested, independently
  // authorized call sites, and refactoring an already-shipped, tested
  // tenant route carries more regression risk than a ~10-line duplicate
  // check does.
  if (existing.role === "owner" && existing.status === "active") {
    const otherActiveOwners = await db.query.users.findMany({
      where: and(
        eq(users.companyId, req.params.id),
        eq(users.role, "owner"),
        eq(users.status, "active"),
        ne(users.id, existing.id),
      ),
      columns: { id: true },
    });
    if (otherActiveOwners.length === 0) {
      return res.status(409).json({ error: "لا يمكن أن تبقى الشركة بدون مالك واحد نشط على الأقل" });
    }
  }

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx.update(users).set({ status: parsed.data.status }).where(eq(users.id, existing.id)).returning();

    await recordAuditEvent(tx, {
      companyId: req.params.id,
      actorUserId: null,
      action: "user.statusChanged",
      entityType: "user",
      entityId: existing.id,
      beforeValue: { status: existing.status },
      afterValue: { status: row.status },
      reason: parsed.data.reason ?? null,
      source: "platform_admin",
      metadata: { platformOperatorId: req.platformOperatorId },
    });

    return row;
  });

  res.json({ id: updated.id, status: updated.status });
});

// Deliberately a separate action from the status change above (same
// split as /organizations/:id/revoke-sessions vs /suspend) — forces
// re-login for one specific user without touching their active/
// deactivated status, for a suspected-compromised-account case where the
// account itself should keep working.
platformOrganizationsRouter.post("/:id/users/:userId/revoke-sessions", requirePlatformCapability("users.manage"), async (req, res) => {
  const parsed = revokeSessionsSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const existing = await db.query.users.findFirst({
    where: and(eq(users.id, req.params.userId), eq(users.companyId, req.params.id)),
    columns: { id: true },
  });
  if (!existing) return res.status(404).json({ error: "المستخدم غير موجود" });

  const revokedSessionCount = await db.transaction(async (tx) => {
    const revoked = await tx
      .update(userSessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(userSessions.userId, existing.id), isNull(userSessions.revokedAt)))
      .returning({ id: userSessions.id });

    await recordAuditEvent(tx, {
      companyId: req.params.id,
      actorUserId: null,
      action: "user.sessionsRevoked",
      entityType: "user",
      entityId: existing.id,
      reason: parsed.data.reason,
      source: "platform_admin",
      metadata: { platformOperatorId: req.platformOperatorId },
    });

    return revoked.length;
  });

  res.json({ id: existing.id, revokedSessionCount });
});
