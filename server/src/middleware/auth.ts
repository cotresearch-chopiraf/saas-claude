import type { NextFunction, Request, Response } from "express";
import { verifyToken } from "../lib/jwt.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
      companyId?: string;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "مطلوب تسجيل الدخول" });
  }

  try {
    const payload = verifyToken(header.slice("Bearer ".length));
    req.userId = payload.userId;
    req.companyId = payload.companyId;
    next();
  } catch {
    return res.status(401).json({ error: "جلسة غير صالحة، الرجاء تسجيل الدخول مجدداً" });
  }
}
