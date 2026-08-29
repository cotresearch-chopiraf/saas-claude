# MIDAD Forecast Model (Phase 2D)

Status: established alongside the Phase 2D implementation, on top of the
canonical financial model (`docs/MIDAD_FINANCIAL_MODEL.md`) and everything
built on it through Phase 2C (`docs/MIDAD_MEASUREMENT_MODEL.md`,
`docs/MIDAD_IPC_MODEL.md`). Forecast is a new layer — it does not modify
any of those models, it *reads* four of their concepts and computes a
sixth, derived one: **ETC / EAC (Estimate to Complete / Estimate at
Completion)**.

## 1. Purpose

Forecast answers three questions, and only these three:

1. Given the Cost Plan, current Commitments, Actual Costs, and certified
   Progress, what is the expected final cost (**EAC**)?
2. How much remains to be spent (**ETC**)?
3. Is the project trending above or below plan (**variance**)?

It is **not** a new budget, a new commitment ledger, an accounting ledger,
a payment ledger, an invoice engine, an IPC replacement, or an editable
financial document. Nothing in `routes/forecast.ts` writes to any table
except `forecast_snapshots` itself.

## 2. Canonical Cost Plan (BAC)

```
BAC = Σ budgetItems.plannedAmount, for the project (current, full plan)
```

This is the same Cost Plan `docs/MIDAD_FINANCIAL_MODEL.md` already
established as canonical. It is **not** cutoff-filtered by `asOfDate`: a
plan baseline is not a dated transaction the way an expense or a
certification is — Budget-At-Completion is, by definition in this model,
the current total plan, not "the plan as it stood on some earlier date."

## 3. Actual Cost (AC)

```
AC = Σ expenses.amount, WHERE projectId = X AND expenseDate <= asOfDate
```

Exact and fully trustworthy: `expenses.expenseDate` is a real date column,
and expenses in this codebase are create-or-delete only (no PATCH route
exists), so an included expense's amount is never silently edited after
the fact.

## 4. Commitment semantics

Only commitments whose **current** status is `active`, `partially_fulfilled`,
or `closed` count as committed cost — never `draft` (not yet a real
obligation) and never `cancelled` (never became one). Per the Phase 2A
state machine, `cancel()` is only reachable from `draft`/`pending_approval`
— once a commitment is `active` it can never be cancelled through this
codebase, so a currently-active/partially_fulfilled/closed commitment was
continuously in that state from its `approvedAt` onward.

For the `asOfDate` cutoff:

```
committedCost = Σ commitmentLines.amount
  WHERE commitment.projectId = X
    AND commitment.companyId = X
    AND commitment.status IN ('active','partially_fulfilled','closed')
    AND commitment.approvedAt <= asOfDate
    AND commitmentLine.createdAt <= asOfDate
    AND commitment.currency = project's determined currency
```

This is an **exact** point-in-time reconstruction, not an approximation:
commitment lines are strictly append-only once a commitment leaves
`draft` — `submit()` freezes the initial line set, `amend()` only ever
*adds* new lines, nothing ever edits or removes an existing line after
submission. So summing lines by their own `createdAt` against the cutoff,
gated by the commitment having already been approved by that cutoff,
reproduces exactly what the committed amount was on that date — not
merely "the current total, filtered by a status check."

**Known limitation — no expense↔commitment link.** This schema has no
foreign key from `expenses` to `commitments`/`commitmentLines`. If a real
purchase order (Commitment) is later paid by logging an Expense for the
same purchase, this system has no way to detect that overlap — the
commitment continues to count in full as "still committed" even after an
economically-equivalent expense has been logged, because nothing in the
current data model ties the two together. This is a pre-existing
characteristic of Commitment (Phase 2A) and Expense (original MVP) having
been built independently, not something Phase 2D introduces or can fix
without inventing a new linking mechanism outside this phase's scope. It
is a real double-counting risk in practice, not merely theoretical, and is
documented here rather than silently ignored.

## 5. Certified Progress

```
certifiedValue = Σ ipcs.grossValue, WHERE projectId = X AND status = 'certified' AND certifiedAt <= asOfDate
```

Only `certified` IPCs count — `draft`, `submitted`, `approved`, and
`rejected` IPCs never contribute, exactly matching Phase 2C's own
semantics (see `docs/MIDAD_IPC_MODEL.md`). This cutoff is exact: `certify()`
freezes an IPC's `certifiedAt` and monetary fields forever (Phase 2C's
immutability guarantee), so there is no risk of a certified IPC's value
silently changing after the fact.

