import "dotenv/config";
import { db } from "../src/db/client.js";
import { sql } from "drizzle-orm";

// Tests run against a real Postgres (DATABASE_URL, normally the same local
// dev DB — see README for how to point this at a dedicated test database
// instead). Truncating between tests keeps each test's assertions honest
// without needing to hand-track every row it created.
export async function resetDb() {
  await db.execute(sql`
    TRUNCATE TABLE
      companies, users, projects, budget_items, expenses, tasks,
      change_orders, daily_logs, password_reset_tokens, company_invites,
      quotes, quote_items
    RESTART IDENTITY CASCADE
  `);
}
