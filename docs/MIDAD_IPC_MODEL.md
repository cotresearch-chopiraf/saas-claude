# MIDAD IPC Model (Phase 2C)

Status: established alongside the Phase 2C implementation, on top of the
canonical financial model (`docs/MIDAD_FINANCIAL_MODEL.md`) and the Phase
2B Measurement foundation (`docs/MIDAD_MEASUREMENT_MODEL.md`). IPC (Interim
Payment Certificate) is a new domain — it does not modify either of those
documents' models, it extends them with a sixth, distinct concept:
**Certification**.

## What IPC is, and what it explicitly is not

An IPC is the record that a specific quantity of **already-approved
physical progress** has been formally certified for payment, for a given
contract, over a given period. It is the bridge between "progress has
happened" (Measurement) and "money should move" (a future Invoice /
Cash-Flow layer) — but it does not do either of those other jobs itself:

- It is **not** Measurement. Measurement proves quantity happened; IPC
  proves that some subset of already-approved quantity is now being
  claimed for payment. An IPC line's `currentQuantity` can never exceed
  what Measurement has already approved for that BOQ item, net of what
  earlier certified IPCs have already claimed.
- It is **not** an Invoice. Certifying an IPC does **not** create an
  invoice, mutate `invoices`/`invoice_items`, or apply the invoice tax
  engine. If a future phase wires certified IPCs into invoicing, that is
  new, explicitly out-of-scope work — no such system exists yet.
- It is **not** Cash Flow. It records what has been certified, not when
  or whether it is actually paid. No bank reconciliation, payment
  ledger, or cash-timing concept exists in this phase.
- It does **not** rewrite any other financial source of truth. Certifying
  an IPC never modifies `contracts.revisedValue`, published `boqItems`
  rows, `budgetItems.plannedAmount`, `commitments`/`commitment_lines`,
  `expenses`, or `projects.budgetTotal` — `routes/ipcs.ts` only ever reads
  those tables, never writes them.

## Quantity semantics: current, cumulative, previously-certified

Each `ipc_lines` row's `currentQuantity` is the quantity being claimed **in
this specific IPC** — never a running total typed in by a user. At
`certify()` time, three additional figures are computed once and frozen
onto the line, never recomputed afterward:

- `previousCertifiedQuantity` — how much of this BOQ item's quantity had
  already been certified (by any earlier-certified IPC) before this one.
- `cumulativeQuantity` — `previousCertifiedQuantity + currentQuantity`,
  i.e. the running total certified as of this IPC.
- `previousCertifiedValue` — `previousCertifiedQuantity × rate`, the money
  equivalent of the above, for the same reason `currentValue` is frozen
  rather than left to be recomputed against a rate that could change
  later.

Before `certify()`, these three columns are `NULL` — they only mean
anything once a certification has actually happened, so a draft/submitted/
approved (not-yet-certified) IPC never displays a fabricated cumulative
number.

## The certification invariant: no double certification

This is the single most important guarantee in this domain:

```
certifiableRemaining(boqItemId) =
  cumulativeApprovedQuantity(boqItemId)      -- from Measurement, Phase 2B
  - alreadyCertifiedQuantity(boqItemId)      -- SUM(ipc_lines.currentQuantity)
                                                 across every line belonging
                                                 to an IPC whose status = 'certified'
```

An IPC line can never claim more than `certifiableRemaining` for its BOQ
item. This is enforced twice:

- **Fast-path, at line-add time** — a plain read-and-compare, purely so a
  user gets an immediate 400 instead of waiting for certify() to reject
  the whole IPC. This is a UX convenience only, never the guarantee.
- **Authoritatively, inside the `certify()` transaction** — see
  Concurrency below. This is the only check that actually matters for
  correctness.

`approve()` deliberately does **not** perform this check. Approval is a
pure editorial review gate (did a human sign off that this claimed
quantity/period/lines look right); the shared, contended resource — "how
much of this BOQ item's certified budget is left" — is only ever claimed
at the moment an IPC actually becomes `certified`, mirroring exactly why
Measurement's own overrun check lives at *its* approval step rather than
at submission.