**Gross, not net.** `grossValue` (before retention) is used, not
`netCertified` (after retention/advance/deductions) — Certified Progress
here is meant as a *physical/contractual progress* figure (how much
scope has been certified), not a *cash* figure (how much is actually
payable). Retention is a payment-timing concept, not a progress one; see
§13 below.

**Certified Progress is contextual only.** It is returned alongside
`etc`/`eac` for visibility, but — per the explicit instruction this phase
was built under — it is never blended into the ETC/EAC arithmetic itself
(see §9, Method C).

## 6. `projects.budgetTotal` is NOT a Forecast input

Forecast never reads, writes, derives from, or synchronizes with
`projects.budgetTotal`. It is legacy, non-authoritative, and untouched by
`routes/forecast.ts` — verified by an explicit architectural-invariant
test (`tests/forecast.test.ts`, "Forecast never reads projects.budgetTotal").

## 7. ETC / EAC — two methods, no hidden formula

The pure calculation lives in exactly one place, `lib/forecast.ts`'s
`calculateForecast()` — a database-free, HTTP-free, side-effect-free
function. `routes/forecast.ts`'s only job is collecting the four inputs
above from their canonical sources and handing them to it; no formula is
ever duplicated in a route, a test, or (were one built later) a UI
component.

```
remainingCost = max(BAC - AC, 0)         — method-independent
```

**Method A — Cost-to-Complete (the conservative baseline):**
```
etc = remainingCost
eac = AC + etc
```
Ignores commitments entirely — the whole remaining plan is treated as
still uncertain, whether or not part of it is already contracted.

**Method B — Commitment-aware:**
```
etcUncommitted = max(BAC - AC - committedCost, 0)
etc = etcUncommitted
eac = AC + committedCost + etcUncommitted
```
`committedCost` and `etcUncommitted` are two disjoint pieces of BAC — this
does not double-count, subject to the expense↔commitment limitation in §4.

**Method C — Progress/performance-adjusted (SPI/CPI-style): NOT
implemented.** BAC/AC/ETC/EAC are denominated in *internal planned cost*;
Certified Progress (`ipcs.grossValue`) is denominated in *contract/BOQ
value* (revenue, including margin). There is no deterministic mapping in
this schema from a certified BOQ item's value back to the specific
portion of the Cost Plan that corresponds to the same physical scope
(`budgetItems.boqItemId` is optional and not guaranteed complete). Building
an earned-value-style adjustment on top of that would silently conflate
revenue and cost. Rather than invent that mapping, Method C is not built
in this phase — Certified Progress is exposed as context only.

`GET /api/projects/:projectId/forecast` returns **both** Method A and
Method B results side by side (never a single hidden default) so a
caller can see exactly how the two conservative formulas diverge.

## 8. Variance

```
variance = costPlan - eac
variancePercent = costPlan === 0 ? null : round((variance / costPlan) * 100)
```

**Sign convention:** positive variance = under plan; negative variance =
over plan. `variancePercent` is `null`, never `0` or `Infinity`, when
`costPlan` is zero — a percentage of zero is undefined, not zero, and
callers must handle that explicitly.

## 9. Money integrity

Every sum in `routes/forecast.ts` goes through `lib/money.ts`'s
`sumMoney`; every derived figure in `lib/forecast.ts` goes through
`roundMoney`. No raw JS float accumulation, no `toFixed()`-as-a-financial-
calculation, anywhere in this domain.

## 10. Point-in-time (`asOfDate`) semantics

`GET /forecast` (computed, not persisted) always uses **today** as its
cutoff — there is no historical query parameter on the live endpoint.
`POST /forecast/snapshots` accepts an optional `asOfDate` (default: today;
rejected with 400 if it is in the future). Each source's cutoff is applied
using the field that actually, exactly represents "when this became true"
for that source — see §3–5 above for exactly which field and why each is
trustworthy. Nothing here reconstructs a historical Cost Plan (§2's own
reasoning) or a historical project currency determination — only Actual
Cost, Committed Cost, and Certified Progress are cutoff-sensitive.

## 11. Snapshot model

`forecast_snapshots` is an **immutable historical record** of one
calculation, for one method, at one `asOfDate`. No `PATCH`/`DELETE` route
exists for it at all — the entire mutation surface is `POST
/forecast/snapshots` (create) and two `GET` routes (list, read one). A new
calculation always creates a new row; nothing recalculates an existing
snapshot in place, and a later change to Expenses/Commitments/IPCs never
retroactively changes an already-created snapshot's stored figures
(verified directly in `tests/forecast.test.ts`, "Snapshot immutability").

