import { apiFetch } from "./client";
import type { Invoice, InvoicesPage } from "./types";

// Thin typed wrappers over the existing, verified invoice API
// (server/src/routes/invoices.ts) — no calculation, no authorization
// logic. The backend owns subtotal/taxAmount/total and every status
// transition; nothing here ever reproduces those figures.

// MIDAD UI-09: the project-scoped read route (server-side filtered by
// companyId AND projectId) — never the company-wide list filtered here.
export function listProjectInvoices(projectId: string): Promise<Invoice[]> {
  return apiFetch<Invoice[]>(`/projects/${projectId}/invoices`);
}

// Slice AA Scope G — the company-wide list, now paginated. Mirrors
// api/auditEvents.ts's listActivity exactly.
export interface ListInvoicesInput {
  limit?: number;
  offset?: number;
}

export function listInvoices(input: ListInvoicesInput = {}): Promise<InvoicesPage> {
  const params = new URLSearchParams();
  if (input.limit !== undefined) params.set("limit", String(input.limit));
  if (input.offset !== undefined) params.set("offset", String(input.offset));
  const qs = params.toString();
  return apiFetch<InvoicesPage>(`/invoices${qs ? `?${qs}` : ""}`);
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
//
// P0-2 pre-launch hardening — idempotencyKey is optional (matching the
// server's own opt-in design in lib/idempotency.ts) so a caller that
// generates one gets duplicate-request protection on a lost-response/
// automatic-retry scenario; a caller that omits it keeps the previous,
// unchanged behavior. The caller (InvoiceCreateForm) owns the key's
// lifetime — this function only forwards whatever it is given as the
// Idempotency-Key header, exactly as the server already expects.
export function createInvoice(input: CreateInvoiceInput, idempotencyKey?: string): Promise<Invoice> {
  return apiFetch<Invoice>("/invoices", {
    method: "POST",
    body: JSON.stringify(input),
    headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
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
