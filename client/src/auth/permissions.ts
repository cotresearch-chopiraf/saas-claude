import type { CompanyRole } from "../api/types";

// Mirrors the NAMES in server/src/lib/permissions.ts's PERMISSIONS map, for
// UI visibility only — this is NOT an authorization system. Every mutation
// route the backend exposes independently re-checks the caller's role from
// the database via requirePermission() on every request; hiding an action
// here only avoids showing a control the backend would reject anyway. A
// hidden button is a UX courtesy, never a security boundary.
//
// Every entry in the real backend matrix is currently owner-only (no
// existing financial domain splits authority within itself), so this stays
// a flat "these actions require owner" list rather than a full per-role
// map. If the backend ever introduces an action open to some non-owner
// role other than "no gate at all", extend hasPermission's logic then —
// don't pre-build a general rules engine for a distinction that doesn't
// exist yet.
export const OWNER_ONLY_ACTIONS = [
  "contract.manage",
  "boq.manage",
  "costCode.manage",
  "budgetRevision.manage",
  "commitment.manage",
  "supplier.manage",
  "customer.manage",
  "measurement.approve",
  "ipc.manage",
  "forecast.manage",
  "invoice.send",
  "invoice.markPaid",
  "subcontractIpc.manage",
  // MIDAD Phase 4 — mirrors an action that already existed server-side
  // since Phase 1 (server/src/lib/permissions.ts's "compliance.manage")
  // but was never mirrored here because no client screen consumed it
  // until now. Not a new permission — see this file's own header comment:
  // every entry here is a UI-only mirror of an already-authoritative
  // server-side name.
  "compliance.manage",
  // MIDAD Phase A — same precedent as compliance.manage above: mirrors
  // server/src/lib/permissions.ts's pre-existing "company.manage" (already
  // gating /company/settings, /company/invites, etc.) so the new role-change
  // /deactivate/reactivate controls on the Team page can be hidden from
  // non-owners the same way every other owner-only control already is.
  "company.manage",
  // MIDAD ZATCA e-invoicing (Slice 3) — mirrors server/src/lib/permissions.ts's
  // "zatca.configure" / "zatca.submit", same precedent as compliance.manage
  // above.
  "zatca.configure",
  "zatca.submit",
  // Slice AA — mirrors server/src/lib/permissions.ts's new
  // "task.delete"/"dailyLog.delete" (create/update remain member-open,
  // matching this domain's long-established posture; only the
  // irreversible action is owner-gated, same precedent as every other
  // ".delete"-shaped action).
  "task.delete",
  "dailyLog.delete",
  // Final Pre-Launch Audit — mirrors server/src/lib/permissions.ts's new
  // "budget.manage" (see that file's comment for why the legacy budget
  // item/expense CRUD needed a gate at all).
  "budget.manage",
  // Phase A2 — mirrors server/src/lib/permissions.ts's new
  // "workforce.manage" (Employees CRUD create/update/status-toggle; reads
  // stay member-open, same split every other domain in this list uses).
  "workforce.manage",
  // Phase A3 — mirrors server/src/lib/permissions.ts's pre-existing
  // "payroll.manage" (added in A1, first consumed here): payroll period
  // create/update/submit/approve/reject and payroll record create/update.
  "payroll.manage",
  // Phase A5 — mirrors server/src/lib/permissions.ts's pre-existing
  // "payroll.post" (added in A1, first consumed here): the one
  // irreversible, money-moving action (POST /payroll-periods/:id/post and
  // POST /labor-cost-postings/:id/reverse) — deliberately separate from
  // "payroll.manage" above, same reason "invoice.markPaid" is separate
  // from invoice creation.
  "payroll.post",
  // Phase C1 — mirrors server/src/lib/permissions.ts's new
  // "projectTask.delete": deleting a schedule task/milestone or a
  // dependency edge (create/update stay member-open, same task.delete/
  // dailyLog.delete precedent above).
  "projectTask.delete",
  // Phase C2 — mirrors server/src/lib/permissions.ts's new
  // "punchItem.delete": deleting a punch list item (create/update/status
  // transitions stay member-open, same task.delete/dailyLog.delete/
  // projectTask.delete precedent above).
  "punchItem.delete",
  // Phase D1 — mirrors server/src/lib/permissions.ts's new
  // "laborCompliance.manage"/"laborCompliance.verify". Deliberately NOT
  // named "compliance.manage" — that name already exists for the
  // unrelated tax/ZATCA compliance domain (see that file's own comment).
  "laborCompliance.manage",
  "laborCompliance.verify",
  // Phase E — mirrors server/src/lib/permissions.ts's new
  // "budgetAlert.manage" (acknowledge/resolve). Reads and triggering
  // evaluation stay member-open, same split every other domain in this list
  // uses.
  "budgetAlert.manage",
] as const;

export type PermissionAction = (typeof OWNER_ONLY_ACTIONS)[number];

// Every currently-known action is owner-only (see OWNER_ONLY_ACTIONS above),
// so this is honestly just role === "owner" today. The action parameter is
// kept so call sites already read as self-documenting (<Can
// permission="ipc.manage">) and so this one function is the only place that
// would need to change if the backend ever adds a non-owner-gated but still
// named action.
export function hasPermission(role: CompanyRole | undefined, action: PermissionAction): boolean {
  void action;
  return role === "owner";
}