No sequence number is generated for snapshots — `id` (UUID) plus
`createdAt`/`asOfDate` are sufficient identifiers, deliberately avoiding
the whole MAX+1 numbering-race question this codebase has had to
repeatedly harden elsewhere (boq revisions, IPC numbers).

## 12. Concurrency

`GET /forecast` is a pure read with no write race. `POST
/forecast/snapshots` runs its reads and its insert inside a single
`REPEATABLE READ` transaction, so the persisted figures reflect one
consistent calculation boundary rather than values that could drift
between statements if another request mutated Expenses/Commitments/IPCs
concurrently. Five concurrent snapshot creations on the same project each
produce their own independent, internally-consistent row — no numbering
scheme exists to race over.

## 13. Retention / advance

Retention and advance recovery are **not** treated as Forecast inputs at
all — Certified Progress uses `grossValue` (before retention), and
`netCertified`/retention/advance figures (frozen per Phase 2C) are not
read anywhere in this domain. Forecast does not introduce, and does not
need, any cash-timing logic — that remains explicitly out of scope,
reserved for a possible future Cash Flow phase.

## 14. Currency

Multi-currency conversion is **not** implemented. A project's "home
currency" is its main contract's (`contractType = 'main'`) currency,
defaulting to `SAR` if none exists — `budgetItems` and `expenses` carry no
currency column at all in this schema (implicitly single-currency by
construction), so the only place a genuinely different currency can enter
is a Commitment's own `currency` field. A commitment whose currency does
not match the project's determined currency is **excluded** from
`committedCost` — never summed as if it were the same unit — and its id is
surfaced in `excludedForeignCurrencyCommitmentIds` (on both the live GET
response and a snapshot's `assumptions` column) so nothing is silently
dropped without a visible trail. No FX rate is invented anywhere.

## 15. Audit trail

Only `POST /forecast/snapshots` writes an audit event —
`forecast.snapshotGenerated`, via the existing `recordAuditEvent` (no
second audit mechanism). It records `projectId`, `method`, `asOfDate`,
`eac`, and `etc` in its metadata, and the full snapshot row as
`afterValue`. Ordinary `GET` requests — the live forecast, snapshot
listing/reading — never write an audit row.

## 16. Tenant isolation

Every Forecast query independently re-scopes to the caller's
`(companyId, projectId)`:

- `budgetItems`/`expenses` carry no `companyId` column at all (a
  pre-existing MVP characteristic) — they are scoped by an exact
  `projectId` match, and that `projectId` is only ever the one already
  validated (once, at the router level) to belong to the caller's
  company, so a foreign company's rows — which necessarily carry a
  different `projectId` — can never match.
- `commitments`/`ipcs` carry `companyId` directly; every query filters on
  both `companyId` and `projectId` (belt-and-suspenders, matching Phase
  2A/2C's own precedent even though `projectId` scoping alone is already
  sufficient).

Adversarial tests cover: a foreign company's GET/POST for a project it
doesn't own (404), a foreign company's own project never reflecting
another company's budget/expense/commitment/IPC data, and foreign-company
access to snapshot creation/reading (404).

## 17. Relationship to Contract / BOQ / Budget / Commitment / Expense /
    Measurement / IPC

Forecast sits downstream of all of them and mutates none of them:

```
Cost Plan (Budget) ─┐
Actual Cost (Expense) ─┼──→ Forecast (ETC/EAC) ──→ [not yet built: Cash Flow]
Committed Cost (Commitment) ─┤
Certified Progress (IPC, context only) ─┘
```

Contract and BOQ are not direct Forecast inputs — Contract only supplies
the currency-determination context (§14), and BOQ is not read at all in
this domain (Certified Progress comes from IPC, which already carries its
own frozen BOQ-derived values).

## 18. What Phase 2D deliberately does not build

No Cash Flow, no payment ledger, no bank reconciliation, no multi-currency
conversion, no AI/ML prediction, no health score or traffic-light status,
no Manager role, and no frontend dashboard. This document does not claim
any of those systems exist — a future Cash Flow phase, if built, would be
a *timing/projection lens* over Invoices, IPCs, Commitments, and Expenses,
not a redefinition of any cost figure established here or in
`docs/MIDAD_FINANCIAL_MODEL.md`.
