import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";
import { logger } from "../lib/logger.js";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Slice Z — an idle pooled client that loses its connection (a transient
// network blip, the DB restarting, a load balancer resetting the
// connection) emits "error" on the Pool itself, not on any in-flight
// query. node-postgres does not handle this for you, and Node's
// EventEmitter throws if an "error" event has no listener — without this
// handler, one transient DB blip on an idle connection crashes the entire
// process for every tenant, not just the one request that happened to be
// using that connection. This only logs; it never swallows a real
// per-query error (those still reject their own promise and are handled
// by each caller's own try/catch / express-async-errors path exactly as
// before) and never calls process.exit itself — the pool recovers on its
// own by discarding the dead client and creating new ones as needed.
pool.on("error", (err) => {
  logger.error("postgres_pool_error", {
    message: err.message,
    name: err.name,
  });
});

export const db = drizzle(pool, { schema });
export { pool };
