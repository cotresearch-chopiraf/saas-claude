# MIDAD Concurrency Hardening — Numbering Races

Status: a targeted hardening pass, not a new domain. It closes a real,
verified concurrency gap identified by a repository-wide discovery audit
(the "MIDAD NEXT-PHASE DISCOVERY REPORT," Concurrency Audit section) and
resolves that report's STOP F.

## 1. The original MAX+1 race

Four numbering sequences in this codebase claim their next number via the
same SQL shape:

```sql
INSERT INTO <table> (..., <number_column>, ...)
VALUES (..., (SELECT COALESCE(MAX(<number_column>), 0) + 1 FROM <table> WHERE <scope>), ...)
RETURNING ...
```

Under Postgres's default READ COMMITTED isolation, this single statement
is not race-safe on its own: two concurrent requests can each evaluate the
`MAX(...)` subquery against the same pre-commit state before either one's
`INSERT` commits, and both be handed the same number —

```
Request A: MAX = 7
Request B: MAX = 7
Request A: inserts 8
Request B: inserts 8   <- collision
```

This is not hypothetical. The identical pattern in `routes/ipcs.ts`'s
`ipcNumber` claim produced exactly this collision during Phase 2C's own
concurrency tests (`[1, 1, 1, 2, 3]` instead of `[1, 2, 3, 4, 5]` under 5
concurrent creates) and was fixed there by wrapping the claim in a
transaction that locks the relevant parent row `FOR UPDATE` first.

## 2. Affected domains and numbering scopes

| Domain | File | Number column | Scope | Status before this pass |
|---|---|---|---|---|
| IPC | `routes/ipcs.ts` | `ipc_number` | per contract | Already fixed (Phase 2C) |
| BOQ Revision | `routes/boq.ts` | `revision_number` | per contract | **Vulnerable — now fixed** |
| Budget Revision | `routes/budgetRevisions.ts` | `revision_number` | per project | **Vulnerable — now fixed** |
| Commitment | `routes/commitments.ts` | `commitment_number` | per company | **Vulnerable — now fixed** |

Each scope was determined from the actual existing `WHERE` clause in each
route's numbering subquery, not assumed — BOQ and IPC both scope per
*contract* but are otherwise independent sequences; Budget Revision scopes
per *project*; Commitment scopes per *company*, matching how invoice/quote
numbers are also company-wide sequences (`lib/numbering.ts`).

## 3. The fix: parent-row locking inside a transaction

Each vulnerable route now wraps its numbering claim exactly as
`routes/ipcs.ts` already did:

```
BEGIN TRANSACTION
  SELECT id FROM <parent table> WHERE id = <scope id> FOR UPDATE
  INSERT ... VALUES (..., (SELECT COALESCE(MAX(...), 0) + 1 FROM ... WHERE <scope>), ...)
  RETURNING ...
COMMIT
```

- **BOQ Revision** locks the parent `contracts` row (`WHERE id =
  contractId`) — the contract was already validated to belong to this
  project/company by the handler before the lock is ever taken.
- **Budget Revision** locks the parent `projects` row (`WHERE id =
  projectId`) — the project was already validated to belong to the
  caller's company by this router's own tenant-scoping middleware before
  the handler runs at all.
- **Commitment** locks the parent `companies` row (`WHERE id =
  companyId`) — `companyId` here is always the caller's own authenticated
  company (derived from the session, never an untrusted request field), so
  no additional validation is needed before locking it.

In every case the lock target is an already-authorized, tenant-owned
parent row — the lock is never taken against an untrusted foreign id.

### Why this actually prevents the race

Postgres's `SELECT ... FOR UPDATE` acquires a row-level exclusive lock
that is held until the transaction commits or rolls back. When two
concurrent requests target the *same* scope (the same contract, project,
or company), the second request's `FOR UPDATE` blocks until the first
request's transaction commits. Only then does the second request's
`MAX(...)` subquery execute — and by then it observes the first request's
already-committed row, so it correctly computes one higher. The two
transactions can never simultaneously observe the same "current max"
state for the same scope, which is exactly what made the original race
possible. Two requests targeting *different* scopes never contend for the
same lock at all, so they proceed fully in parallel — the fix serializes
only the numbering-relevant scope, never the whole table or the whole
system.

### Why plain transaction isolation alone was not enough

Wrapping the original single `INSERT ... SELECT MAX` statement in a bare
`db.transaction()` with no explicit lock would not have fixed anything:
under READ COMMITTED (Postgres's default, used throughout this codebase),
each statement inside a transaction still sees the latest *committed*
data at the time *that statement* runs, but two concurrent transactions'
`MAX` subqueries can still both run before either has committed anything,
producing the identical collision. The transaction boundary alone gives
atomicity (all-or-nothing) but not serialization between concurrent
transactions touching the same scope — only an explicit lock (`FOR
UPDATE`) forces the second transaction to wait for the first to finish
before evaluating its own `MAX`.

## 4. Concurrency tests

Each domain now has a dedicated 5-way concurrent-creation test (real
Postgres, `Promise.all`, no mocks) asserting:

- all 5 creations succeed (HTTP 201)
- `count(numbers) == count(unique(numbers))` — no duplicate
- the numbers are contiguous from the pre-existing `MAX + 1` (not
  hardcoded `1..5`, since a shared test file's earlier tests may have
  already claimed numbers in that scope)

Plus one cross-scope test per domain, proving the lock does not
over-serialize: two *different* contracts (BOQ), two *different* projects
(Budget Revision), or two *different* companies (Commitment) each claim
their own correct, independent sequence when creating concurrently —
proving the fix locks the numbering-relevant scope only, not the whole
table.

Locations: `tests/midadFoundation.test.ts` ("MIDAD Phase 1 — BOQ
revisions" and "MIDAD Phase 1 — Budget revisions" describe blocks) and
`tests/procurement.test.ts` ("Commitment: creation, reads, tenant
isolation, numbering" describe block). The existing IPC concurrency test
in `tests/ipc.test.ts` was re-run and still passes unchanged —
`routes/ipcs.ts` itself was not modified.

## 5. What this pass does not do

No schema migration was created or needed — the fix is purely a locking
strategy inside existing route handlers. No unique constraint was added
on `(contract_id, revision_number)`, `(project_id, revision_number)`, or
`(company_id, commitment_number)` — this was deliberately kept out of
scope, as a separate, optional defense-in-depth item (a DB-level
constraint would additionally catch a hypothetical future logic bug that
bypasses this locking, turning it into a retryable error instead of a
silent duplicate — but the locking fix alone is sufficient to make the
race itself impossible, so no such constraint currently exists in this
schema).
