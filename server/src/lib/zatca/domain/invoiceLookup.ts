// Slice 4 — a READ-ONLY, tenant-scoped invoice lookup for the ZATCA
// integration layer only. Mirrors routes/invoices.ts's own private
// findOwnedInvoice() exactly (same where clause, same ownership contract)
// rather than exporting/modifying that protected route file. Never writes
// to invoices/invoice_items, never recomputes a total — see
// documentBuilder.ts, which is the only place invoice data is turned into
// ZATCA amounts, always via the existing lib/money.ts computeTotals().

import { and, eq } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { invoiceItems, invoices } from "../../../db/schema.js";

export async function findOwnedInvoiceWithItems(companyId: string, invoiceId: string) {
  const invoice = await db.query.invoices.findFirst({
    where: and(eq(invoices.id, invoiceId), eq(invoices.companyId, companyId)),
  });
  if (!invoice) return null;

  const items = await db.query.invoiceItems.findMany({ where: eq(invoiceItems.invoiceId, invoice.id) });
  return { invoice, items };
}
