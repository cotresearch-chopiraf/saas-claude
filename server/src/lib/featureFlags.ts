import { eq, and } from "drizzle-orm";
import type { Request, Response, NextFunction } from "express";
import { db } from "../db/client.js";
import { featureFlags, companyFeatureFlagOverrides } from "../db/schema.js";
import { logger } from "./logger.js";

// P0 hardening (MIDAD Final Pre-Launch, SaaS & Sale-Readiness Audit) —
// Feature Flags foundation. The ONE evaluation function every enforcement
// point in the app calls (requireFeatureFlag() below, the tenant-facing
// GET /api/feature-flags route, and any future call site) — no endpoint
// re-implements this precedence logic. See db/schema.ts's comment above
// featureFlags for the full precedence rationale.

export async function isFeatureEnabled(companyId: string, flagKey: string): Promise<boolean> {
  const flag = await db.query.featureFlags.findFirst({ where: eq(featureFlags.key, flagKey) });
  if (!flag) {
    // Fail closed: a typo'd or not-yet-created flag key must never
    // silently behave as "enabled" — that would be indistinguishable from
    // a real rollout decision. Logged so a genuine typo is discoverable.
    logger.warn("feature_flag_unknown", { flagKey, companyId });
    return false;
  }

  if (flag.enabledEnvironments && flag.enabledEnvironments.length > 0) {
    const currentEnv = process.env.NODE_ENV ?? "development";
    if (!flag.enabledEnvironments.includes(currentEnv)) return false;
  }

  // Global OFF => OFF, unconditionally — no per-company override can turn
  // on a feature the platform has switched off globally.
  if (!flag.globalEnabled) return false;

  const override = await db.query.companyFeatureFlagOverrides.findFirst({
    where: and(eq(companyFeatureFlagOverrides.companyId, companyId), eq(companyFeatureFlagOverrides.flagKey, flagKey)),
  });
  if (override) return override.enabled;

  return flag.defaultEnabledForOrgs;
}

// Effective flag set for a company — every known flag key mapped to its
// evaluated boolean for that company. Used by the tenant-facing read
// endpoint (routes/featureFlags.ts) so the client has one source of truth
// to render against, never re-deriving the precedence rules itself.
export async function getEffectiveFlagsForCompany(companyId: string): Promise<Record<string, boolean>> {
  const flags = await db.query.featureFlags.findMany();
  const result: Record<string, boolean> = {};
  for (const flag of flags) {
    result[flag.key] = await isFeatureEnabled(companyId, flag.key);
  }
  return result;
}

// Server-side enforcement for a route gated behind a feature flag — the
// audit's own explicit requirement ("Frontend hiding وحده غير مقبول").
// Returns 404, not 403: an unreleased/rolled-back feature should read as
// "this endpoint doesn't exist" to a client probing for it, not "you lack
// permission" (which would confirm the feature exists but is withheld).
export function requireFeatureFlag(flagKey: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const enabled = await isFeatureEnabled(req.companyId!, flagKey);
    if (!enabled) return res.status(404).json({ error: "غير موجود" });
    next();
  };
}
