import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { logger } from "../lib/logger.js";

export const healthRouter = Router();

// MIDAD Phase B — liveness: is the process itself alive and able to answer
// at all? Deliberately no database call and no auth — an orchestrator
// restarting a genuinely wedged process must never be blocked on a
// dependency this route doesn't need to check.
healthRouter.get("/live", (_req, res) => {
  res.json({ status: "ok" });
});

// Readiness: is the app actually able to serve real traffic right now? The
// one dependency every route needs is Postgres, so this is the one thing
// worth checking — deliberately nothing more (this is infrastructure, not
// an incident-management product). Never returns connection details or the
// driver's own error message to the client; that goes to the server log
// only.
healthRouter.get("/ready", async (req, res) => {
  try {
    await db.execute(sql`select 1`);
    res.json({ status: "ok" });
  } catch (err) {
    logger.error("readiness_check_failed", {
      requestId: req.requestId,
      message: err instanceof Error ? err.message : "unknown error",
    });
    res.status(503).json({ status: "error", error: "الخدمة غير جاهزة حالياً" });
  }
});
