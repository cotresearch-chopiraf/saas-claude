import type { NextFunction, Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { logger } from "./logger.js";

export type Role = "owner" | "member";

// Single source of truth for which role a sensitive action requires. Every
// financially significant or destructive mutation is named here explicitly
// (action-level, not a single generic isMember()/isOwner() sprinkled across
// routes) — adding a new sensitive action means adding one line here, not
// hunting for the right place to inline a role check.
export const PERMISSIONS = {
  // Moves real budget money — see changeOrders.ts.
  "changeOrder.approve": ["owner"],
  // Communicates a financial document to a real client — see invoices.ts / quotes.ts.
  "invoice.send": ["owner"],
  "invoice.markPaid": ["owner"],
  "quote.send": ["owner"],
  // Destroys a project and everything under it — see projects.ts.
  "project.delete": ["owner"],
  // Company settings, logo, and team invites — see company.ts.
  "company.manage": ["owner"],
  // Tax/compliance configuration is as sensitive as company settings —
  // VAT rates, tax IDs, Zakat/withholding configuration, e-invoicing
  // profile. A plain member can VIEW the compliance status (read-only
  // routes are not gated by this) but never change it. See routes/compliance.ts.
  "compliance.manage": ["owner"],

  // --- MIDAD Phase 1 — Foundation ---
  // Naming convention going forward: "<domain>.<verb>", where <domain> is
  // one of the domains this matrix is expected to grow into (Organization,
  // Project, Financial, Procurement, Subcontractor, Site, Approval,
  // Reporting, Administration — per the approved Phase 1 scope, only the
  // actions actually needed this phase are added; the convention is
  // established now so later phases extend this same map instead of
  // inventing a second one). All four below are Financial-domain actions
  // and are owner-only for the same reason every other financial mutation
  // in this matrix is: Phase 1's stated priority is protecting sensitive
  // financial operations, not building out a larger role vocabulary yet.
  "contract.manage": ["owner"],
  "boq.manage": ["owner"],
  "costCode.manage": ["owner"],
  "budgetRevision.manage": ["owner"],

  // TC-02 fix: an explicit taxRatePercent in the invoice-creation body
  // bypasses the compliance engine entirely (no ruleVersionId/override
  // provenance is recorded for it) — see routes/invoices.ts. The
  // engine-computed path stays open to any authenticated member (it's
  // already correctly audited via the frozen ruleVersionId/
  // overrideReference fields); only a manual override needs owner.
  "invoice.overrideTax": ["owner"],

  // --- MIDAD Phase 2A — Procurement / Commitment ---
  // A Commitment is a binding outflow obligation to a third party (a PO or
  // Subcontract) — at least as consequential as Contract (the inflow
  // side), which is owner-only end-to-end. No existing precedent in this
  // matrix splits authority within one financial domain (draft-by-member,
  // approve-by-owner) — Contract/BOQ/CostCode/BudgetRevision are all
  // owner-gated for every mutation, not just approval. Introducing that
  // split for Commitment specifically would be the first asymmetric-
  // authority financial domain in this codebase, a bigger RBAC decision
  // than this phase's scope calls for — so, matching every other Phase 1
  // financial domain exactly, every commitment mutation (create, add/
  // remove line, submit, approve, amend, cancel) requires owner. Read
  // access (GET) is unrestricted, same as every other domain.
  "commitment.manage": ["owner"],
  // A supplier directory is company-sensitive master data, same posture
  // as costCode.manage / company.manage.
  "supplier.manage": ["owner"],

  // --- MIDAD Phase 2B — Progress / Measurement ---
  // Unlike Commitment, Measurement is site-level operational evidence
  // entry, not a financial/commercial instrument — the same class of
  // action as tasks.ts / dailyLogs.ts, which this codebase has always
  // left open to any member with no requirePermission gate at all. So
  // creating a measurement, adding/removing its lines, and submitting it
  // are deliberately NOT listed here (member-accessible, matching that
  // precedent exactly) — only the approval/rejection trust boundary
  // (someone signs off that this physical progress is real, which a
  // future IPC will build on) requires owner, the same posture as
  // changeOrder.approve.
  "measurement.approve": ["owner"],

  // --- MIDAD Phase 2C — IPC (Interim Payment Certificate) ---
  // Unlike Measurement, an IPC line itself defines a monetary figure the
  // moment it's added (currentValue = currentQuantity * rate) — it is not
  // pure quantity evidence, it's the certification instrument. That makes
  // the whole domain closer to Contract/BOQ/CostCode/BudgetRevision/
  // Commitment (fully owner-gated end-to-end) than to Measurement/tasks/
  // dailyLogs (member-open site entry). So, matching that financial-
  // instrument precedent exactly: every IPC mutation (create, add/remove
  // line, submit, approve, reject, certify) requires owner. Read access
  // is unrestricted, same as every domain.
  "ipc.manage": ["owner"],
} as const satisfies Record<string, readonly Role[]>;

export type PermissionAction = keyof typeof PERMISSIONS;

// Role is re-read from the database on every call rather than trusted from
// the JWT: a role change (e.g. demoting a member) then takes effect on the
// very next request instead of only after that user's token is refreshed.
export async function getUserRole(userId: string): Promise<Role | null> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  return (user?.role as Role | undefined) ?? null;
}

export function isPermittedRole(action: PermissionAction, role: Role | null): boolean {
  if (!role) return false;
  return (PERMISSIONS[action] as readonly Role[]).includes(role);
}

export function requirePermission(action: PermissionAction) {
  return async function (req: Request, res: Response, next: NextFunction) {
    const role = await getUserRole(req.userId!);
    if (!isPermittedRole(action, role)) {
      logger.warn("authorization_denied", {
        action,
        userId: req.userId,
        companyId: req.companyId,
        role,
        path: req.path,
        method: req.method,
      });
      return res.status(403).json({ error: "لا تملك صلاحية تنفيذ هذا الإجراء" });
    }
    next();
  };
}
