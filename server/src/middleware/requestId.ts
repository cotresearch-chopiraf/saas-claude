import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

const REQUEST_ID_HEADER = "x-request-id";
const VALID_REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;

// MIDAD Phase B — every request gets a correlation id, available to every
// downstream middleware/route via req.requestId and echoed back so a caller
// (or an upstream proxy chaining requests) can tie its own logs to ours. An
// incoming id is only trusted if it looks like a safe token; anything else
// (missing, empty, oversized, or containing characters that have no reason
// to be in an id) gets a freshly generated one instead of being reflected
// back verbatim.
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const incoming = req.headers[REQUEST_ID_HEADER];
  const candidate = Array.isArray(incoming) ? incoming[0] : incoming;
  const requestId = candidate && VALID_REQUEST_ID.test(candidate) ? candidate : randomUUID();
  req.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);
  next();
}
