import { Router } from "express";
import { z } from "zod";
import { inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { companies } from "../db/schema.js";
import { listPlatformOperatorActivity, sanitizeAuditValue } from "../lib/audit.js";

// MIDAD Admin Dashboard — "my platform activity". Mounted behind
// platformAuth (never requireAuth), so req.platformOperatorId is always
// set and req.userId/req.companyId are always undefined. Read-only: no
// mutation route exists here or is planned — an audit trail viewer that
// could itself be mutated would not be an audit trail.
//
// Self-scoped exactly like platformSupportSessions.ts's GET "/": no
// platformOperatorId/operatorId/companyId is ever read from the client —
// the query in lib/audit.ts's listPlatformOperatorActivity only ever
// references req.platformOperatorId from the verified JWT.
export const platformAuditEventsRouter = Router();

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

platformAuditEventsRouter.get("/", async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { limit, offset } = parsed.data;

  const rows = await listPlatformOperatorActivity(req.platformOperatorId!, { limit: limit + 1, offset });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  // Same batch company-name lookup as platformSupportSessions.ts's list
  // route — one query, not N+1, and no relation is declared between
  // auditEvents and companies in db/schema.ts (adding one is unnecessary
  // for this plain read-only join).
  const companyIds = [...new Set(page.map((e) => e.companyId))];
  const companyRows = companyIds.length
    ? await db.query.companies.findMany({ where: inArray(companies.id, companyIds), columns: { id: true, name: true } })
    : [];
  const companyNameById = new Map(companyRows.map((c) => [c.id, c.name]));

  res.json({
    events: page.map((e) => ({
      id: e.id,
      action: e.action,
      entityType: e.entityType,
      entityId: e.entityId,
      companyId: e.companyId,
      companyName: companyNameById.get(e.companyId) ?? null,
      reason: e.reason,
      metadata: sanitizeAuditValue(e.metadata),
      createdAt: e.createdAt,
    })),
    limit,
    offset,
    hasMore,
  });
});
