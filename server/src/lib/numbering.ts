import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { companies } from "../db/schema.js";
import { eq } from "drizzle-orm";

// Atomically claims the next number for a company and formats it as
// PREFIX-YEAR-0001. The UPDATE...RETURNING is a single statement, so two
// concurrent requests can never be handed the same number.
async function claimNextNumber(companyId: string, column: "next_quote_number" | "next_invoice_number") {
  const result = await db.execute<{ claimed: number }>(sql`
    UPDATE companies
    SET ${sql.raw(column)} = ${sql.raw(column)} + 1
    WHERE id = ${companyId}
    RETURNING ${sql.raw(column)} AS claimed
  `);
  return result.rows[0].claimed;
}

function format(prefix: string, n: number) {
  const year = new Date().getFullYear();
  return `${prefix}-${year}-${String(n).padStart(4, "0")}`;
}

export async function nextQuoteNumber(companyId: string): Promise<string> {
  const n = await claimNextNumber(companyId, "next_quote_number");
  return format("DEV", n);
}

export async function nextInvoiceNumber(companyId: string): Promise<string> {
  const n = await claimNextNumber(companyId, "next_invoice_number");
  return format("INV", n);
}

export async function getCompanyOrThrow(companyId: string) {
  const company = await db.query.companies.findFirst({ where: eq(companies.id, companyId) });
  if (!company) throw new Error("Company not found");
  return company;
}
