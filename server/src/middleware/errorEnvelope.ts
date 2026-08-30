import type { NextFunction, Request, Response } from "express";
import { codeForStatus } from "../lib/errorCodes.js";

interface ErrorBody {
  error: string;
  code?: string;
  requestId?: string;
  [key: string]: unknown;
}

function isErrorBody(body: unknown): body is ErrorBody {
  return typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string";
}

// MIDAD Phase B — every route in this codebase already answers every error
// case with res.status(x).json({error:"..."}); this augments that exact,
// existing contract in place for all of them at once: a machine-readable
// `code` (derived from the status the route already chose) and the
// request's correlation id. No route needs to change or even know this
// exists. Only a response whose status is >=400 AND whose body already has
// an `error` string gets touched — every success response, and any
// non-JSON response (uploads, health), passes through completely
// untouched.
export function errorEnvelopeMiddleware(req: Request, res: Response, next: NextFunction) {
  const originalJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    if (res.statusCode >= 400 && isErrorBody(body)) {
      return originalJson({
        ...body,
        code: body.code ?? codeForStatus(res.statusCode),
        requestId: req.requestId,
      });
    }
    return originalJson(body);
  }) as Response["json"];
  next();
}
