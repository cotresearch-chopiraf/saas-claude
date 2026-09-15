import { createHash, randomUUID } from "crypto";
import { eq, and, or, isNull, lt } from "drizzle-orm";
import { db } from "../db/client.js";
import { idempotencyKeys } from "../db/schema.js";
import { logger } from "./logger.js";

// Slice AA Scope E — generic idempotency-key mechanism for the two mutations
// where a duplicate request creates a duplicate financial document: invoice
// and quote creation. A client that wants safe retries sends an
// "Idempotency-Key" header; a client that doesn't send one gets the
// unchanged, non-idempotent behavior (this is opt-in, matching every other
// idempotency-key API — Stripe included — rather than a breaking change to
// every existing caller).
//
// 18-phase internal remediation, Phase 8 follow-up — READ THIS BEFORE
// TOUCHING THE RECLAIM LOGIC BELOW. An earlier version of this fix reclaimed
// any claim whose `createdAt` was more than 30s old, treating "created long
// ago" as proof the leader was dead. It was not: a leader that is merely
// slow (DB lock contention, connection-pool queueing, a GC pause) — the
// exact conditions under which a client is also most likely to retry — is
// indistinguishable from a crashed one by timestamp age alone. A retry could
// steal a live leader's claim, run the same handler() a second time (a
// second invoice/commitment/etc. actually gets inserted), while the
// original leader's own completion UPDATE silently matched zero rows and it
// reported false success to ITS OWN caller too. Confirmed via code reading,
// not hypothetical — see the design below, which replaces the timestamp
// heuristic with a real lease + fencing token:
//
// - ownerToken: a random value naming whoever currently holds the claim.
// - leaseExpiresAt: set at claim time to now()+LEASE_DURATION_MS, and
//   RENEWED by the holder's own heartbeat (a lightweight setInterval tick)
//   for as long as its handler() is actually running. A live holder — no
//   matter how slow its handler is, as long as its event loop is not fully
//   blocked and it can still reach the database — keeps its lease from ever
//   expiring, so it is never reclaimable.
// - Reclaim is an ATOMIC conditional UPDATE ("steal") gated on
//   leaseExpiresAt having actually passed, not on createdAt age. Only a
//   truly abandoned claim (process crashed, or genuinely unable to reach
//   the database for the full lease duration — at which point its own
//   handler() is very likely also failing for the same reason) can ever
//   satisfy this condition.
// - The completion write is itself conditioned on the caller still holding
//   ownerToken (the fencing-token check). If a claim was somehow reclaimed
//   while the original holder's handler() was still finishing, that
//   holder's completion UPDATE matches zero rows, and it throws instead of
//   reporting success to its own caller — it can never claim a false
//   success once it has lost ownership.
//
// This does not achieve textbook-perfect mutual exclusion — no lease-based
// scheme without a synchronous system can (a fundamental distributed-
// systems limit, not an implementation gap): a process that is fully
// frozen (not merely slow) for the entire lease duration and then resumes
// and commits its handler() transaction an instant after being reclaimed is
// a residual, physically narrow case no timeout-based liveness check can
// rule out. What this design does guarantee, and what the flat-timestamp
// version did not: a live process whose event loop is still running (i.e.
// can still execute a setInterval callback and reach the database) can
// never lose its claim, and a process that DOES lose its claim can never
// report a false success — closing the realistic "leader is just slow"
// race the flat-timestamp version left open.

export type IdempotencyOperation = (typeof idempotencyKeys.operation.enumValues)[number];

export class IdempotencyConflictError extends Error {
  constructor() {
    super("Idempotency-Key was already used with a different request body");
    this.name = "IdempotencyConflictError";
  }
}

// Thrown only in the residual case described above: the caller's own
// handler() finished, but by then something else had already taken over
// this claim's ownership. The caller must never report success to its own
// HTTP request when this happens — see runAsLeader() below.
export class IdempotencyLeaseLostError extends Error {
  constructor() {
    super("idempotency claim lost ownership before completion — a concurrent process reclaimed this operation");
    this.name = "IdempotencyLeaseLostError";
  }
}

