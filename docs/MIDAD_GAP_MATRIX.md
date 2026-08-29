# MIDAD — Gap Matrix: The Golden Data-Model Chain (Phase 0, Read-Only)

The mission's own golden chain:

```
CONTRACT → BOQ → COST CODE → BUDGET → PROCUREMENT → COMMITTED COST →
ACTUAL COST → PROGRESS/QUANTITY → EARNED VALUE → BILLING → CASH FLOW →
FORECAST → PROJECT HEALTH
```

For each link: does the **node** (the entity) exist, and does the **edge** (the traceable connection to its neighbor) exist. A node can exist while the edge to it is still broken — that distinction matters more than a simple exists/missing count, because it's the edges that make the chain a *chain* rather than a pile of disconnected numbers, which is the exact failure mode the mission's §4 explicitly warns against ("do not allow disconnected numbers").

| Link | Node exists? | Edge to previous node exists? | Evidence |
|---|---|---|---|
| **Contract** | ❌ MISSING | — | No `contracts` table. `quotes`/`invoices` are the nearest analogs but carry no contract-level fields (advance %, retention %, original-vs-revised value). |
| **BOQ** | ❌ MISSING | ❌ (nothing to link from) | No table, no route, no UI. `quoteItems`/`invoiceItems` are flat description+amount pairs with no quantity/unit/rate/section. |
| **Cost Code** | ⚠️ PARTIAL (free-text substitute) | ❌ BROKEN | `budgetItems.category` is an unconstrained string — the same cost incurred on two different projects has no guarantee of using the same code, so nothing can roll up by cost code across a portfolio. There is no BOQ item for a cost code to attach to in the first place. |
| **Budget** | ✅ EXISTS (single version) | ⚠️ PARTIAL | `budget_items` links to `projects` and, loosely, to a category string — but not to a BOQ item or a canonical cost code, so "budget by cost code" and "budget by BOQ item" both collapse to "budget by whatever string someone typed." |
| **Procurement** | ❌ MISSING | ❌ (nothing to link from) | No PR/RFQ/PO/GRN entity of any kind. |
| **Committed Cost** | ❌ MISSING | ❌ (no procurement or subcontract to source it from) | No commitment ledger exists. The mission's own example (`Budget 8M / Committed 6M / Actual 4.5M`) cannot be answered by this system today — it can only answer Budget and Actual. |
| **Actual Cost** | ⚠️ PARTIAL | ⚠️ PARTIAL | `expenses` records actual spend and *optionally* tags a `budgetItemId` — but that link is **not ownership-validated** (a pre-existing, confirmed finding: nothing checks the referenced budget item belongs to the same project), so even the one edge that exists is not a reliable one. |
| **Progress/Quantity** | ❌ MISSING | ❌ (no BOQ/measurement to source a quantity from) | `tasks.status` is a 3-state to-do flag; nothing computes or stores a %-complete, a measured quantity, or a quantity-based earned amount anywhere. |
| **Earned Value** | ❌ MISSING | ❌ (no Progress node to derive it from) | No PV/EV/AC triad, no CPI/SPI, anywhere in the codebase. |
| **Billing (Owner IPC)** | ⚠️ PARTIAL | ❌ BROKEN (not derived from progress) | `invoices` exist and their **tax amount** is now correctly, atomically computed by the new compliance engine (frozen at creation — a genuine, verified strength) — but an invoice's line-item *amounts* are entered directly, not derived from a BOQ-linked measured quantity × contract rate. Billing today is disconnected from progress by construction, not by bug — there is no progress data for it to connect to yet. |
| **Cash Flow** | ❌ MISSING | ❌ (no Billing-derived inflow schedule, no Procurement-derived outflow schedule) | No cash-flow entity or projection anywhere. |
| **Forecast** | ❌ MISSING | ❌ (no Committed, no Progress, no Cash Flow to forecast from) | No Cost-to-Complete or Estimate-at-Completion calculation anywhere in the codebase. |
| **Project Health** | ❌ MISSING | ❌ (every input dimension the mission specifies — cost, schedule, cash, procurement, subcontractors, productivity, risk — is itself missing or partial) | No health-score entity, calculation, or UI surface exists. |

## Reading this matrix

Of 13 links in the golden chain, **1 is a genuine, working node-and-edge pair (Budget, in its single-version form)**, **3 are partial nodes with broken or unvalidated edges (Cost Code, Actual Cost, Billing)**, and **9 have no node at all**. The chain does not exist today — what exists is a small set of disconnected, mostly-correct individual capabilities (Projects, Budget, Change Orders, Invoices, Tax) that were never designed to chain together, because nothing upstream of them (Contract, BOQ, Cost Code as a real hierarchy) exists to anchor the chain to.

**This is not a "70% done, needs polishing" situation — the golden chain is closer to 10–15% present by node count, and the edges that would make even the existing nodes into a real chain are mostly absent or unvalidated.** The honest implication for Phase 1 planning: **BOQ and a real Cost Code hierarchy are the correct starting point**, not because the mission lists them first, but because literally every downstream link in this matrix is blocked on one or both of them — Committed Cost needs Procurement which needs a BOQ/cost-code target to commit against; Progress needs a BOQ quantity to measure against; Billing-from-progress needs the same; Forecast needs Committed + Progress. Building Cash Flow, Project Health, or AI before this backbone exists would produce features with nothing real to compute from.

## Cross-cutting integrity risks already present (independent of new features)

These are pre-existing gaps in the *current* system that MIDAD's mission explicitly asks to check for (§29 Data Integrity) — listed here because they will only get worse once Committed/Actual/Forecast numbers depend on them being correct:

- **Budget changes are not audited.** A `PATCH` to a `budget_items` row silently overwrites the old value — no who/when/old-value/new-value/reason record, unlike the compliance-override system built this session, which does this correctly and is the pattern to replicate here.
- **`expense.budgetItemId` is not ownership-validated** — a cross-project (though not cross-tenant) foreign-key integrity gap, confirmed in the original platform audit and still unresolved.
- **No soft-delete/void pattern for financial transactions** — `DELETE /projects/:id/budget/expenses/:id` physically removes the row; the mission's §29 explicitly wants voiding/reversal instead of erasure for financial records. Today, deleting an expense leaves no trace it ever existed.
- **The tax-compliance engine itself carries 4 confirmed P0 bugs** (quote tax-display inconsistency, an unaudited tax-rate bypass on invoice/quote creation, and two concurrency races in its override system) — see `TAX_COMPLIANCE_RED_TEAM_AUDIT.md`. Since Billing sits directly in the golden chain and now depends on this engine, these are not a side concern — they are live defects in a node the chain already depends on.
