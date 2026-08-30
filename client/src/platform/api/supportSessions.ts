import { platformApiFetch } from "./platformClient";
import type { SupportActivityPage, SupportSession } from "./types";

export function createSupportSession(targetCompanyId: string, reason: string): Promise<SupportSession> {
  return platformApiFetch("/platform/support-sessions", {
    method: "POST",
    body: JSON.stringify({ targetCompanyId, reason }),
  });
}

export function revokeSupportSession(id: string): Promise<{ id: string; revokedAt: string }> {
  return platformApiFetch(`/platform/support-sessions/${id}/revoke`, { method: "POST" });
}

export function readSupportSessionActivity(id: string, limit = 20, offset = 0): Promise<SupportActivityPage> {
  return platformApiFetch(`/platform/support-sessions/${id}/activity?limit=${limit}&offset=${offset}`);
}
