import { apiFetch } from "./client";
import type { Supplier, SupplierStatus, SupplierType } from "./types";

// Thin typed wrappers over the existing, verified Supplier API
// (server/src/routes/suppliers.ts) — no calculation, no authorization
// logic. Company-wide (not project-scoped). No delete endpoint exists.

export function listSuppliers(): Promise<Supplier[]> {
  return apiFetch<Supplier[]>("/suppliers");
}

export interface CreateSupplierInput {
  name: string;
  type: SupplierType;
  taxId?: string;
  email?: string;
  phone?: string;
  address?: string;
}

export function createSupplier(input: CreateSupplierInput): Promise<Supplier> {
  return apiFetch<Supplier>("/suppliers", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export interface UpdateSupplierInput {
  name?: string;
  taxId?: string;
  email?: string;
  phone?: string;
  address?: string;
  status?: SupplierStatus;
}

export function updateSupplier(id: string, input: UpdateSupplierInput): Promise<Supplier> {
  return apiFetch<Supplier>(`/suppliers/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}
