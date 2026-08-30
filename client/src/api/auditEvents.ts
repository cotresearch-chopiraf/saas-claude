import { apiFetch } from "./client";
import type { ActivityPage } from "./types";

// Thin typed wrapper over server/src/routes/auditEvents.ts — no
// calculation, no authorization logic. Mirrors api/customers.ts's own
// pattern exactly.

export interface ListActivityInput {
  limit?: number;
  offset?: number;
  entityType?: string;
}

export function listActivity(input: ListActivityInput = {}): Promise<ActivityPage> {
  const params = new URLSearchParams();
  if (input.limit !== undefined) params.set("limit", String(input.limit));
  if (input.offset !== undefined) params.set("offset", String(input.offset));
  if (input.entityType) params.set("entityType", input.entityType);
  const qs = params.toString();
  return apiFetch<ActivityPage>(`/audit-events${qs ? `?${qs}` : ""}`);
}