## Valuation

`ipc_lines.rate` is frozen from `boqItem.rate` the moment a line is added
(never re-read later, even if the BOQ item's rate is somehow changed
afterward — though in practice BOQ items on a published revision are
themselves immutable). `currentValue = roundMoney(currentQuantity × rate)`,
computed once at line-add time via `lib/money.ts`, the same discipline as
`boqItems.amount` and `commitmentLines.amount`.

At `certify()`, the IPC's header monetary fields are computed once, from
the frozen line values, and never independently editable:

```
grossValue             = sumMoney(lines.currentValue)
retentionAmount         = roundMoney(grossValue × contract.retentionPercent / 100)
advanceRecoveryAmount   = 0                              -- see below
otherDeductions         = 0                              -- see below
netCertified            = roundMoney(grossValue - retentionAmount
                                      - advanceRecoveryAmount - otherDeductions)
```

`netCertified` is asserted `>= 0` before the transition is allowed to
commit; no business rule in this phase produces or permits a negative
certified amount.

### Retention

`contract.retentionPercent` is read **live, at certification time**, and
the resulting `retentionAmount` is then frozen onto the IPC row. This
means: if a contract's retention rule is edited *after* an IPC has already
been certified, that historical IPC's `retentionAmount` does not silently
change — only IPCs certified *after* the edit pick up the new rate. This
is the same "read live, freeze at the moment of finality" discipline as
`boqItems.amount` freezing at publish and Measurement's `value` freezing
at line-add.

### Advance recovery (deliberately not implemented)

`contracts.advancePercent` (if set) is left completely untouched by this
phase. `advanceRecoveryAmount` is hard-coded to `0` on every certified
IPC. No automatic advance-recovery schedule, percentage-per-IPC
deduction, or running-advance-balance concept was invented, because no
such business rule exists anywhere in the current architecture to derive
one from safely. This is a reserved-but-unwired column — the same pattern
already used for `commitments.status`'s `partially_fulfilled`/`closed`
values in Phase 2A — not a placeholder for logic that silently runs. A
future phase that wants real advance recovery needs new, explicit
business rules and a new architectural decision; this phase does not
pretend one already exists.

### Other deductions (deliberately not implemented)

Same reasoning: `otherDeductions` is hard-coded to `0`. No generic
JSON/line-item deduction engine was added — there is nowhere in this
schema a deduction could legitimately originate from yet.

## State machine

```
draft --submit--> submitted --approve--> approved --certify--> certified  (terminal, immutable)
          ^              |
          |              +---reject---> rejected
          +--------------------submit (from rejected)-----------+
```

Lines (`ipc_lines`) are mutable only while an IPC is `draft` or
`rejected` — exactly the same "rejected behaves like draft" shape as
Measurement's own state machine, for the same reason: no separate
"return to draft" endpoint exists, re-submitting a rejected IPC already
achieves the same outcome.

`certified` is genuinely terminal: no route allows `certified → draft`,
`certified → rejected`, `certified → approved`, or any other transition
out of it, and no generic `PATCH /ipcs/:id/status` endpoint exists at all
— every transition is its own named action (`submit`/`approve`/`reject`/
`certify`), each independently RBAC- and state-gated.

## Concurrency

Two distinct races are protected against, both using the codebase's
established `SELECT ... FOR UPDATE`-inside-a-transaction discipline:

1. **Simple state transitions** (`submit`, `approve`, `reject`, and the
   final commit of `certify`) use an atomic conditional `UPDATE ... WHERE
   id = X AND status = 'expected-prior-status'` — exactly one concurrent
   caller can ever succeed; every earlier plain-SELECT status check in the
   same handler is a fast-path only, not the guarantee.

