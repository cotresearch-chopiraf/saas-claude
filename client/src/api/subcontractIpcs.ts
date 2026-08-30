import { apiFetch } from "./client";
import type { SubcontractIpc, SubcontractIpcCreateResult, SubcontractIpcLine, SubcontractIpcWithLines } from "./types";

// Thin typed wrappers over the existing, verified Subcontractor IPC API
// (server/src/routes/subcontractIpcs.ts) — no calculation, no
// authorization logic. The backend owns every state transition and every
// certified financial figure (grossValue/retentionAmount/netCertified and
// each line's currentValue/previousCertified*/cumulative*); this module
// only forwards requests and returns exactly what the API responds with.

export function listSubcontractIpcs(projectId: string): Promise<SubcontractIpc[]> {
  return apiFetch<SubcontractIpc[]>(`/projects/${projectId}/subcontract-ipcs`);
}

export function getSubcontractIpc(projectId: string, ipcId: string): Promise<SubcontractIpcWithLines> {
  return apiFetch<SubcontractIpcWithLines>(`/projects/${projectId}/subcontract-ipcs/${ipcId}`);
}

export interface CreateSubcontractIpcInput {
  commitmentId: string;
  periodStart: string;
  periodEnd: string;
  notes?: string;
}

// Returns SubcontractIpcCreateResult, NOT the full SubcontractIpc shape —
// see types.ts's comment on SubcontractIpcCreateResult for why (a raw-SQL
// RETURNING, not Drizzle).
export function createSubcontractIpc(projectId: string, input: CreateSubcontractIpcInput): Promise<SubcontractIpcCreateResult> {
  return apiFetch<SubcontractIpcCreateResult>(`/projects/${projectId}/subcontract-ipcs`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// Exactly one of currentQuantity/currentValue is sent, depending on
// whether the referenced commitment line carries quantity+rate or is
// amount-only — the caller decides which based on the commitment line it
// already has, never both, never a fabricated value for the other.
export interface SubcontractIpcLineInput {
  commitmentLineId: string;
  currentQuantity?: number;
  currentValue?: number;
  description?: string;
  sortOrder?: number;
}

export function addSubcontractIpcLine(projectId: string, ipcId: string, input: SubcontractIpcLineInput): Promise<SubcontractIpcLine> {
  return apiFetch<SubcontractIpcLine>(`/projects/${projectId}/subcontract-ipcs/${ipcId}/items`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function deleteSubcontractIpcLine(projectId: string, ipcId: string, lineId: string): Promise<void> {
  return apiFetch<void>(`/projects/${projectId}/subcontract-ipcs/${ipcId}/items/${lineId}`, { method: "DELETE" });
}

export function submitSubcontractIpc(projectId: string, ipcId: string): Promise<SubcontractIpc> {
  return apiFetch<SubcontractIpc>(`/projects/${projectId}/subcontract-ipcs/${ipcId}/submit`, { method: "POST" });
}

export function approveSubcontractIpc(projectId: string, ipcId: string): Promise<SubcontractIpc> {
  return apiFetch<SubcontractIpc>(`/projects/${projectId}/subcontract-ipcs/${ipcId}/approve`, { method: "POST" });
}

export function rejectSubcontractIpc(projectId: string, ipcId: string, reason: string): Promise<SubcontractIpc> {
  return apiFetch<SubcontractIpc>(`/projects/${projectId}/subcontract-ipcs/${ipcId}/reject`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

export function certifySubcontractIpc(projectId: string, ipcId: string): Promise<SubcontractIpc> {
  return apiFetch<SubcontractIpc>(`/projects/${projectId}/subcontract-ipcs/${ipcId}/certify`, { method: "POST" });
}
