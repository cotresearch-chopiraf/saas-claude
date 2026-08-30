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
  "measurement.approve",
  "ipc.manage",
  "forecast.manage",
  "invoice.send",
  "invoice.markPaid",
  "subcontractIpc.manage",
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
