// MIDAD Phase D1 — the ONLY way a platform operator is created. Not an
// HTTP route (see routes/platformAuth.ts's own comment on why): run
// out-of-band, the same operational-trust level as migrate.ts/seed.ts —
// whoever can run a script against this database already has that level
// of access to it. Reads credentials from the environment rather than
// hardcoding a demo account (unlike seed.ts, this creates a real
// operator, not sample data), and is idempotent against re-runs with the
// same email.
import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "./client.js";
import { platformOperators } from "./schema.js";
import { hashPassword } from "../lib/password.js";

async function main() {
  const email = process.env.PLATFORM_OPERATOR_EMAIL;
  const password = process.env.PLATFORM_OPERATOR_PASSWORD;
  const name = process.env.PLATFORM_OPERATOR_NAME;

  if (!email || !password || !name) {
    console.error(
      "Set PLATFORM_OPERATOR_EMAIL, PLATFORM_OPERATOR_PASSWORD, and PLATFORM_OPERATOR_NAME before running this script.",
    );
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("PLATFORM_OPERATOR_PASSWORD must be at least 8 characters.");
    process.exit(1);
  }

  const existing = await db.query.platformOperators.findFirst({ where: eq(platformOperators.email, email) });
  if (existing) {
    console.log(`A platform operator with email ${email} already exists (id: ${existing.id}). Nothing to do.`);
    process.exit(0);
  }

  const [operator] = await db
    .insert(platformOperators)
    .values({ email, name, passwordHash: await hashPassword(password) })
    .returning({ id: platformOperators.id, email: platformOperators.email });

  console.log(`Platform operator created: ${operator.email} (id: ${operator.id})`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
