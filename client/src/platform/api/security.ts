import { platformApiFetch } from "./platformClient";
import type { AdminSessionsPage, SecurityOverview, SensitiveActionsPage } from "./types";

export function getSecurityOverview(): Promise<SecurityOverview> {
  return platformApiFetch("/platform/security/overview");
}

export function listAdminSessions(limit = 20, offset = 0): Promise<AdminSessionsPage> {
  return platformApiFetch(`/platform/security/admin-sessions?limit=${limit}&offset=${offset}`);
}

export function listSensitiveActions(limit = 20, offset = 0): Promise<SensitiveActionsPage> {
  return platformApiFetch(`/platform/security/sensitive-actions?limit=${limit}&offset=${offset}`);
}
