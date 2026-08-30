import { apiFetch } from "./client";
import type { Ipc, IpcCreateResult, IpcLine, IpcWithLines } from "./types";

// Thin typed wrappers over the existing, verified IPC API
// (server/src/routes/ipcs.ts) — no calculation, no authorization logic.
// The backend owns every state transition, every line's frozen value, and
// the certification-time ledger freeze; nothing here ever reproduces
// grossValue/retentionAmount/netCertified or any quantity/value formula.

export function listIpcs(projectId: string): Promise<Ipc[]> {
  return apiFetch<Ipc[]>(`/projects/${projectId}/ipcs`);
}

export function getIpc(projectId: string, ipcId: string): Promise<IpcWithLines> {
  return apiFetch<IpcWithLines>(`/projects/${projectId}/ipcs/${ipcId}`);
}

export interface CreateIpcInput {
  contractId: string;
  boqRevisionId: string;
  periodStart: string;
  periodEnd: string;
  notes?: string;
}

// Returns IpcCreateResult, NOT the full Ipc shape — see types.ts's
// comment on IpcCreateResult for why (a raw-SQL RETURNING, not Drizzle).
export function createIpc(projectId: string, input: CreateIpcInput): Promise<IpcCreateResult> {
  return apiFetch<IpcCreateResult>(`/projects/${projectId}/ipcs`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export interface IpcLineInput {
  boqItemId: string;
  currentQuantity: number;
  description?: string;
  sortOrder?: number;
}

export function addIpcLine(projectId: string, ipcId: string, input: IpcLineInput): Promise<IpcLine> {
  return apiFetch<IpcLine>(`/projects/${projectId}/ipcs/${ipcId}/items`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function deleteIpcLine(projectId: string, ipcId: string, lineId: string): Promise<void> {
  return apiFetch<void>(`/projects/${projectId}/ipcs/${ipcId}/items/${lineId}`, { method: "DELETE" });
}

export function submitIpc(projectId: string, ipcId: string): Promise<Ipc> {
  return apiFetch<Ipc>(`/projects/${projectId}/ipcs/${ipcId}/submit`, { method: "POST" });
}

export function approveIpc(projectId: string, ipcId: string): Promise<Ipc> {
  return apiFetch<Ipc>(`/projects/${projectId}/ipcs/${ipcId}/approve`, { method: "POST" });
}

export function rejectIpc(projectId: string, ipcId: string, reason: string): Promise<Ipc> {
  return apiFetch<Ipc>(`/projects/${projectId}/ipcs/${ipcId}/reject`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

export function certifyIpc(projectId: string, ipcId: string): Promise<Ipc> {
  return apiFetch<Ipc>(`/projects/${projectId}/ipcs/${ipcId}/certify`, { method: "POST" });
}
