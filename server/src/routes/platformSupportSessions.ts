import { Router } from "express";
import { z } from "zod";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { companies, supportSessions } from "../db/schema.js";
import { recordAuditEvent, listCompanyActivity } from "../lib/audit.js";
import { requireSupportSession } from "../middleware/requireSupportSession.js";

// MIDAD Phase D2 — Platform Admin / Support Access. Everything here is
// mounted behind middleware/platformAuth.ts's platformAuth (never
// requireAuth) in app.ts, so req.platformOperatorId is always set and
// req.userId/req.companyId are always undefined. A support session is a
// server-authoritative, time-limited, revocable grant to read exactly one
// tenant's data — see db/schema.ts's supportSessions table comment for the
// full reasoning. There is no mutation route on this resource, and none is
// planned: D2 is explicitly read-only support access.
export const platformSupportSessionsRouter = Router();

const SUPPORT_SESSION_DURATION_MS = 30 * 60 * 1000;

const createSchema = z.object({
  targetCompanyId: z.string().uuid("رقم الشركة غير صالح"),
  reason: z.string().trim().min(3, "يجب توضيح سبب طلب الوصول"),
});

platformSupportSessionsRouter.post("/", async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { targetCompanyId, reason } = parsed.data;

  const company = await db.query.companies.findFirst({ where: eq(companies.id, targetCompanyId) });
  if (!company) return res.status(404).json({ error: "الشركة غير موجودة" });

  const now = Date.now();
  const session = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(supportSessions)
      .values({
        platformOperatorId: req.platformOperatorId!,
        targetCompanyId,
        reason,
        expiresAt: new Date(now + SUPPORT_SESSION_DURATION_MS),
      })
      .returning();

    // companyId = the affected tenant, actorUserId = null (a platform
    // operator id is not a valid users.id and must never be forced into
    // that column — see db/schema.ts: actorUserId has a real FK to
    // users.id). The operator's identity lives in metadata instead, so
    // WHO remains fully recoverable.
    await recordAuditEvent(tx, {
      companyId: targetCompanyId,
      actorUserId: null,
      action: "supportSession.granted",
      entityType: "support_session",
      entityId: created.id,
      afterValue: { expiresAt: created.expiresAt },
      reason,
      source: "platform_admin",
      metadata: { platformOperatorId: req.platformOperatorId },
    });

    return created;
  });

  res.status(201).json({
    id: session.id,
    targetCompanyId: session.targetCompanyId,
    reason: session.reason,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
  });
});

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

function deriveStatus(session: { revokedAt: Date | null; expiresAt: Date }): "active" | "expired" | "revoked" {
  if (session.revokedAt) return "revoked";
  return session.expiresAt.getTime() > Date.now() ? "active" : "expired";
}

// "My active sessions" — self-scoped to the authenticated operator only.
// Deliberately: no platformOperatorId/operatorId/companyId accepted from
// the client at all (not even to ignore-then-fall-back-safely — the query
// below never references req.query for scoping, only req.platformOperatorId,
// so there is no parameter here that could widen or redirect the scope no
// matter what a client sends). Newest-first, matching the one ordering
// convention every other list route in this codebase already uses
// (routes/platformOrganizations.ts, lib/audit.ts's listCompanyActivity) —
// introducing a status-grouped ordering would be the first of its kind in
// the codebase, and isn't needed: sessions are short-lived (30 minutes), so
// newest-first already surfaces active ones at the top in practice.
platformSupportSessionsRouter.get("/", async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { limit, offset } = parsed.data;

  const rows = await db.query.supportSessions.findMany({
    where: eq(supportSessions.platformOperatorId, req.platformOperatorId!),
    orderBy: (s, { desc }) => [desc(s.createdAt), desc(s.id)],
    limit: limit + 1,
    offset,
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  // One batch lookup for company names, not N+1 — no relation is declared
  // between supportSessions and companies in db/schema.ts (adding one is
  // unnecessary here and was deliberately avoided rather than touching the
  // shared schema file for a plain read-only join).
  const companyIds = [...new Set(page.map((s) => s.targetCompanyId))];
  const companyRows = companyIds.length
    ? await db.query.companies.findMany({ where: inArray(companies.id, companyIds), columns: { id: true, name: true } })
    : [];
  const companyNameById = new Map(companyRows.map((c) => [c.id, c.name]));

  res.json({
    sessions: page.map((s) => ({
      id: s.id,
      targetCompanyId: s.targetCompanyId,
      targetCompanyName: companyNameById.get(s.targetCompanyId) ?? null,
      reason: s.reason,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      revokedAt: s.revokedAt,
      status: deriveStatus(s),
    })),
    limit,
    offset,
    hasMore,
  });
});

platformSupportSessionsRouter.post("/:supportSessionId/revoke", async (req, res) => {
  const existing = await db.query.supportSessions.findFirst({
    where: and(eq(supportSessions.id, req.params.supportSessionId), eq(supportSessions.platformOperatorId, req.platformOperatorId!)),
  });
  if (!existing) return res.status(404).json({ error: "جلسة الدعم غير موجودة" });

  // Atomic conditional UPDATE (WHERE revoked_at IS NULL), not a prior
  // SELECT followed by a separate UPDATE — the same race-safety pattern
  // routes/auth.ts's reset-password-token consumption already uses. Two
  // concurrent revoke calls on the same session can only ever result in
  // exactly one of them actually setting revoked_at.
  const [revoked] = await db
    .update(supportSessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(supportSessions.id, existing.id), isNull(supportSessions.revokedAt)))
    .returning();

  if (!revoked) return res.status(409).json({ error: "تم إلغاء جلسة الدعم هذه من قبل" });

  await recordAuditEvent(db, {
    companyId: existing.targetCompanyId,
    actorUserId: null,
    action: "supportSession.revoked",
    entityType: "support_session",
    entityId: existing.id,
    beforeValue: { revokedAt: null },
    afterValue: { revokedAt: revoked.revokedAt },
    source: "platform_admin",
    metadata: { platformOperatorId: req.platformOperatorId },
  });

  res.json({ id: revoked.id, revokedAt: revoked.revokedAt });
});

const activityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  entityType: z.string().min(1).optional(),
});

// The one read surface this slice grants: the target tenant's own Activity
// Timeline (Phase C), reused verbatim — never recalculated, never a
// separate "support view" of the same data. targetCompanyId comes only
// from req.supportTargetCompanyId (set by requireSupportSession from the
// session row); nothing in the request body/query can change which
// company this reads, including a client-supplied companyId, which this
// route never even looks at.
platformSupportSessionsRouter.get("/:supportSessionId/activity", requireSupportSession, async (req, res) => {
  const parsed = activityQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { limit, offset, entityType } = parsed.data;

  const rows = await listCompanyActivity(req.supportTargetCompanyId!, { entityType }, { limit: limit + 1, offset });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  res.json({
    events: page.map((e) => ({
      id: e.id,
      action: e.action,
      entityType: e.entityType,
      entityId: e.entityId,
      actorName: e.actor?.name ?? null,
      createdAt: e.createdAt,
    })),
    limit,
    offset,
    hasMore,
  });
});
