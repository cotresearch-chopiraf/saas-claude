# MIDAD Cash Flow Model (Phase 2E)

Status: established alongside the Phase 2E implementation, on top of the
canonical financial model (`docs/MIDAD_FINANCIAL_MODEL.md`), the IPC model
(`docs/MIDAD_IPC_MODEL.md`), and the Forecast model
(`docs/MIDAD_FORECAST_MODEL.md`). Cash Flow is the seventh, distinct
concept in this progression: **projected cash timing**, layered strictly
on top of everything Forecast already established — it does not
redefine, and never mutates, any of it.

This phase was preceded by a read-only discovery/architecture report that
identified a real blocker (STOP F/H): `invoices` had no reliable path to a
project or contract at all. The owner explicitly selected **Option 2** —
add nullable `invoices.projectId`/`invoices.contractId` via an additive
migration — resolving that blocker. See "Layer A" below.

## Layer A: the invoice relationship foundation

`invoices.projectId` and `invoices.contractId` (migration
`0013_pretty_sue_storm`) are both nullable. Every existing invoice keeps
working exactly as before, permanently unallocated (`projectId = NULL`) —
this is intentional, supported product behavior, not a data-quality gap
to eventually clean up. Neither column is ever populated by matching
`quotes.projectName` (free text) against `projects.name` — that was the
exact heuristic the Phase 2E discovery report ruled out as non-
deterministic. The only way either column gets set is through
`routes/invoices.ts`'s `resolveInvoiceProjectContract`, at invoice
creation only:

- Supplying `contractId` alone derives `projectId` from that contract
  (`contract.projectId`) — never left to a separately, possibly
  conflicting, supplied value.
- Supplying `projectId` alone is valid (a project-related but not
  contract-specific invoice).
- Supplying both requires `contract.projectId === projectId` (400 if not).
- Supplying neither remains fully valid — an unallocated, company-level
  invoice.

Both are independently validated against the caller's `companyId` before
ever being trusted — a foreign project or contract 404s. No reassignment
endpoint was added: no `PATCH /invoices/:id` route existed for any other
field either, so none was invented for this one — the relationship is set
once, at creation.

## Layer B: Cash Flow itself

Cash Flow is a **derived, projection-only analytical layer**. It is not a
new budget, not a payment ledger, not an accounting ledger, not an
invoice engine, and not an IPC replacement. `routes/cashflow.ts` never
writes to any table — the only mutation anywhere in this domain was
Layer A's one-time addition of two nullable columns.

### Source-of-truth reuse — no second financial source of truth

Cash Flow's `undated.etc` and `projected.commitments` figures are **not**
independently derived — they come from `routes/forecast.ts`'s own
`collectForecastInputs()` and `calculateForecast("commitment_aware", …)`,
imported and called verbatim. Cash Flow never re-implements BAC, AC, ETC,
or EAC. **EAC itself is deliberately never exposed anywhere in the
cash-flow response** — it is a total forecast metric, not a cash event,
and including it would invite a caller to add it on top of its own
components (AC + Commitment + ETC), double-counting.

## Output model

```
{
  projectId, asOfDate, currency, excludedForeignCurrencyCommitmentIds,
  historical: {
    cashReceived,   // Σ paid invoices' totals, paidAt <= asOfDate — real payment evidence only
    incurredCost,   // Σ expenses, expenseDate <= asOfDate — reused from Forecast's own AC
  },
  projected: {
    receivables,                   // Σ issued-but-unpaid ("sent") invoices' totals
    certifiedExpectedCollection,   // Σ certified IPCs' netCertified (gross minus withheld retention)
    commitments,                   // = Forecast's own committedCost, reused verbatim
    net,                           // (receivables + certifiedExpectedCollection) - commitments
  },
  undated: {
    etc,                        // = Forecast's own commitment-aware ETC, reused verbatim
    retentionToBeReleased,      // Σ certified IPCs' retentionAmount — no release date exists anywhere
    advance: { supported: false, reason: "…" },
  },
  assumptions: { forecastMethod, certifiedValueBasis, commitmentExpenseReconciliation, ipcInvoiceReconciliation },
}
```

Nothing is ever labeled "cash received" or "cash paid" unless the
database contains actual payment evidence (`invoices.paidAt`). An
Expense is always "incurred cost," never "cash paid" — Expense has no
payment-status field at all, so nothing could honestly claim otherwise.

### Why `net` only spans the `projected` bucket

`net` deliberately never blends `historical` (already-realized) amounts
or `undated` (untimed) amounts into itself. Netting a realized past event
against an unrealized future one inside one number would misrepresent
what has actually happened versus what is merely expected; netting an
undated amount (ETC, retention) into a dated-feeling figure would imply a
timing precision this data model cannot support. `undated.etc` and
`undated.retentionToBeReleased` are reported as their own, separate,
un-netted figures for exactly this reason.

## PIT (point-in-time) semantics

`GET /projects/:projectId/cash-flow` accepts exactly one parameter,
`asOfDate` (default: today; rejected if in the future). No `from`, `to`,
or `granularity` — the current schema has no time-phasing mechanism for
Commitment (no due-date field at all) or Forecast ETC (a single point-in-
time total, not a curve), so a date-range or monthly-curve output would
be fake precision this phase deliberately does not fabricate.

