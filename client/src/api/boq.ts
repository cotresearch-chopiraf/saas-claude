import { apiFetch } from "./client";
import type { BoqItemType, BoqRevision, BoqRevisionWithItems } from "./types";

// Thin typed wrappers over the existing, verified BOQ API
// (server/src/routes/boq.ts) — no calculation, no authorization logic.
// boqItems.amount is frozen server-side; nothing here ever computes it.

export function listRevisions(projectId: string): Promise<BoqRevision[]> {
  return apiFetch<BoqRevision[]>(`/projects/${projectId}/boq-revisions`);
}

export function getRevision(projectId: string, revisionId: string): Promise<BoqRevisionWithItems> {
  return apiFetch<BoqRevisionWithItems>(`/projects/${projectId}/boq-revisions/${revisionId}`);
}

export function createRevision(projectId: string, input: { contractId: string; notes?: string }): Promise<BoqRevision> {
  return apiFetch<BoqRevision>(`/projects/${projectId}/boq-revisions`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function publishRevision(projectId: string, revisionId: string): Promise<BoqRevision> {
  return apiFetch<BoqRevision>(`/projects/${projectId}/boq-revisions/${revisionId}/publish`, { method: "POST" });
}

export interface AddBoqItemInput {
  parentItemId?: string;
  itemType?: BoqItemType;
  code?: string;
  description: string;
  unit?: string;
  quantity?: number;
  rate?: number;
  costCodeId?: string;
  sortOrder?: number;
}

export function addItem(projectId: string, revisionId: string, input: AddBoqItemInput) {
  return apiFetch(`/projects/${projectId}/boq-revisions/${revisionId}/items`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function deleteItem(projectId: string, revisionId: string, itemId: string): Promise<void> {
  return apiFetch<void>(`/projects/${projectId}/boq-revisions/${revisionId}/items/${itemId}`, { method: "DELETE" });
}
