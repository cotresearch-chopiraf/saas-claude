import type { NextFunction, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { verifyPlatformToken } from "../lib/platformJwt.js";
import { db } from "../db/client.js";
import { platformOperators } from "../db/schema.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      // PLATFORM_SCOPE identity — deliberately never set alongside
      // userId/companyId (middleware/auth.ts's requireAuth is the only
      // place those are ever set). A route reading this must never also
      // read req.userId/req.companyId, and vice versa — see the Phase D
      // report's core architectural rule.
      platformOperatorId?: string;
    }
  }
}

// MIDAD Phase D1 — the PLATFORM_SCOPE analogue of middleware/auth.ts's
// requireAuth, deliberately kept as a fully separate function rather than
// a shared "elevated requireAuth": mirrors the exact same DB-authoritative-
// every-request discipline (Phase A's precedent — a still-valid JWT must
// never alone grant standing access once status has changed), applied to
// platform_operators instead of users. Never reads or sets
// req.userId/req.companyId; never reads the "users" table.
export async function platformAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "مطلوب تسجيل الدخول" });
  }

  let payload;
  try {
    payload = verifyPlatformToken(header.slice("Bearer ".length));
  } catch {
    return res.status(401).json({ error: "جلسة غير صالحة، الرجاء تسجيل الدخول مجدداً" });
  }

  const operator = await db.query.platformOperators.findFirst({
    where: eq(platformOperators.id, payload.platformOperatorId),
    columns: { status: true },
  });
  if (!operator) {
    return res.status(401).json({ error: "جلسة غير صالحة، الرجاء تسجيل الدخول مجدداً" });
  }
  if (operator.status !== "active") {
    return res.status(401).json({ error: "تم إلغاء تفعيل هذا الحساب" });
  }

  req.platformOperatorId = payload.platformOperatorId;
  next();
}
