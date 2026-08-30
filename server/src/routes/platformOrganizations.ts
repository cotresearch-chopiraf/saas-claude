import { Router } from "express";
import { z } from "zod";
import { db } from "../db/client.js";
import { companies } from "../db/schema.js";

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
});

platformOrganizationsRouter.get("/", async (req, res) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { limit, offset } = parsed.data;

  // Same "fetch one extra row" bounded-pagination trick as Phase C's
  // audit-events route — no index exists on companies.createdAt today,
  // so a separate COUNT(*) would cost as much as the page query itself.
  const rows = await db.query.companies.findMany({
    orderBy: (c, { desc }) => [desc(c.createdAt), desc(c.id)],
    limit: limit + 1,
    offset,
    // Deliberately NOT columns:true / a bare findMany() — only the three
    // fields explicitly authorized for this view (Phase D report §8):
    // never taxId/address/phone/logoPath/featureFlags/numbering counters,
    // and never anything from a joined table (no financial data, no
    // tenant secrets).
    columns: { id: true, name: true, createdAt: true },
  });
  const hasMore = rows.length > limit;
  const organizations = hasMore ? rows.slice(0, limit) : rows;

  res.json({ organizations, limit, offset, hasMore });
});
