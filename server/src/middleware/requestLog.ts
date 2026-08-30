import type { NextFunction, Request, Response } from "express";
import { logger } from "../lib/logger.js";

// MIDAD Phase B — one structured line per request, logged once the response
// has actually finished (so the real status/duration are known, and — if
// the route required auth — req.userId/companyId are already populated by
// requireAuth by the time this fires). This is the diagnostic trace Phase B
// exists to provide: every request is correlatable by requestId, and every
// authenticated request carries the same tenant identifiers already used
// for scoping elsewhere in this codebase. Deliberately logs only
// identifiers, never headers, bodies, or credentials.
export function requestLogMiddleware(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  // req.originalUrl, not req.path: a nested router rebases req.url (and
  // therefore req.path) as it dispatches, and never restores it for a
  // terminal handler that never calls next() — by the time this listener
  // fires, req.path for e.g. GET /api/customers would read back as just
  // "/". originalUrl is the one property Express guarantees is set once
  // and never mutated by routing, regardless of nesting depth. Its query
  // string is stripped before logging — no route in this codebase puts
  // anything sensitive in a query param today, but a request log is
  // exactly the kind of place that must stay safe by construction, not by
  // audit.
  const path = req.originalUrl.split("?")[0];
  res.on("finish", () => {
    logger.info("http_request", {
      requestId: req.requestId,
      method: req.method,
      path,
      status: res.statusCode,
      durationMs: Date.now() - start,
      userId: req.userId,
      companyId: req.companyId,
    });
  });
  next();
}
