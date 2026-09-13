// MIDAD — Platform Admin Console (client for D1/D2) — kept out of ../../api/types.ts on purpose: a
// PlatformOperator is not a tenant User, an Organization row here is a
// deliberately reduced view of Company (id/name/createdAt only, matching
// exactly what server/src/routes/platformOrganizations.ts returns), and
// none of these types should ever be reachable from tenant-side code.

export type PlatformOperatorRole = "platform_operator" | "platform_owner" | "platform_admin" | "support" | "compliance" | "auditor";

export interface PlatformOperator {
  id: string;
  name: string;
  email: string;
  // Present on the login response (server/src/routes/platformAuth.ts) but
  // optional here — anything constructing a PlatformOperator without it
  // (there is none today) still typechecks rather than being forced to
  // invent a role.
  role?: PlatformOperatorRole;
}

// MIDAD Final Pre-Launch audit, Phase 5 — the per-organization user
// surface (server/src/routes/platformOrganizations.ts's /:id/users*
// routes) — deliberately a different, narrower shape than tenant-side
// ../../api/types.ts's own User (no companyId; this is always scoped by
// the URL's :id already).
export type PlatformOrgUserStatus = "active" | "deactivated";

export interface PlatformOrgUser {
  id: string;
  name: string;
  email: string;
  role: string;
  status: PlatformOrgUserStatus;
  createdAt: string;
}

export interface OrganizationDetail {
  id: string;
  name: string;
  createdAt: string;
  status: "active" | "suspended";
  plan: { key: string; name: string } | null;
  entitlements: unknown;
  usage: { userCount: number; projectCount: number };
  zatca: { egsUnitCount: number; byStatus: Record<string, number> };
}

export interface Organization {
  id: string;
  name: string;
  createdAt: string;
}

