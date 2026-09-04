import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema.js";
import { logger } from "../lib/logger.js";

// AC-06 — conservative, explicit pool bounds for the deployment this
// repository actually has: one `node dist/index.js` process per container
// (see Dockerfile — no clustering/PM2, no replica orchestration), so these
// are per-instance limits, not shared across a fleet. Values chosen from
// pg's own defaults (max/idleTimeoutMillis) plus two bounds pg leaves
// unset by default, which is the real risk this closes:
//   - max: 10 — matches node-postgres's own default; a small CRUD API
//     with no evidence of a heavier concurrent-connection workload has no
//     basis for a larger pool, and Postgres itself has a finite
//     max_connections shared across every client that talks to it.
//   - idleTimeoutMillis: 30000 — how long an idle client sits in the pool
//     before being closed. Slightly more generous than pg's 10s default
//     to avoid reconnect churn under bursty-but-not-constant traffic.
//   - connectionTimeoutMillis: 5000 — pg defaults this to 0 (wait
//     forever) for both "acquire a pooled client" and "establish a new TCP
//     connection." An unreachable database or an exhausted pool would
//     otherwise hang a request indefinitely instead of failing fast with a
//     clear error.
//   - statement_timeout: 30000 (ms, a Postgres session parameter sent at
//     connect time) — bounds how long the database itself will run any
//     single statement before killing it server-side, so one runaway or
//     stuck query can never hold a pooled connection forever. Generous for
//     this codebase's CRUD/report queries, none of which are long-running
//     analytics.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statement_timeout: 30_000,
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
