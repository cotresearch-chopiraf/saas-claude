import { apiFetch } from "./client";
import type { Invoice } from "./types";

// Thin typed wrappers over the existing, verified invoice API
// (server/src/routes/invoices.ts) — no calculation, no authorization
// logic. The backend owns subtotal/taxAmount/total and every status
// transition; nothing here ever reproduces those figures.

// MIDAD UI-09: the project-scoped read route (server-side filtered by
// companyId AND projectId) — never the company-wide list filtered here.
export function listProjectInvoices(projectId: string): Promise<Invoice[]> {
  return apiFetch<Invoice[]>(`/projects/${projectId}/invoices`);
}

export interface CreateInvoiceInput {
  projectId?: string;
  contractId?: string;
  clientName: string;
  clientAddress?: string;
  clientTaxId?: string;
  dueDate?: string;
  items: { description: string; amount: number }[];
}

// Existing company-wide creation endpoint — already independently
// validates projectId/contractId against the caller's company (see
// resolveInvoiceProjectContract on the backend). No new creation route.
export function createInvoice(input: CreateInvoiceInput): Promise<Invoice> {
  return apiFetch<Invoice>("/invoices", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// Existing /api/invoices/:id mutation routes — both independently
// re-validate companyId ownership server-side, so they are safe to call
// as-is from a project-scoped screen.
export function sendInvoice(invoiceId: string): Promise<Invoice> {
  return apiFetch<Invoice>(`/invoices/${invoiceId}/send`, { method: "PATCH" });
}

export function markInvoicePaid(invoiceId: string): Promise<Invoice> {
  return apiFetch<Invoice>(`/invoices/${invoiceId}/mark-paid`, { method: "PATCH" });
}