export interface OrganizationPage {
  organizations: Organization[];
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface SupportSession {
  id: string;
  targetCompanyId: string;
  reason: string;
  createdAt: string;
  expiresAt: string;
}

export type SupportSessionStatus = "active" | "expired" | "revoked";

export interface SupportSessionSummary {
  id: string;
  targetCompanyId: string;
  targetCompanyName: string | null;
  reason: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  status: SupportSessionStatus;
}

export interface SupportSessionListPage {
  sessions: SupportSessionSummary[];
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface SupportActivityEvent {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  actorName: string | null;
  createdAt: string;
}

export interface SupportActivityPage {
  events: SupportActivityEvent[];
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface PlatformActivityEvent {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  companyId: string;
  companyName: string | null;
  reason: string | null;
  createdAt: string;
}

export interface PlatformActivityPage {
  events: PlatformActivityEvent[];
  limit: number;
  offset: number;
  hasMore: boolean;
}

// MIDAD Admin Dashboard — ZATCA operations (Slice 3), matching
// server/src/routes/platformZatca.ts exactly. Never a shape that could
// carry secretRef/binarySecurityToken — the server route never selects
// those columns in the first place.
export interface PlatformZatcaExpiringCertificate {
  egsUnitId: string;
  companyId: string;
  companyName: string | null;
  environment: string;
  certificateExpiresAt: string;
}

export interface PlatformZatcaFailedCheck {
  id: string;
  companyId: string;
  companyName: string | null;
  egsUnitId: string;
  action: string;
  detail: unknown;
  createdAt: string;
}

export interface PlatformZatcaSubmission {
  id: string;
  companyId: string;
  companyName: string | null;
  egsUnitId: string;
  environment: string;
  state: string;
  documentTypeCode: string;
  zatcaErrorCode: string | null;
  zatcaErrorMessage: string | null;
  createdAt: string;
  respondedAt: string | null;
}

// Slice 4 — mirrors server/src/lib/zatca/domain/onboarding.ts's
// ZatcaOnboardingStatus exactly (see ../../api/types.ts's tenant-side
// copy of the same union).
export type PlatformZatcaOnboardingStatus =
  | "not_configured"
  | "configuration_incomplete"
  | "ready_for_simulation"
  | "simulation_connected"
  | "simulation_failed"
  | "production_not_enabled";

export interface PlatformZatcaSummary {
  totalEgsUnits: number;
  byStatus: Record<string, number>;
  byEnvironment: Record<string, number>;
  onboardingByStatus: Record<PlatformZatcaOnboardingStatus, number>;
  submissionsByState: Record<string, number>;
  expiringCertificates: PlatformZatcaExpiringCertificate[];
  recentFailedChecks: PlatformZatcaFailedCheck[];
  recentSubmissions: PlatformZatcaSubmission[];
}

// --- Phase 3 — Plans & Entitlements (server/src/routes/platformPlans.ts) ---

export interface PlanLimits {
  maxUsers?: number | null;
  maxProjects?: number | null;
  maxStorageMb?: number | null;
  maxInvoicesPerMonth?: number | null;
}

export interface Plan {
  id: string;
  key: string;
  name: string;
  description: string | null;
  isActive: boolean;
  limits: PlanLimits;
  createdAt: string;
  updatedAt: string;
}

// --- Phase 2/15 — Feature Flags (server/src/routes/platformFeatureFlags.ts) ---

export interface FeatureFlag {
  id: string;
  key: string;
  description: string;
  globalEnabled: boolean;
  defaultEnabledForOrgs: boolean;
  enabledEnvironments: string[] | null;
  createdAt: string;
  updatedAt: string;
}

export interface FeatureFlagOverride {
  id: string;
  companyId: string;
  flagKey: string;
  enabled: boolean;
  setByPlatformOperatorId: string;
  updatedAt: string;
}

// --- Phase 7 — Security Center (server/src/routes/platformSecurity.ts) ---

export interface SecurityOverview {
  adminSessions: { total: number; active: number; expired: number; revoked: number };
  tenantSessions: {
    activeCount: number;
    oldestActiveSessionCreatedAt: string | null;
    oldestActiveSessionAgeSeconds: number | null;
  };
  notAvailable: string[];
}

export interface AdminSessionSummary {
  id: string;
  platformOperatorId: string;
  platformOperatorName: string | null;
  targetCompanyId: string;
  targetCompanyName: string | null;
  reason: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  status: SupportSessionStatus;
  ageSeconds: number;
}

export interface AdminSessionsPage {
  sessions: AdminSessionSummary[];
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface SensitiveActionEvent {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  companyId: string;
  companyName: string | null;
  platformOperatorId: string | null;
  platformOperatorName: string | null;
  reason: string | null;
  metadata: unknown;
  createdAt: string;
}

export interface SensitiveActionsPage {
  events: SensitiveActionEvent[];
  limit: number;
  offset: number;
  hasMore: boolean;
}

// --- Phase 9 — Ownership Transfer (server/src/routes/platformOwnershipTransfer.ts) ---

export interface OwnershipTransferCandidate {
  id: string;
  name: string;
  email: string;
  role: PlatformOperatorRole;
}

export interface OwnershipTransferResult {
  previousOwner: { id: string; email: string; newRole: string };
  newOwner: { id: string; email: string; newRole: string };
  reason: string;
  revokedSessionCount: number;
  transferredAt: string;
}

// --- Phase 10-11 — Tenant Export/Import (server/src/routes/platformTenantData.ts) ---
// Deliberately typed as loosely as the server itself treats these (the
// bundle is a full, dynamic multi-table dump) — the client never inspects
// table contents itself, only passes the bundle through to /validate and
// /confirm and offers it as a downloadable file.

export interface TenantExportManifest {
  manifestVersion: "1";
  exportedAt: string;
  schema: { migrationCount: number; latestMigrationTag: string };
  companyId: string;
  companyName: string;
  includesAuditEvents: true;
  includesDocumentBytes: boolean;
  redactedColumns: Record<string, string[]>;
  excludedTables: string[];
  tableRowCounts: Record<string, number>;
  checksumSha256: string;
}

export interface TenantExportBundle {
  manifest: TenantExportManifest;
  company: Record<string, unknown>;
  tables: Record<string, Record<string, unknown>[]>;
}

export interface TenantImportPreview {
  manifest: TenantExportManifest;
  companyName: string;
  checksumValid: boolean;
  schemaCompatible: boolean;
  currentSchemaLatestTag: string;
  companyIdAlreadyExists: boolean;
  canImport: boolean;
  blockers: string[];
}

export interface TenantImportResult {
  companyId: string;
  companyName: string;
  importedTableRowCounts: Record<string, number>;
  verified: boolean;
  passwordResetRequiredForImportedUsers: boolean;
}

// --- Phase 12 — Backup Center (server/src/routes/platformBackupCenter.ts) ---

export interface BackupManifestSummary {
  manifestVersion: string;
  createdAt: string;
  app: { packageVersion: string };
  schema: { migrationCount: number; latestMigrationTag: string };
  database: { dumpFile: string; format: string; checksumSha256: string; sizeBytes: number; rowCounts: Record<string, number> };
  storage: { included: boolean; provider: string };
}

export interface BackupCenterStatus {
  found: boolean;
  backupDirectory: string;
  manifest: BackupManifestSummary | null;
  ageSeconds: number | null;
  restoreDrillTrackedIn: string;
}

// --- Phase 13 — Incidents (server/src/routes/platformIncidents.ts) ---

export type IncidentSeverity = "low" | "medium" | "high" | "critical";
export type IncidentStatus = "open" | "investigating" | "resolved";

export interface Incident {
  id: string;
  companyId: string | null;
  title: string;
  description: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  affectedService: string;
  correlationId: string | null;
  source: string;
  resolutionNotes: string | null;
  createdByPlatformOperatorId: string;
  resolvedByPlatformOperatorId: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

// --- Phase 17 — Sale/Handover Center (server/src/routes/platformHandover.ts) ---

export interface HandoverSummary {
  organizations: { total: number; active: number; suspended: number };
  platformOperators: { total: number; owners: number; admins: number; active: number };
  featureFlags: { total: number; globallyEnabled: number };
  plans: { total: number; active: number };
  openIncidents: { open: number; investigating: number };
  backup: { found: boolean; ageSeconds: number | null; restoreDrillTrackedIn: string };
  schema: { migrationCount: number; latestMigrationTag: string };
  zatca: { liveExternalVerification: boolean; statusDocument: string };
  notAvailable: string[];
  launchChecklistDocument: string;
}
