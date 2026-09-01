// MIDAD — Platform Admin Console (client for D1/D2) — kept out of ../../api/types.ts on purpose: a
// PlatformOperator is not a tenant User, an Organization row here is a
// deliberately reduced view of Company (id/name/createdAt only, matching
// exactly what server/src/routes/platformOrganizations.ts returns), and
// none of these types should ever be reachable from tenant-side code.

export interface PlatformOperator {
  id: string;
  name: string;
  email: string;
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
