import type { NextFunction, Request, Response } from "express";

// MIDAD Final Pre-Launch audit, Phase 6 — Platform Role Separation. The
// enforced side of the role matrix db/schema.ts's platformOperatorRoleEnum
// comment describes. One capability = one well-defined slice of what a
// platform route can do; every routes/platform*.ts file maps its own
// routes onto exactly the capabilities it needs — adding a new platform
// route means picking (or, rarely, adding) a capability here, not
// inventing a per-route ad hoc role check.
export type PlatformCapability =
  | "organizations.read"
  | "organizations.manage"
  | "users.read"
  | "users.manage"
  | "plans.read"
  | "plans.manage"
  | "featureFlags.read"
  | "featureFlags.manage"
  | "supportSessions.manage"
  | "zatca.read"
  | "security.read"
  | "ownershipTransfer.manage"
  // MIDAD Final Pre-Launch audit, Phase 10-11 — Tenant Export/Import. A
  // bulk, whole-tenant data operation, not a passive read (an export
  // bundle is a full copy of a tenant's business data) and not scoped to
  // any single support ticket — owner/admin only, like plans/feature
  // flags, never support/compliance/auditor.
  | "tenantData.manage"
  // MIDAD Final Pre-Launch audit, Phase 13 — Observability/Incident
  // Center. Deliberately its own capability pair rather than reusing
  // security.read: incidents are a distinct, mutable record (create,
  // investigate, resolve), not the read-only administrative-activity feed
  // security.read covers. compliance gets both, since ZATCA failures are
  // explicitly incident-worthy and within its domain; support does not —
  // its scope stays "support sessions only", same precedent as every
  // other capability in this file.
  | "incidents.read"
  | "incidents.manage"
  // MIDAD Final Pre-Launch audit, Phase 17 — Sale/Handover Center.
  // Read-only aggregate snapshot for a prospective buyer's or new
  // operator's technical due diligence — never a mutation, so there is no
  // "handover.manage" counterpart. Same read-only-oversight role set as
  // security.read (owner/admin/auditor), for the same reason: this is
  // exactly the kind of platform-health overview an auditor role covers.
  | "handover.read";

const ALL_CAPABILITIES: PlatformCapability[] = [
  "organizations.read",
  "organizations.manage",
  "users.read",
  "users.manage",
  "plans.read",
  "plans.manage",
  "featureFlags.read",
  "featureFlags.manage",
  "supportSessions.manage",
  "zatca.read",
  "security.read",
  "ownershipTransfer.manage",
  "tenantData.manage",
  "incidents.read",
  "incidents.manage",
  "handover.read",
];

// Every value db/schema.ts's platformOperatorRoleEnum can hold, including
// the legacy "platform_operator" value migration 0048 moves every real
// row off — kept here only so this map has an exhaustive, type-checked
// entry for it rather than an implicit fallback.
type PlatformOperatorRole = "platform_operator" | "platform_owner" | "platform_admin" | "support" | "compliance" | "auditor";

const ROLE_CAPABILITIES: Record<PlatformOperatorRole, ReadonlySet<PlatformCapability>> = {
  // Legacy value — see schema.ts's own comment above the enum. Treated as
  // owner-equivalent only as a fail-safe for a row that somehow still
  // carries it; no code path assigns it to a new or updated row.
  platform_operator: new Set(ALL_CAPABILITIES),
  // Highest role: ownership transfer, platform administration, critical
  // configuration — every capability that exists.
  platform_owner: new Set(ALL_CAPABILITIES),
  // Operational management without ownership transfer.
  platform_admin: new Set(ALL_CAPABILITIES.filter((c) => c !== "ownershipTransfer.manage")),
  // Support sessions / customer assistance only — read access to identify
  // and assist a target organization/user, plus the support-session
  // mechanism itself. No plan/feature-flag/ZATCA administration, no
  // organization or user mutation, no ownership transfer.
  support: new Set<PlatformCapability>(["organizations.read", "users.read", "supportSessions.manage"]),
  // ZATCA/compliance-related administrative access. Includes incident
  // read+manage: compliance can create/manage incidents within its own
  // domain (e.g. a ZATCA integration failure), same reasoning as its
  // existing zatca.read grant.
  compliance: new Set<PlatformCapability>(["organizations.read", "zatca.read", "incidents.read", "incidents.manage"]),
  // Read-only, cannot modify data — every *.read capability, no *.manage
  // or supportSessions.manage (a support session grants real tenant-data
  // access, which is a support/operational grant, not a passive read).
  // Includes security.read: oversight of platform-wide administrative
  // activity is exactly an auditor's role. Includes incidents.read for
  // the same reason.
  auditor: new Set<PlatformCapability>([
    "organizations.read",
    "users.read",
    "plans.read",
    "featureFlags.read",
    "zatca.read",
    "security.read",
    "incidents.read",
    "handover.read",
  ]),
};

export function hasPlatformCapability(role: string, capability: PlatformCapability): boolean {
  const capabilities = ROLE_CAPABILITIES[role as PlatformOperatorRole];
  return capabilities ? capabilities.has(capability) : false;
}

// Mounted AFTER middleware/platformAuth.ts's platformAuth on any route
// that needs a specific capability, so req.platformOperatorId/
// platformOperatorRole are already verified and set — this never
// re-queries the database itself, it only reads what platformAuth's own
// re-read-on-every-request check already established this request.
export function requirePlatformCapability(capability: PlatformCapability) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.platformOperatorRole || !hasPlatformCapability(req.platformOperatorRole, capability)) {
      return res.status(403).json({ error: "لا تملك الصلاحية للقيام بهذا الإجراء" });
    }
    next();
  };
}
