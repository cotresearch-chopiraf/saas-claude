# MIDAD Measurement Model (Phase 2B)

Status: established alongside the Phase 2B implementation, on top of the
canonical financial model (`docs/MIDAD_FINANCIAL_MODEL.md`) and the Phase
2A Commitment foundation. Measurement is a new domain — it does not modify
that document's model, it extends it with a fifth, distinct concept:
**Progress**.

## What Measurement is, and what it explicitly is not

A Measurement is **evidence of physical progress against a specific
published BOQ revision's quantities**. It is quantity-based, not
financial. It does **not** compute, store, or expose:

- A certified payment value (that is IPC — a later, not-yet-built phase).
- Retention or advance-recovery figures.
- Any change to Contract value, BOQ value, Cost Plan, or Commitment
  amounts — none of those tables are read or written by anything in
  `routes/measurements.ts`.

The one monetary-looking field on a measurement line, `value`
(`measuredQuantity × the BOQ item's own rate`, computed once at write
time via `lib/money.ts`, the same discipline as `boqItems.amount`), is
provided only as a convenience figure for a future IPC layer to build on —
it is explicitly not a valuation, certification, or payment number, and
nothing in this phase treats it as one.

## Current-period vs. cumulative quantity

Each `measurement_lines` row's `measuredQuantity` represents the quantity
measured **in this specific measurement's period** — never a running
total typed in by a user.

Cumulative approved quantity is always **derived**, never stored:

```
cumulativeApprovedQuantity(boqItemId) =
  SUM(measurement_lines.measuredQuantity)
  across every line belonging to a measurement whose status = 'approved'
  for that boqItemId
```

This was a deliberate choice over storing a running cumulative column: a
stored cumulative number is a second copy of a value that must never
disagree with its own inputs — exactly the class of problem Phase 2A's
Commitment `revisedAmount` was built to avoid by deriving from
`commitment_lines` rather than being independently editable. The same
reasoning applies here, and there is no performance or historical reason
in this phase's scope that would justify the drift risk of storing it
instead.

**Overrun is rejected, not allowed.** At approval time, for every BOQ item
referenced by the measurement being approved, the engine checks
`cumulativeApprovedQuantity (excluding this measurement, which isn't
approved yet) + this measurement's quantity for that item <= boqItem.quantity`.
If it would exceed the BOQ item's own quantity, the approval is rejected
(409) — no measurement can push a BOQ item's approved progress past what
was actually priced for it. This check is race-safe: see Concurrency below.

## Published BOQ revision dependency

A measurement is created against one specific `(contractId,
boqRevisionId)` pair, and that revision must have `status = 'published'`
at creation time (never `draft`, never `superseded`). Once set, a
measurement's `boqRevisionId` is never updated by any route — if a newer
revision is later published (superseding the one this measurement
references), the measurement keeps its original reference, so its
history stays correct even though new measurements must now target the
new revision instead. A measurement line's `boqItemId` must belong to
that *exact* revision (stricter than Commitment lines, which only require
"same project") — a BOQ item's quantity is only meaningful within its own
revision.

## State machine

```
draft --submit--> submitted --approve--> approved   (terminal, immutable)
                       |
                       +---reject---> rejected
```

`rejected` is not a dead end and not silently reset to `draft` — it is
its own visible status (with `rejectedBy`/`rejectedAt`/`rejectionReason`
recorded and audited) that is **functionally re-editable exactly like
draft**: lines may be added/removed, and the same `submit` action moves
it back to `submitted` (clearing the rejection fields on success). No
separate "return to draft" endpoint was added — the approved API surface
lists only create/items/submit/approve/reject, and re-submitting a
rejected measurement already achieves the same outcome without a fourth
transition endpoint.

Lines are mutable only while a measurement is `draft` or `rejected`.
`approved` is genuinely terminal and immutable: no route can add, remove,
or otherwise change an approved measurement's lines or fields.

## Ownership / tenant rules

Every nested reference is independently re-validated against the caller's
company/project, never inferred from a parent's ownership: `contractId`
(must belong to this project), `boqRevisionId` (must be a published
revision of that exact contract), `boqItemId` (must belong to that exact
revision). `companyId` is carried directly on both `measurements` and
`measurement_lines` (not only reachable via a join), matching the Phase
2A tenant-isolation requirement.

## RBAC

Creating a measurement, adding/removing its lines, and submitting it are
**member-accessible** — this matches `tasks.ts` / `dailyLogs.ts`'s
existing, unguarded site-entry precedent (physical progress recording is
operational site work, not a financial commitment). Approving or
rejecting requires **owner** (`measurement.approve`) — the trust boundary
where someone signs off that this progress is real, the same posture as
`changeOrder.approve`. No new role was introduced.

## Relationship to future IPC

IPC (IPC = Interim Payment Certificate) will read **approved**
measurements as its source of executed/certified quantities, and will be
where retention, advance recovery, and actual payment valuation are
introduced. Measurement deliberately stops short of any of that — it
only establishes trustworthy, race-safe, audited, non-overrunning
quantity evidence for IPC to later consume.
