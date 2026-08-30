import type { NextFunction, Request, Response } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { supportSessions } from "../db/schema.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      // MIDAD Phase D2 — deliberately NOT req.companyId: a support session
      // is a temporary, explicit grant, not tenant identity. Any route
      // reading this must never also read req.userId/req.companyId (those
      // stay exclusively middleware/auth.ts's requireAuth), and any route
      // reading req.companyId must never read these — see requireAuth's
      // and platformAuth's own comments for the same rule stated the
      // other two ways.
      supportSessionId?: string;
      supportTargetCompanyId?: string;
    }
  }
}

// MIDAD Phase D2 — must run AFTER middleware/platformAuth.ts's platformAuth
// (needs req.platformOperatorId already set). Re-checks the session row
// from the database on every request — a support session's expiresAt/
// revokedAt are exactly as authoritative-per-request as a user's status or
// an operator's status already are elsewhere in this codebase; nothing
// about "this session used to be valid" is ever trusted.
//
// 404 (not 403) when the session doesn't exist OR belongs to a different
// operator — the same "don't confirm existence to someone not entitled to
// it" posture every tenant-scoped 404 in this codebase already uses (see
// e.g. routes/customers.ts). 403 is reserved for "this is genuinely your
// session, but it's no longer usable" (expired/revoked), where being
// specific helps the legitimate owner and reveals nothing to anyone else.
export async function requireSupportSession(req: Request, res: Response, next: NextFunction) {
  const sessionId = req.params.supportSessionId;

  const session = await db.query.supportSessions.findFirst({
    where: and(eq(supportSessions.id, sessionId), eq(supportSessions.platformOperatorId, req.platformOperatorId!)),
  });
  if (!session) {
    return res.status(404).json({ error: "جلسة الدعم غير موجودة" });
  }
  if (session.revokedAt) {
    return res.status(403).json({ error: "تم إلغاء جلسة الدعم هذه" });
  }
  if (session.expiresAt.getTime() <= Date.now()) {
    return res.status(403).json({ error: "انتهت صلاحية جلسة الدعم هذه" });
  }

  req.supportSessionId = session.id;
  req.supportTargetCompanyId = session.targetCompanyId;
  next();
}
