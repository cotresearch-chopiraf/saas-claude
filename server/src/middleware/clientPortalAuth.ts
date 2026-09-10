import type { NextFunction, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { verifyClientPortalToken } from "../lib/clientPortalJwt.js";
import { db } from "../db/client.js";
import { clientPortalSessions, clientPortalUsers } from "../db/schema.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      // CLIENT_PORTAL_SCOPE identity — deliberately never set alongside
      // userId/companyId (middleware/auth.ts's requireAuth) or
      // platformOperatorId (middleware/platformAuth.ts's platformAuth). A
      // route reading this must never also read those, and vice versa —
      // same rule those two middlewares already state for each other,
      // extended to this third identity class.
      clientPortalUserId?: string;
      // Set alongside clientPortalUserId — routes/clientPortalAuth.ts's own
      // /logout route is the only current reader (revokes this exact
      // session), same precedent as middleware/auth.ts's own req.sessionId.
      clientPortalSessionId?: string;
    }
  }
}

// MIDAD Phase B1 — the CLIENT_PORTAL_SCOPE analogue of middleware/auth.ts's
// requireAuth and middleware/platformAuth.ts's platformAuth: same
// DB-authoritative-every-request discipline (a still-valid JWT must never
// alone grant standing access once session/account status has changed),
// applied to clientPortalUsers/clientPortalSessions instead. Never reads
// or sets req.userId/req.companyId/req.platformOperatorId; never reads
// "users" or "platform_operators".
export async function clientPortalAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "مطلوب تسجيل الدخول" });
  }

  let payload;
  try {
    payload = verifyClientPortalToken(header.slice("Bearer ".length));
  } catch {
    return res.status(401).json({ error: "جلسة غير صالحة، الرجاء تسجيل الدخول مجدداً" });
  }

  // Session re-checked first (revocation, e.g. logout, must take effect
  // immediately regardless of the account's own status).
  const session = await db.query.clientPortalSessions.findFirst({
    where: eq(clientPortalSessions.id, payload.sessionId),
    columns: { revokedAt: true },
  });
  if (!session || session.revokedAt) {
    return res.status(401).json({ error: "جلسة غير صالحة، الرجاء تسجيل الدخول مجدداً" });
  }

  const portalUser = await db.query.clientPortalUsers.findFirst({
    where: eq(clientPortalUsers.id, payload.clientPortalUserId),
    columns: { status: true },
  });
  if (!portalUser) {
    return res.status(401).json({ error: "جلسة غير صالحة، الرجاء تسجيل الدخول مجدداً" });
  }
  if (portalUser.status !== "active") {
    return res.status(401).json({ error: "تم إلغاء تفعيل هذا الحساب" });
  }

  req.clientPortalUserId = payload.clientPortalUserId;
  req.clientPortalSessionId = payload.sessionId;
  next();
}
