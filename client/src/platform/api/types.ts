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
