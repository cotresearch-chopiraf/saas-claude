import { eq, and, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { companies, plans, users, type PlanLimits } from "../db/schema.js";
import { logger } from "./logger.js";

// P0 hardening (MIDAD Final Pre-Launch, SaaS & Sale-Readiness Audit) —
// Plans & Entitlements. The ONE evaluation source every usage-limit check
// in the app calls — no route hardcodes a number itself. See
// db/schema.ts's comment above `plans` for the full model rationale
// (deliberately no price/billing column; placeholders, not invented
// pricing).

const UNLIMITED: PlanLimits = {
  maxUsers: null,
  maxProjects: null,
  maxStorageMb: null,
  maxInvoicesPerMonth: null,
};

// A company with no plan assigned (planId = null, the default for every
// company today — see db/schema.ts's companies.planId comment) is
// unlimited. A company whose assigned plan row is missing (a data
// inconsistency — the plan was deleted while still referenced, or
// onDelete: "set null" hasn't run yet in a race) fails OPEN, not closed:
// this is a business cap, not a security boundary, and silently blocking
// a paying customer's ability to operate because of a data-integrity edge
// case is a worse outcome than temporarily leaving them uncapped. Logged
// either way so the inconsistency is discoverable.
export async function getCompanyLimits(companyId: string): Promise<PlanLimits> {
  const company = await db.query.companies.findFirst({
    where: eq(companies.id, companyId),
    columns: { planId: true },
  });
  if (!company?.planId) return UNLIMITED;

  const plan = await db.query.plans.findFirst({ where: eq(plans.id, company.planId) });
  if (!plan) {
    logger.warn("entitlements_plan_missing", { companyId, planId: company.planId });
    return UNLIMITED;
  }
  return plan.limits;
}

export interface LimitCheckResult {
  allowed: boolean;
  limit: number | null;
  currentCount: number;
}

export async function checkLimit(
  companyId: string,
  limitKey: keyof PlanLimits,
  currentCount: number,
): Promise<LimitCheckResult> {
  const limits = await getCompanyLimits(companyId);
  const limit = limits[limitKey];
  if (limit === null) return { allowed: true, limit: null, currentCount };
  return { allowed: currentCount < limit, limit, currentCount };
}

export class LimitExceededError extends Error {
  constructor(
    public limitKey: keyof PlanLimits,
    public limit: number,
    public currentCount: number,
  ) {
    super(`تم الوصول إلى الحد المسموح به (${limit}) لهذا المورد ضمن خطتكم الحالية`);
    this.name = "LimitExceededError";
  }
}

// Throws LimitExceededError if the resource is at/over its plan limit —
// the call site decides what "current count" means for its own resource
// (e.g. active users, projects, invoices this month) and passes it in;
// this function never runs its own COUNT query, since only the caller
// knows the right scope/filters for its resource.
export async function assertWithinLimit(companyId: string, limitKey: keyof PlanLimits, currentCount: number): Promise<void> {
  const result = await checkLimit(companyId, limitKey, currentCount);
  if (!result.allowed) throw new LimitExceededError(limitKey, result.limit!, currentCount);
}

// Convenience helper for the one limit wired into an endpoint in this
// phase (see routes/company.ts's invite-creation route) — counts ACTIVE
// users only (occupied seats), matching standard SaaS seat-limit semantics
// rather than counting pending invites as already-consumed seats.
export async function countActiveUsers(companyId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(users)
    .where(and(eq(users.companyId, companyId), eq(users.status, "active")));
  return row?.count ?? 0;
}
