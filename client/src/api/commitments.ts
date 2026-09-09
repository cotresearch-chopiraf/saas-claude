import { apiFetch } from "./client";
import type { Commitment, CommitmentType, CommitmentWithLines } from "./types";

// Thin typed wrappers over the existing, verified Commitment API
// (server/src/routes/commitments.ts) — no calculation, no authorization
// logic, no state-machine implementation. Every field name matches the
// backend exactly; originalAmount/revisedAmount are never computed here.

export function listCommitments(projectId: string): Promise<Commitment[]> {
  return apiFetch<Commitment[]>(`/projects/${projectId}/commitments`);
}

export function getCommitment(projectId: string, commitmentId: string): Promise<CommitmentWithLines> {
  return apiFetch<CommitmentWithLines>(`/projects/${projectId}/commitments/${commitmentId}`);
}

export interface CreateCommitmentInput {
  supplierId: string;
  type: CommitmentType;
  contractId?: string;
  description?: string;
  currency?: string;
  retentionPercent?: number;
}

export function createCommitment(projectId: string, input: CreateCommitmentInput): Promise<Commitment> {
  return apiFetch<Commitment>(`/projects/${projectId}/commitments`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// Final Pre-Launch Audit — commitments.retentionPercent previously had no
// write path anywhere (see server/src/routes/commitments.ts's own comment
// on the new PATCH /terms route this wraps); without it, every subcontract
// IPC's retention silently computed to 0.
export function updateCommitmentTerms(
  projectId: string,
  commitmentId: string,
  input: { retentionPercent: number | null },
): Promise<Commitment> {
  return apiFetch<Commitment>(`/projects/${projectId}/commitments/${commitmentId}/terms`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export interface CommitmentLineInput {
  costCodeId?: string;
  boqItemId?: string;
  description: string;
  quantity?: number;
  rate?: number;
  amount?: number;
  sortOrder?: number;
}

export function addCommitmentLine(projectId: string, commitmentId: string, input: CommitmentLineInput) {
  return apiFetch(`/projects/${projectId}/commitments/${commitmentId}/items`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function deleteCommitmentLine(projectId: string, commitmentId: string, lineId: string): Promise<void> {
  return apiFetch<void>(`/projects/${projectId}/commitments/${commitmentId}/items/${lineId}`, { method: "DELETE" });
}

export function submitCommitment(projectId: string, commitmentId: string): Promise<Commitment> {
  return apiFetch<Commitment>(`/projects/${projectId}/commitments/${commitmentId}/submit`, { method: "POST" });
}

export function approveCommitment(projectId: string, commitmentId: string): Promise<Commitment> {
  return apiFetch<Commitment>(`/projects/${projectId}/commitments/${commitmentId}/approve`, { method: "POST" });
}

export function cancelCommitment(projectId: string, commitmentId: string): Promise<Commitment> {
  return apiFetch<Commitment>(`/projects/${projectId}/commitments/${commitmentId}/cancel`, { method: "POST" });
}

export interface AmendCommitmentInput {
  reason?: string;
  lines: CommitmentLineInput[];
}

export function amendCommitment(projectId: string, commitmentId: string, input: AmendCommitmentInput): Promise<Commitment> {
  return apiFetch<Commitment>(`/projects/${projectId}/commitments/${commitmentId}/amend`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}
