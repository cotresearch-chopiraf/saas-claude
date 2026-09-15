import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../src/db/client.js";

// 18-phase internal remediation, Phase 13 — quote_items.quote_id and
// invoice_items.invoice_id were the only two line-item child tables in
// this schema with no index on their parent-FK column (every sibling —
// boq_items, commitment_lines, measurement_lines, ipc_lines,
// subcontract_ipc_lines — already had this from an earlier pass), despite
// routes/quotes.ts and routes/invoices.ts both reading "every item for
// this quote/invoice" by that FK alone on every detail/PDF/status read.
// This proves the migration actually created both indexes, not just that
// the schema.ts declaration exists.
describe("Phase 13 — missing FK indexes added on quote_items/invoice_items", () => {
  async function indexExists(tableName: string, indexName: string): Promise<boolean> {
    const result = await db.execute(
      sql`SELECT 1 FROM pg_indexes WHERE tablename = ${tableName} AND indexname = ${indexName}`,
    );
    return result.rows.length > 0;
  }

  it("quote_items_quote_idx exists on quote_items(quote_id)", async () => {
    expect(await indexExists("quote_items", "quote_items_quote_idx")).toBe(true);
  });

  it("invoice_items_invoice_idx exists on invoice_items(invoice_id)", async () => {
    expect(await indexExists("invoice_items", "invoice_items_invoice_idx")).toBe(true);
  });
});
