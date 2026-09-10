import { apiFetch } from "./client";
import type { PunchItem, PunchItemPriority, PunchItemStatus } from "./types";

// MIDAD Phase C2 — thin typed wrappers over the verified Punch List API
// (server/src/routes/punchItems.ts). No calculation, no authorization
// logic — the backend is the sole source of truth for status-transition
// validity and assignee eligibility. INTERNAL ONLY: never imported from
// client/src/portal/.

export interface PunchItemFilters {
  status?: PunchItemStatus;
  priority?: PunchItemPriority;
  assignedToUserId?: string;
  overdue?: boolean;
}

export function listPunchItems(projectId: string, filters: PunchItemFilters = {}): Promise<PunchItem[]> {
  const params = new URLSearchParams();
  if (filters.status) params.set("status", filters.status);
  if (filters.priority) params.set("priority", filters.priority);
  if (filters.assignedToUserId) params.set("assignedToUserId", filters.assignedToUserId);
  if (filters.overdue) params.set("overdue", "true");
  const query = params.toString();
  return apiFetch<PunchItem[]>(`/projects/${projectId}/punch-items${query ? `?${query}` : ""}`);
}

export function getPunchItem(projectId: string, id: string): Promise<PunchItem> {
  return apiFetch<PunchItem>(`/projects/${projectId}/punch-items/${id}`);
}

export interface CreatePunchItemInput {
  title: string;
  description?: string;
  location?: string;
  priority?: PunchItemPriority;
  assignedToUserId?: string | null;
  dueDate?: string | null;
}

export function createPunchItem(projectId: string, input: CreatePunchItemInput): Promise<PunchItem> {
  return apiFetch<PunchItem>(`/projects/${projectId}/punch-items`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export type UpdatePunchItemInput = Partial<CreatePunchItemInput>;

export function updatePunchItem(projectId: string, id: string, input: UpdatePunchItemInput): Promise<PunchItem> {
  return apiFetch<PunchItem>(`/projects/${projectId}/punch-items/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function deletePunchItem(projectId: string, id: string): Promise<void> {
  return apiFetch<void>(`/projects/${projectId}/punch-items/${id}`, { method: "DELETE" });
}

export function transitionPunchItemStatus(
  projectId: string,
  id: string,
  status: PunchItemStatus,
  resolutionDescription?: string,
): Promise<PunchItem> {
  return apiFetch<PunchItem>(`/projects/${projectId}/punch-items/${id}/status`, {
    method: "POST",
    body: JSON.stringify(resolutionDescription ? { status, resolutionDescription } : { status }),
  });
}