2. **The certification invariant itself** — the "no double certification"
   guarantee above — is the one genuinely contended shared resource in
   this domain, because two *different* IPCs can reference the *same* BOQ
   item and attempt to certify concurrently. Inside the `certify()`
   transaction: the IPC row itself is locked `FOR UPDATE` first; then
   every **distinct** `boqItemId` referenced by its lines is locked `FOR
   UPDATE`, in **sorted order** (deadlock-safe against a second,
   concurrent `certify()` touching an overlapping-but-differently-ordered
   set of BOQ items — the same pattern Measurement's `approve()` uses for
   its own overrun check). Only after those locks are held does the
   handler recompute `certifiableRemaining` fresh from the database and
   compare; if any line would exceed it, the whole transaction aborts
   (409) and nothing is written. This makes the BOQ-item-quantity=100,
   IPC-A-certifies-60, IPC-B-certifies-60 scenario impossible: whichever
   transaction acquires the lock second sees the first transaction's
   already-committed certified quantity before deciding, and is rejected
   if it would overrun.

`ipcNumber` (per-contract, atomic `INSERT ... SELECT COALESCE(MAX,0)+1`)
is claimed inside a transaction that first locks the parent `contracts`
row `FOR UPDATE` — the same contract-row-lock discipline Phase 1.1
introduced to prevent concurrent boq-revision-publish races — so two
concurrent IPC creations on the same contract can never be handed the
same number.

## Immutability

Once an IPC reaches `certified`, none of its fields, nor any of its
lines' fields, can change through any route. This includes the frozen
`previousCertifiedQuantity`/`previousCertifiedValue`/`cumulativeQuantity`
snapshot on each line and the header's `grossValue`/`retentionAmount`/
`advanceRecoveryAmount`/`otherDeductions`/`netCertified` — a later change
to `contract.retentionPercent` or `contract.advancePercent` never
retroactively alters an already-certified IPC's historical figures.

## Ownership / tenant rules

Every nested reference is independently re-validated against the caller's
company/project, never inferred from a parent's ownership: `contractId`
(must belong to this project), `boqRevisionId` (must be a **published**
revision of that exact contract), `boqItemId` (must belong to that exact
revision, must be a priced `item` row with a non-null `rate`). `companyId`
is carried directly on both `ipcs` and `ipc_lines` (not only reachable via
a join), matching the Phase 2A/2B tenant-isolation requirement.

## RBAC

Unlike Measurement, an IPC line itself defines a monetary figure
(`currentValue = currentQuantity × rate`) the instant it is added — it is
not pure quantity evidence, it is the certification instrument itself.
That places the whole domain with Contract/BOQ/CostCode/BudgetRevision/
Commitment (fully owner-gated end-to-end via a single `<domain>.manage`
permission), not with Measurement/tasks/dailyLogs (member-open site
entry). Every IPC mutation — create, add/remove line, submit, approve,
reject, certify — requires `ipc.manage` (owner). Read access is
unrestricted, same as every other domain. No new role was introduced.

## Audit trail

Every mutation records a canonical `audit_events` row via the existing
`recordAuditEvent` helper — no second audit mechanism exists in this
domain: `ipc.created`, `ipc.lineAdded`, `ipc.lineRemoved`,
`ipc.submitted`, `ipc.approved`, `ipc.rejected`, `ipc.certified`. The
`ipc.certified` event's `afterValue`/`metadata` captures the full
certification outcome — gross value, retention amount, advance recovery
amount, other deductions, net certified, contract id, BOQ revision id,
line count, and the set of BOQ item ids involved — sufficient to fully
reconstruct what was certified and why without re-deriving it from
`ipc_lines`.

## Relationship to future Forecast / Cash Flow

A future Forecast phase would read certified IPCs (alongside Commitments
and Expenses) as one input among several to project remaining spend; a
future Cash Flow phase would read certified IPCs' `netCertified` amounts
as the basis for payment timing. Neither of those systems exists yet —
this phase does not claim they do, and nothing in `routes/ipcs.ts` reads
or writes anything belonging to them.
