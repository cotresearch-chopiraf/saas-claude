import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { countUnread, listNotifications, markAllRead, markRead } from "../lib/notifications.js";

// Slice AA Scope F — minimal notification API. Every route below is scoped
// to (req.companyId!, req.userId!) — both taken from the verified JWT via
// requireAuth, never from a param or query string a client could spoof —
// so a user only ever sees or mutates their own notifications, matching
// the ownership contract documented in lib/notifications.ts.
export const notificationsRouter = Router();

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});

// Slice AA Scope G — paginated from the start (notifications is one of
// this slice's own priority endpoints), same limit/offset/hasMore
// convention as routes/auditEvents.ts: fetch limit+1 rows to detect
// hasMore without a separate COUNT query.
notificationsRouter.get("/", async (req: Request, res: Response) => {
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { limit, offset } = parsed.data;

  const rows = await listNotifications(req.companyId!, req.userId!, { limit: limit + 1, offset });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  res.json({ notifications: page, limit, offset, hasMore });
});

notificationsRouter.get("/unread-count", async (req: Request, res: Response) => {
  const count = await countUnread(req.companyId!, req.userId!);
  res.json({ count });
});

notificationsRouter.patch("/:id/read", async (req: Request<{ id: string }>, res: Response) => {
  const updated = await markRead(req.companyId!, req.userId!, req.params.id);
  if (!updated) return res.status(404).json({ error: "الإشعار غير موجود" });
  res.json(updated);
});

notificationsRouter.post("/mark-all-read", async (req: Request, res: Response) => {
  await markAllRead(req.companyId!, req.userId!);
  res.status(204).end();
});
