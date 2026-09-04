import { createHash } from "crypto";
import { eq, and } from "drizzle-orm";
import { db } from "../db/client.js";
import { idempotencyKeys } from "../db/schema.js";

// Slice AA Scope E — generic idempotency-key mechanism for the two mutations
// where a duplicate request creates a duplicate financial document: invoice
// and quote creation. A client that wants safe retries sends an
// "Idempotency-Key" header; a client that doesn't send one gets the
// unchanged, non-idempotent behavior (this is opt-in, matching every other
// idempotency-key API — Stripe included — rather than a breaking change to
// every existing caller).

export type IdempotencyOperation = (typeof idempotencyKeys.operation.enumValues)[number];

export class IdempotencyConflictError extends Error {
  constructor() {
    super("Idempotency-Key was already used with a different request body");
    this.name = "IdempotencyConflictError";
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    const claimed = await db
      .insert(idempotencyKeys)
      .values({ companyId, operation, key, requestFingerprint, status: "pending" })
      .onConflictDoNothing({
        target: [idempotencyKeys.companyId, idempotencyKeys.operation, idempotencyKeys.key],
      })
      .returning();

    if (claimed.length > 0) {
      const record = claimed[0];
      try {
        const result = await handler();
        await db
          .update(idempotencyKeys)
          .set({ status: "completed", responseStatus: result.status, responseBody: result.body as object })
          .where(eq(idempotencyKeys.id, record.id));
        return { replayed: false, status: result.status, body: result.body };
      } catch (err) {
        // The leader failed before producing a result — release the claim
        // so a subsequent retry with the same key gets a clean shot instead
        // of being stuck behind a dead "pending" row forever.
        await db.delete(idempotencyKeys).where(eq(idempotencyKeys.id, record.id));
        throw err;
      }
    }

    // Someone else already holds this key — poll briefly for their result
    // rather than racing a second write. Bounded and short (at most ~1s)
    // so this never hangs a request; concurrent-retry tests fire requests
    // together and the leader finishes well within this window.
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
      await sleep(POLL_INTERVAL_MS);
    }
    // Still pending after the poll window, or the claim vanished mid-poll —
    // loop back and try to claim it ourselves (bounded by CLAIM_ATTEMPTS).
  }

  throw new Error("idempotency key contention could not be resolved");
}