// Deterministic regardless of key insertion order or array/object nesting —
// two logically-identical bodies always fingerprint the same, and two
// materially different ones (an extra/changed field at any depth) never
// collide.
function fingerprintBody(value: unknown): string {
  const canonical = stableStringify(value);
  return createHash("sha256").update(canonical).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

interface HandlerResult<T> {
  status: number;
  body: T;
}

interface IdempotentOutcome<T> {
  replayed: boolean;
  status: number;
  body: T;
}

const CLAIM_ATTEMPTS = 3;
const POLL_ATTEMPTS = 40;
const POLL_INTERVAL_MS = 25;

// Every operation this module guards (invoice/commitment/expense/quote
// creation, payroll period, IPC, subcontract IPC, change order) is a pure
// local-DB transaction that normally completes in single-digit-to-low-
// hundreds of milliseconds — LEASE_DURATION_MS is generous relative to
// that, and HEARTBEAT_INTERVAL_MS gives 3+ renewal attempts within a
// single lease period, so one transient renewal failure never costs the
// lease. Scaled down (same ratio) in the test environment — see
// AUTH_RATE_LIMIT_MAX in middleware/rateLimit.ts for the identical,
// already-established convention — purely so tests can exercise real
// concurrent timing (a genuinely live, heartbeat-renewing leader racing a
// genuine reclaim attempt) in well under a second instead of >10s per test.
const LEASE_DURATION_MS = process.env.NODE_ENV === "test" ? 300 : 10_000;
const HEARTBEAT_INTERVAL_MS = process.env.NODE_ENV === "test" ? 80 : 3_000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Runs `handler` while this process holds the lease identified by
// `ownerToken` on the row `record`, renewing that lease on a timer so a
// live-but-slow execution never loses it, and only ever reports success to
// its own caller if it still demonstrably owns the claim at completion
// time (the fencing-token check).
async function runAsLeader<T>(
  record: { id: string },
  ownerToken: string,
  handler: () => Promise<HandlerResult<T>>,
): Promise<IdempotentOutcome<T>> {
  const heartbeat = setInterval(() => {
    db.update(idempotencyKeys)
      .set({ leaseExpiresAt: new Date(Date.now() + LEASE_DURATION_MS) })
      .where(and(eq(idempotencyKeys.id, record.id), eq(idempotencyKeys.ownerToken, ownerToken), eq(idempotencyKeys.status, "pending")))
      .catch((err) => {
        // A single missed renewal is not fatal — there are several more
        // heartbeat ticks before the lease actually expires (see the
        // constants' own comment). Logged, not thrown: this timer must
        // never crash the request it's renewing a lease for.
        logger.error("idempotency_heartbeat_failed", { claimId: record.id, error: err instanceof Error ? err.message : String(err) });
      });
  }, HEARTBEAT_INTERVAL_MS);

  try {
    const result = await handler();
    // Fencing-token check: only mark completed — and only ever return a
    // success to our own caller — if we still demonstrably hold this
    // claim. If ownerToken no longer matches (or the row is gone), someone
    // else already reclaimed it; we must not tell our caller they
    // succeeded when the canonical outcome now belongs to that reclaimer.
    const [completedRow] = await db
      .update(idempotencyKeys)
      .set({ status: "completed", responseStatus: result.status, responseBody: result.body as object })
      .where(and(eq(idempotencyKeys.id, record.id), eq(idempotencyKeys.ownerToken, ownerToken)))
      .returning();
    if (!completedRow) {
      throw new IdempotencyLeaseLostError();
    }
    return { replayed: false, status: result.status, body: result.body };
  } catch (err) {
    // Release the claim so a subsequent retry gets a clean shot — but only
    // if we still own it. If ownership already moved on (the
    // IdempotencyLeaseLostError case, or a lease genuinely expired mid-
    // handler), this conditional delete matches zero rows and correctly
    // leaves the new owner's claim untouched.
    await db.delete(idempotencyKeys).where(and(eq(idempotencyKeys.id, record.id), eq(idempotencyKeys.ownerToken, ownerToken)));
    throw err;
  } finally {
    clearInterval(heartbeat);
  }
}

// Runs `handler` under an idempotency guard scoped to (companyId, operation,
// key). Exactly one concurrent caller for a given key actually executes
// `handler` (the "leader"); every other caller — concurrent or a later
// retry — either replays the leader's stored response (same requestBody) or
// gets IdempotencyConflictError (different requestBody). Never applies
// across tenants: the underlying unique constraint includes companyId, so
// the same key string reused by a different company is a fresh, unrelated
// claim.
export async function withIdempotency<T>(
  companyId: string,
  operation: IdempotencyOperation,
  key: string,
  requestBody: unknown,
  handler: () => Promise<HandlerResult<T>>,
): Promise<IdempotentOutcome<T>> {
  const requestFingerprint = fingerprintBody(requestBody);

  for (let claimAttempt = 0; claimAttempt < CLAIM_ATTEMPTS; claimAttempt++) {
    const ownerToken = randomUUID();
    const leaseExpiresAt = new Date(Date.now() + LEASE_DURATION_MS);
    const claimed = await db
      .insert(idempotencyKeys)
      .values({ companyId, operation, key, requestFingerprint, status: "pending", ownerToken, leaseExpiresAt })
      .onConflictDoNothing({
        target: [idempotencyKeys.companyId, idempotencyKeys.operation, idempotencyKeys.key],
      })
      .returning();

    if (claimed.length > 0) {
      return await runAsLeader(claimed[0], ownerToken, handler);
    }

    // Someone else already holds this key — poll briefly for their result
    // rather than racing a second write. Bounded and short (at most ~1s
    // per claim attempt) so this never hangs a request; concurrent-retry
    // tests fire requests together and a normal leader finishes well
    // within this window.
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
      const existing = await db.query.idempotencyKeys.findFirst({
        where: and(
          eq(idempotencyKeys.companyId, companyId),
          eq(idempotencyKeys.operation, operation),
          eq(idempotencyKeys.key, key),
        ),
      });
      if (existing?.status === "completed") {
        if (existing.requestFingerprint !== requestFingerprint) {
          throw new IdempotencyConflictError();
        }
        return { replayed: true, status: existing.responseStatus!, body: existing.responseBody as T };
      }
      if (!existing) break; // the leader released its claim — retry claiming it ourselves

      // Lease-based reclaim: only a claim whose lease has ACTUALLY expired
      // is eligible — never merely "created a while ago" (see this file's
      // own header comment for exactly why that distinction matters). A
      // live leader's heartbeat keeps renewing leaseExpiresAt, so this
      // condition can only be true for a genuinely abandoned claim.
      // Atomic steal: the WHERE clause re-checks the expiry at UPDATE time
      // (not from the `existing` row read moments earlier), so of several
      // concurrent reclaimers racing the same dead claim, only one ever
      // wins — .returning() empty means we lost that race, not an error.
      if (existing.status === "pending" && (existing.leaseExpiresAt === null || existing.leaseExpiresAt.getTime() <= Date.now())) {
        const newOwnerToken = randomUUID();
        const newLeaseExpiresAt = new Date(Date.now() + LEASE_DURATION_MS);
        const stolen = await db
          .update(idempotencyKeys)
          .set({ ownerToken: newOwnerToken, leaseExpiresAt: newLeaseExpiresAt, requestFingerprint })
          .where(
            and(
              eq(idempotencyKeys.id, existing.id),
              eq(idempotencyKeys.status, "pending"),
              or(isNull(idempotencyKeys.leaseExpiresAt), lt(idempotencyKeys.leaseExpiresAt, new Date())),
            ),
          )
          .returning();
        if (stolen.length > 0) {
          return await runAsLeader(stolen[0], newOwnerToken, handler);
        }
        // Lost the race to steal it (another reclaimer won, or the
        // original leader's own heartbeat renewed it a moment before this
        // UPDATE ran) — loop back and observe the now-current state.
        continue;
      }

      await sleep(POLL_INTERVAL_MS);
    }
    // Still pending (lease not yet expired) after the poll window, or the
    // claim vanished mid-poll — loop back and try to claim it ourselves
    // (bounded by CLAIM_ATTEMPTS).
  }

  throw new Error("idempotency key contention could not be resolved");
}
