import { apiFetch } from "./client";
import type { QuotesPage } from "./types";

// Slice AA Scope G — thin typed wrapper over the now-paginated GET
// /api/quotes (server/src/routes/quotes.ts). Mirrors api/auditEvents.ts's
// listActivity exactly.

export interface ListQuotesInput {
  limit?: number;
  offset?: number;
}

export function listQuotes(input: ListQuotesInput = {}): Promise<QuotesPage> {
  const params = new URLSearchParams();
  if (input.limit !== undefined) params.set("limit", String(input.limit));
  if (input.offset !== undefined) params.set("offset", String(input.offset));
  const qs = params.toString();
  return apiFetch<QuotesPage>(`/quotes${qs ? `?${qs}` : ""}`);
}
