import { platformApiFetch } from "./platformClient";
import type { OrganizationDetail, PlatformOrgUser, PlatformOrgUserStatus } from "./types";

export function getOrganization(id: string): Promise<OrganizationDetail> {
  return platformApiFetch(`/platform/organizations/${id}`);
}

export function suspendOrganization(id: string, reason: string): Promise<{ id: string; status: string; revokedSessionCount: number }> {
  return platformApiFetch(`/platform/organizations/${id}/suspend`, { method: "POST", body: JSON.stringify({ reason }) });
}

export function reactivateOrganization(id: string, reason?: string): Promise<{ id: string; status: string }> {
  return platformApiFetch(`/platform/organizations/${id}/reactivate`, { method: "POST", body: JSON.stringify({ reason }) });
}

export function revokeOrganizationSessions(id: string, reason: string): Promise<{ id: string; revokedSessionCount: number }> {
  return platformApiFetch(`/platform/organizations/${id}/revoke-sessions`, { method: "POST", body: JSON.stringify({ reason }) });
}

export function listOrganizationUsers(id: string): Promise<{ users: PlatformOrgUser[] }> {
  return platformApiFetch(`/platform/organizations/${id}/users`);
}

export function setOrganizationUserStatus(
  id: string,
  userId: string,
  status: PlatformOrgUserStatus,
  reason?: string,
): Promise<{ id: string; status: string }> {
  return platformApiFetch(`/platform/organizations/${id}/users/${userId}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status, reason }),
  });
}

export function revokeOrganizationUserSessions(id: string, userId: string, reason: string): Promise<{ id: string; revokedSessionCount: number }> {
  return platformApiFetch(`/platform/organizations/${id}/users/${userId}/revoke-sessions`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}
