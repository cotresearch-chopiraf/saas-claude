import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { listCompanyActivity, sanitizeAuditValue } from "../lib/audit.js";

// MIDAD Phase C — Activity Timeline read API. audit_events is the one and
// only audit store (see lib/audit.ts) — this route only reads it, scoped
// to the authenticated caller's own company (req.companyId!, set by
// requireAuth from the verified JWT/DB lookup — never from a query param,
// so there is nothing here for a client to spoof its way around). No
// mutation route exists on this resource, and none is planned: an audit
// trail that could be edited or deleted through its own viewer would not
// be an audit trail.
//
// Member-open read, no requirePermission gate — same posture as
// Forecast's GET routes (routes/forecast.ts): every company member is
// already trusted to see everything that happened in their own company,
// just not to mutate it.
export const auditEventsRouter = Router();

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
  entityType: z.string().min(1).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

auditEventsRouter.get("/", async (req: Request, res: Response) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { limit, offset, entityType, from, to } = parsed.data;

  // Fetch one extra row to know whether another page exists without a
  // separate COUNT query (audit_events has no index yet — see lib/audit.ts
  // — so a COUNT(*) here would cost as much as the page query itself).
  const rows = await listCompanyActivity(req.companyId!, { entityType, from, to }, { limit: limit + 1, offset });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  res.json({
    events: page.map((e) => ({
      id: e.id,
      action: e.action,
      entityType: e.entityType,
      entityId: e.entityId,
      actorUserId: e.actorUserId,
      actorName: e.actor?.name ?? null,
      actorEmail: e.actor?.email ?? null,
      reason: e.reason,
      source: e.source,
      beforeValue: sanitizeAuditValue(e.beforeValue),
      afterValue: sanitizeAuditValue(e.afterValue),
      metadata: sanitizeAuditValue(e.metadata),
      createdAt: e.createdAt,
    })),
    limit,
    offset,
    hasMore,
  });
});