| Source | Economic date used | Why |
|---|---|---|
| Invoice paid | `paidAt` | Real payment evidence |
| Invoice issued/unpaid | `issueDate` | When the receivable was recognized |
| Commitment | `approvedAt` | Reused verbatim from Forecast |
| Expense | `expenseDate` | Reused verbatim from Forecast |
| Certified IPC | `certifiedAt` | Reused verbatim from Forecast |

`createdAt`/`updatedAt` are never substituted for any of the above.

## Retention

**Supported:** `grossValue − retentionAmount = netCertified` is already
exact (frozen by Phase 2C's `certify()`), so `certifiedExpectedCollection`
uses `netCertified` — the honestly-expected collection figure, net of
what the contract's retention rule withholds.

**Not supported:** whether or when the withheld retention will ever be
released. No field, event, or route anywhere in this codebase represents
"retention released." `retentionToBeReleased` is therefore reported in
the `undated` bucket only — never assigned a fabricated release date,
never netted into `projected.net`.

## Advance

`contracts.advancePercent` remains pure, inert metadata — never invoiced,
never paid, never recovered anywhere in this codebase (confirmed by
direct repository search, not by absence-of-evidence reasoning). Cash
Flow does not compute an advance figure, does not default it to zero
silently, and does not omit it silently either — it is reported
explicitly as `{ supported: false, reason: "…" }` so a caller can never
mistake omission for "no advance exists."

## Double-count prevention

Two real, structural gaps exist in the current schema, and Cash Flow
does not attempt to heuristically patch either — inventing a
reconciliation rule risks silently miscounting cash rather than honestly
over-representing it:

- **Commitment ↔ Expense:** no `expenses.commitmentId` relationship
  exists. A commitment that has already been paid down by a logged
  expense is not reconciled — both `projected.commitments` and
  `historical.incurredCost` count it independently. This is the same,
  pre-existing limitation Forecast (Phase 2D) already documented, reused
  verbatim here rather than re-litigated.
- **IPC ↔ Invoice:** no relationship exists between `ipcs` and
  `invoices`. A certified IPC's value is never automatically matched to,
  or subtracted from, any invoice — `projected.certifiedExpectedCollection`
  and `historical.cashReceived`/`projected.receivables` are computed
  entirely independently.

Both limitations are surfaced in every response's `assumptions` field,
not just in this document, so a caller reading the API directly (without
having read this file) still sees them.

## Currency

Multi-currency conversion is **not** implemented, reusing Phase 2D's
exact precedent: the project's currency is its main contract's currency
(default `SAR`); a Commitment whose currency doesn't match is excluded
from `projected.commitments`, never summed across incompatible units, and
surfaced in `excludedForeignCurrencyCommitmentIds`. `invoices` and
`expenses` carry no currency column at all (implicitly single-currency by
construction), so no filtering is needed for either.

## Tenant isolation

Every query independently re-scopes to `(companyId, projectId)`. With
Layer A in place, Invoice filtering is now fully deterministic —
`invoices.companyId = caller.companyId AND invoices.projectId =
requestedProjectId` — no text matching, no `quotes.projectName` matching,
closing exactly the gap the Phase 2E discovery report identified.
Commitments/IPCs reuse Forecast's own `(companyId, projectId)` scoping
verbatim; Expenses/BudgetItems (read only via the reused
`collectForecastInputs`) reuse Forecast's own project-scoping.

## RBAC

`GET /cash-flow` is open to owner and member — purely analytical/derived,
same posture as `GET /forecast`. No permission gate, no Manager role. No
persistence exists in this phase (see below), so no `cashflow.manage`
permission was added — there is nothing for it to gate yet.

## Audit

None. Cash Flow performs no writes, so no audit event is ever recorded
for it — an ordinary `GET` never manufactures a durable record, matching
Forecast's own precedent for its computed (non-snapshot) endpoint.

## Why no snapshots in this phase

The owner-approved architecture for Phase 2E is projection-only: no
cash-flow ledger, no payment transaction table, no snapshot numbering.
Unlike Forecast (where a snapshot has clear business value — "what did
we project EAC to be on this specific date, for this specific method"),
Cash Flow's own inputs are themselves already derived from Forecast, and
no persistence requirement was demonstrated for this phase. If a future
phase needs immutable, citable cash-flow snapshots, they would follow
the exact same pattern `forecast_snapshots` already established (UUID +
`createdAt`, no numbering race, `REPEATABLE READ` transaction,
`recordAuditEvent`) — not a new pattern.

## Relationship to Contract / BOQ / Budget / Commitment / Expense /
    Measurement / IPC / Invoice / Forecast

```
Cost Plan + Actual Cost + Committed Cost  ──→  Forecast (ETC/EAC, Phase 2D)
                                                     │  (etc, committedCost reused verbatim)
                                                     ▼
Certified IPC (net of retention)  ─────────────→  Cash Flow (Phase 2E)
Invoice (paid / issued-unpaid, via projectId)  ─→      │
                                                        ▼
                                    projected inflow vs. outflow, as of one date
```

Contract and BOQ are not direct Cash Flow inputs — Contract only supplies
currency-determination context (reused from Forecast) and retention/
advance rules (already frozen into IPC); BOQ is not read at all.
