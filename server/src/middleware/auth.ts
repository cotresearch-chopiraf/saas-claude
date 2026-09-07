import type { NextFunction, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { verifyToken } from "../lib/jwt.js";
import { db } from "../db/client.js";
import { users, userSessions } from "../db/schema.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
      companyId?: string;
      // Set alongside userId/companyId — routes/auth.ts's own /logout
      // route is the only current reader (revokes this exact session).
      sessionId?: string;
    }
  }
}

// MIDAD Phase A — the JWT alone only proves who signed in, not whether that
// account is still allowed in right now. The JWT's own lifetime is 7 days
// (lib/jwt.ts), so without a live check here, a deactivated user's existing
// token would keep working on every route that doesn't separately call
// requirePermission (i.e. every member-open route — the majority of this
// app) for up to 7 more days. This is the exact same "re-read from the
// database on every call rather than trusted from the token" discipline
// lib/permissions.ts's getUserRole already established for role changes,
// applied to status — requireAuth is the one middleware every protected
// route passes through, so it is the correct, single enforcement point
// (requirePermission's own DB check still runs afterward, unchanged).
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "مطلوب تسجيل الدخول" });
  }

  let payload;
  try {
    payload = verifyToken(header.slice("Bearer ".length));
  } catch {
    return res.status(401).json({ error: "جلسة غير صالحة، الرجاء تسجيل الدخول مجدداً" });
  }

  const user = await db.query.users.findFirst({
    where: eq(users.id, payload.userId),
    columns: { status: true },
  });
  if (!user) {
    return res.status(401).json({ error: "جلسة غير صالحة، الرجاء تسجيل الدخول مجدداً" });
  }
  if (user.status !== "active") {
    return res.status(401).json({ error: "تم إلغاء تفعيل هذا الحساب، يرجى التواصل مع مالك الشركة" });
  }

  // Same re-read-on-every-request discipline as the status check above,
  // applied to this specific token rather than the account as a whole —
  // see userSessions' own schema comment for why this exists.
  const session = await db.query.userSessions.findFirst({
    where: eq(userSessions.id, payload.sessionId),
    columns: { revokedAt: true },
  });
  if (!session || session.revokedAt) {
    return res.status(401).json({ error: "جلسة غير صالحة، الرجاء تسجيل الدخول مجدداً" });
  }

  req.userId = payload.userId;
  req.companyId = payload.companyId;
  req.sessionId = payload.sessionId;
  next();
}
