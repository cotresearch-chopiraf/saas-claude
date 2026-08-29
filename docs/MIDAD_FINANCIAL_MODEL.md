# MIDAD Financial Source-of-Truth Model

Status: established during the Phase 2 architectural-unblock task, on top of
the Phase 1 + Phase 1.1 foundation (commit `15818bd`). This document exists
so no future domain (Procurement, Commitment, Progress, IPC, Forecast, Cash
Flow) has to guess which number means what — it states, explicitly, which
table owns which financial concept today, and which concepts are related but
must never be collapsed into one generic "budget" field.

## Why this document exists

The Phase 2 discovery found that this codebase had accumulated **four
independent, unreconciled "the project's money" numbers** with no invariant
connecting them:

1. `projects.budgetTotal` — the original MVP's only budget concept.
2. `contracts.revisedValue` — the Phase 1 Contract domain's value.
3. Σ `budgetItems.plannedAmount` — the Phase 1 Budget domain's planned total.
4. Σ published `boqItems.amount` — the Phase 1 BOQ domain's scope valuation.

Nothing tied any two of these together, and `projects.budgetTotal`
specifically could be silently overwritten by any authenticated company
member through the normal project-update endpoint, with no audit trail —
completely bypassing the one workflow (change-order approval) that was
supposed to be its only legitimate writer. That gap is fixed as part of this
same task (see `routes/projects.ts`).

This document resolves the ambiguity going forward. It does not change what
already exists beyond that one fix — it names what each existing number
already, correctly, means.

## The canonical model

| Concept | Canonical source | Represents | Mutated by |
|---|---|---|---|
| **Contract Value** | `contracts.revisedValue` (`originalValue` for the as-signed figure) | Current contractual/revenue value of the project's commercial instrument(s) | Contract create/amend (`routes/contracts.ts`, owner-only, audited) |
| **BOQ Value** | Σ `boqItems.amount` on a contract's currently-published `boqRevisions` row | Valuation of contractual/operational **scope** — what the contract's line items say the work is worth | BOQ item add (draft-phase only), frozen on publish (`routes/boq.ts`) |
| **Cost Plan** | `budgetItems.plannedAmount`, grouped by project / cost code / BOQ item / budget revision | The **canonical internal planned-cost baseline** — what future Commitment, Actual Cost, and Forecast logic computes variance against | Budget item CRUD (`routes/budget.ts`, member-accessible, audited as of Phase 1.1) |
| **Actual Cost** | Σ `expenses.amount`, optionally linked to a `budgetItems` row via `budgetItemId` | Incurred cost | Expense CRUD (`routes/budget.ts`, member-accessible, audited as of Phase 1.1) |
| **Commitment** *(not yet built)* | — | Contracted/ordered future cost (Purchase Orders, Subcontracts) | Phase 2A |
| **Progress / Certified Value** *(not yet built)* | — | Measured/executed work, and the value certified for payment (IPC) | Phase 2B/2C |
| **Forecast (ETC/EAC)** *(not yet built)* | — | A **derived** projection computed from Cost Plan + Commitment + Actual + Progress — never independently editable, never a second calculation of the same thing done elsewhere | Phase 2D, one canonical calculation function |
| **Cash Flow** *(not yet built)* | — | Timing/projection layer over receivables (invoices, certified IPC amounts) and payables (commitments, expenses) — a lens over the above, not a new definition of cost | Phase 2E |

These are **related, not interchangeable**. Contract Value is what the
client owes; BOQ Value is what the scope is priced at; Cost Plan is what the
contractor expects to spend; Actual Cost is what has been spent. A healthy
project can have all four legitimately differ (margin, scope changes not
yet reflected in an amendment, planned-vs-priced differences) — that
divergence is information, not a bug to silently reconcile away.

## `projects.budgetTotal` — legacy, explicitly non-authoritative

`budgetTotal` predates Contract, BOQ, and BudgetItems entirely — it was the
original MVP's only notion of "the project's money," built before any of
the above existed. It remains in the schema and in the API response for
backward compatibility and display only.

As of this task:

- It is **no longer settable** through `PATCH /api/projects/:id` (removed
  from that route's schema entirely — not gated by role, simply not part of
  the request shape any role can send). Sending it in that request body is
  silently ignored, exactly like any other unknown field.
- Its only remaining writer is change-order approval's atomic SQL increment
  (`routes/changeOrders.ts`), unchanged — that workflow is untouched,
  still owner-gated, still concurrency-hardened, still audited via its
  existing `logger.info` call.
- It is still settable once, at project creation (`POST /api/projects`) —
  a reasonable one-time initial value, not a live financial control surface.
- **No Phase 2 domain may read it.** Commitment, Forecast, and Cash Flow
  must compute against the Cost Plan (`budgetItems.plannedAmount`), never
  against `budgetTotal`.

The database column itself is untouched — not dropped, not renamed, not
made nullable-or-not differently. This is a behavioral deprecation, not a
schema change.

## The forward chain (for Phase 2 implementers)

```
Contract ──→ BOQ ──→ Cost Plan (budgetItems) ──→ Commitment ──→ Actual Cost
                │
                └──→ Measurement ──→ Progress ──→ IPC (Certified Value)

Cost Plan + Commitment + Actual + Progress context ──→ Forecast (ETC/EAC)

Cash Flow: a timing/projection view over Invoices, IPC, Commitments, and
Expenses — it does not redefine cost or introduce a new cost figure.
```

CostCode and BOQItem are cross-cutting tags/groupings usable at every layer
(a Commitment line, a Measurement, an Expense can all reference the same
CostCode or BOQItem) — they are not, themselves, financial totals.

## What this document deliberately does not do

It does not specify field-level schemas for Commitment, Measurement, IPC,
Forecast, or Cash Flow — those are Phase 2A–2E design work, not yet
approved for implementation. It only fixes the meaning of what already
exists, so that future design work has a stable floor to build on.
