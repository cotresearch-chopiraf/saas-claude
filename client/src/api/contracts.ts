import { apiFetch } from "./client";
import type { Contract, ContractType } from "./types";

// Thin typed wrappers over the existing, verified Contract API
// (server/src/routes/contracts.ts) — no calculation, no authorization
// logic, no aggregation. Every field name matches the backend exactly.

export function listContracts(projectId: string): Promise<Contract[]> {
  return apiFetch<Contract[]>(`/projects/${projectId}/contracts`);
}

export function getContract(projectId: string, contractId: string): Promise<Contract> {
  return apiFetch<Contract>(`/projects/${projectId}/contracts/${contractId}`);
}

export interface CreateContractInput {
  contractType?: ContractType;
  parentContractId?: string;
  contractNumber?: string;
  clientName?: string;
  originalValue: number;
  revisedValue?: number;
  currency?: string;
  advancePercent?: number;
  retentionPercent?: number;
  paymentTerms?: string;
  startDate?: string;
  endDate?: string;
}

export function createContract(projectId: string, input: CreateContractInput): Promise<Contract> {
  return apiFetch<Contract>(`/projects/${projectId}/contracts`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}
