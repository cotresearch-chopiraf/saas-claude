import { Router } from "express";
import { getEffectiveFlagsForCompany } from "../lib/featureFlags.js";

// P0 hardening (MIDAD Final Pre-Launch, SaaS & Sale-Readiness Audit) —
// tenant-facing read of the effective flag set for the caller's own
// company. Mounted behind requireAuth (see app.ts) — never exposes
// another company's flags, and never exposes the flag registry's
// description/enabledEnvironments/defaultEnabledForOrgs internals (a
// tenant only ever needs "is this on for me", not the platform's rollout
// mechanics). Read-only by design: a tenant cannot set their own
// platform-controlled flags — see db/schema.ts's comment distinguishing
// this from companies.featureFlags (the tenant self-service toggle).
export const featureFlagsRouter = Router();

featureFlagsRouter.get("/", async (req, res) => {
  const flags = await getEffectiveFlagsForCompany(req.companyId!);
  res.json({ flags });
});
