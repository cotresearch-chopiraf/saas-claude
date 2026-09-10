import type { NextFunction, Request, Response } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { clientProjectAccess } from "../db/schema.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      // The grant's own companyId — read from the DB row, never derived
      // from req.params/req.body/req.query. A route reading this proves
      // the current Client Portal User has an active, explicit grant for
      // req.params.projectId; it never means "this identity's company",
      // since a Client Portal User has no company of its own beyond the
      // one that created it (clientPortalUsers.companyId), which is not
      // what authorizes access here — the grant row is.
      clientPortalGrantCompanyId?: string;
    }
  }
}

// MIDAD Phase B1 — must run AFTER middleware/clientPortalAuth.ts's
// clientPortalAuth (needs req.clientPortalUserId already set). Reads
// projectId from the route param and re-checks the grant row from the
// database on every request — a grant's revokedAt is exactly as
// authoritative-per-request as a session's revokedAt or an account's
// status already are elsewhere in this codebase (see
// clientPortalAuth.ts/requireAuth.ts/requireSupportSession.ts); nothing
// about "this grant used to be active" is ever trusted.
//
// 404 (not 403) whether the project doesn't exist, belongs to a different
// company, or simply was never granted to this identity — the same
// "don't confirm existence to someone not entitled to it" posture every
// tenant-scoped 404 in this codebase already uses (see e.g.
// routes/customers.ts, middleware/requireSupportSession.ts). There is no
// "yours but revoked" 403 case here, unlike a support session's own
// expiresAt/revokedAt split, because a revoked grant and a never-granted
// project are indistinguishable from the client's side by design — a
// former grant must not even confirm "you used to have access to this."
export async function requireClientProjectAccess(req: Request<{ projectId: string }>, res: Response, next: NextFunction) {
  const grant = await db.query.clientProjectAccess.findFirst({
    where: and(
      eq(clientProjectAccess.clientPortalUserId, req.clientPortalUserId!),
      eq(clientProjectAccess.projectId, req.params.projectId),
      isNull(clientProjectAccess.revokedAt),
    ),
  });
  if (!grant) {
    return res.status(404).json({ error: "المشروع غير موجود" });
  }

  req.clientPortalGrantCompanyId = grant.companyId;
  next();
}
