import { apiFetch } from "./client";
import type { Customer, CustomerStatus, CustomerWithProjects } from "./types";

// Thin typed wrappers over the existing, verified Customer API
// (server/src/routes/customers.ts) — no calculation, no authorization
// logic. Company-wide (not project-scoped). No delete endpoint exists.
// Mirrors api/suppliers.ts's own pattern exactly.

export function listCustomers(): Promise<Customer[]> {
  return apiFetch<Customer[]>("/customers");
}

export function getCustomer(id: string): Promise<CustomerWithProjects> {
  return apiFetch<CustomerWithProjects>(`/customers/${id}`);
}

export interface CreateCustomerInput {
  name: string;
  contactName?: string;
  taxId?: string;
  email?: string;
  phone?: string;
  address?: string;
  notes?: string;
}

export function createCustomer(input: CreateCustomerInput): Promise<Customer> {
  return apiFetch<Customer>("/customers", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export interface UpdateCustomerInput {
  name?: string;
  contactName?: string;
  taxId?: string;
  email?: string;
  phone?: string;
  address?: string;
  notes?: string;
  status?: CustomerStatus;
}

export function updateCustomer(id: string, input: UpdateCustomerInput): Promise<Customer> {
  return apiFetch<Customer>(`/customers/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}
