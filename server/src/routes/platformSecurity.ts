import { Router } from "express";
import { z } from "zod";
import { inArray, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { companies, platformOperators, supportSessions, userSessions } from "../db/schema.js";
import { listPlatformAdminActivity, sanitizeAuditValue } from "../lib/audit.js";
import { requirePlatformCapability } from "../lib/platformPermissions.js";
import { deriveStatus } from "./platformSupportSessions.js";

// MIDAD Final Pre-Launch audit, Phase 7 — Security Center. Extends the
// existing read surfaces (support sessions, audit_events) with a global,
// cross-operator/cross-tenant view for security oversight — never a new
// store, never a new mutation route, never a secret/credential value (no
// route in this file selects secretRef, passwordHash, or any token/key
// column from anything).
//
// Deliberately does NOT claim to show failed login events, rate-limit-hit
// events, or automated suspicious-activity detection: none of that is
// currently persisted anywhere in this codebase (express-rate-limit's
// 429s are in-memory only, login failures are never written to a table).
// Fabricating that data here would violate the audit's own "never claim
// readiness/data that doesn't exist" rule — GET /overview's own
// `notAvailable` field says so explicitly instead of silently omitting it.
export const platformSecurityRouter = Router();

const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

platformSecurityRouter.get("/overview", requirePlatformCapability("security.read"), async (_req, res) => {
  const [supportSessionCounts] = await db
    .select({
      total: sql<number>`count(*)::int`,
      active: sql<number>`count(*) filter (where revoked_at is null and expires_at > now())::int`,
      expired: sql<number>`count(*) filter (where revoked_at is null and expires_at <= now())::int`,
      revoked: sql<number>`count(*) filter (where revoked_at is not null)::int`,
    })
    .from(supportSessions);

  const [tenantSessionCounts] = await db
    .select({
      activeCount: sql<number>`count(*) filter (where revoked_at is null)::int`,
      oldestActiveCreatedAt: sql<Date | null>`min(created_at) filter (where revoked_at is null)`,
    })
    .from(userSessions);

  const oldestActiveAgeSeconds = tenantSessionCounts.oldestActiveCreatedAt
    ? Math.floor((Date.now() - new Date(tenantSessionCounts.oldestActiveCreatedAt).getTime()) / 1000)
    : null;

  res.json({
    adminSessions: supportSessionCounts,
    tenantSessions: {
      activeCount: tenantSessionCounts.activeCount,
      oldestActiveSessionCreatedAt: tenantSessionCounts.oldestActiveCreatedAt,
      oldestActiveSessionAgeSeconds: oldestActiveAgeSeconds,
    },
    // Honest, not silent, about what this Center cannot show yet — see
    // this file's header comment.
    notAvailable: ["failedLoginEvents", "rateLimitHitEvents", "automatedSuspiciousActivityDetection"],
  });
});

// Global (cross-operator) admin-sessions list — deliberately different
// from GET /api/platform/support-sessions, which is self-scoped to the
// calling operator by design (see that route's own comment). Security
// oversight needs to see every operator's support-session grants, not
// just the viewer's own.
platformSecurityRouter.get("/admin-sessions", requirePlatformCapability("security.read"), async (req, res) => {
  const parsed = pageQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { limit, offset } = parsed.data;

  const rows = await db.query.supportSessions.findMany({
    orderBy: (s, { desc }) => [desc(s.createdAt), desc(s.id)],
    limit: limit + 1,
    offset,
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const companyIds = [...new Set(page.map((s) => s.targetCompanyId))];
  const companyRows = companyIds.length
    ? await db.query.companies.findMany({ where: inArray(companies.id, companyIds), columns: { id: true, name: true } })
    : [];
  const companyNameById = new Map(companyRows.map((c) => [c.id, c.name]));

  const operatorIds = [...new Set(page.map((s) => s.platformOperatorId))];
  const operatorRows = operatorIds.length
    ? await db.query.platformOperators.findMany({ where: inArray(platformOperators.id, operatorIds), columns: { id: true, name: true } })
    : [];
  const operatorNameById = new Map(operatorRows.map((o) => [o.id, o.name]));

  res.json({
    sessions: page.map((s) => ({
      id: s.id,
      platformOperatorId: s.platformOperatorId,
      platformOperatorName: operatorNameById.get(s.platformOperatorId) ?? null,
      targetCompanyId: s.targetCompanyId,
      targetCompanyName: companyNameById.get(s.targetCompanyId) ?? null,
      reason: s.reason,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      revokedAt: s.revokedAt,
      status: deriveStatus(s),
      ageSeconds: Math.floor((Date.now() - s.createdAt.getTime()) / 1000),
    })),
    limit,
    offset,
    hasMore,
  });
});

// Global (cross-operator, cross-company) feed of sensitive administrative
// actions — every source: "platform_admin" audit_events row, via lib/
// audit.ts's listPlatformAdminActivity (see that function's own comment
// for why this can never surface a tenant's own business activity).
platformSecurityRouter.get("/sensitive-actions", requirePlatformCapability("security.read"), async (req, res) => {
  const parsed = pageQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { limit, offset } = parsed.data;

  const rows = await listPlatformAdminActivity({ limit: limit + 1, offset });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const companyIds = [...new Set(page.map((e) => e.companyId))];
  const companyRows = companyIds.length
    ? await db.query.companies.findMany({ where: inArray(companies.id, companyIds), columns: { id: true, name: true } })
    : [];
  const companyNameById = new Map(companyRows.map((c) => [c.id, c.name]));

  const operatorIds = [
    ...new Set(
      page
        .map((e) => (e.metadata as { platformOperatorId?: string } | null)?.platformOperatorId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const operatorRows = operatorIds.length
    ? await db.query.platformOperators.findMany({ where: inArray(platformOperators.id, operatorIds), columns: { id: true, name: true } })
    : [];
  const operatorNameById = new Map(operatorRows.map((o) => [o.id, o.name]));

  res.json({
    events: page.map((e) => {
      const platformOperatorId = (e.metadata as { platformOperatorId?: string } | null)?.platformOperatorId ?? null;
      return {
        id: e.id,
        action: e.action,
        entityType: e.entityType,
        entityId: e.entityId,
        companyId: e.companyId,
        companyName: companyNameById.get(e.companyId) ?? null,
        platformOperatorId,
        platformOperatorName: platformOperatorId ? (operatorNameById.get(platformOperatorId) ?? null) : null,
        reason: e.reason,
        metadata: sanitizeAuditValue(e.metadata),
        createdAt: e.createdAt,
      };
    }),
    limit,
    offset,
    hasMore,
  });
});
