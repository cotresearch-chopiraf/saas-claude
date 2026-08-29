# MIDAD — P0 Plan (Phase 0 deliverable — PLAN ONLY, no implementation)

This is a plan, not code. Nothing in this document has been built. It sequences the P0 capabilities from the mission (§5–§19) against the actual gap matrix in `MIDAD_GAP_MATRIX.md`, and against what already exists and should be **reused, not replaced** (`MIDAD_ARCHITECTURE_MAP.md` §F, §I). Per the mission's explicit instruction, this plan stops at "propose a sequence and reuse strategy" — it does not begin Phase 1 implementation.

## Guiding constraint from Phase 0's findings

The gap matrix showed the golden chain is blocked upstream: Committed Cost needs something to commit *against* (a BOQ/cost-code target); Progress needs something to measure *against* (a BOQ quantity); Forecast needs Committed + Progress; Cash Flow and Project Health need most of the above. **Building P0 in the mission's own listed order (§5.1 Contract → §5.2 BOQ → §5.3 Cost Codes → §5.4 Budget → §6 Committed → §7 Actual → §8 Forecast → §9 Procurement → §10 Subcontractors → §11 Owner IPC → §12 Measurement → §13 Progress → §14 Change Orders → §15 Daily Reports → §16 Material → §17 Cash Flow → §18 Health → §19 Risk) is already the correct dependency order** — the mission's own sequencing matches the gap matrix's conclusion. This plan follows it, mapped onto the mission's Phase 1–8 structure (§35), with explicit reuse notes at each step.

## What to reuse, explicitly, at every step (do not rebuild these)

- **Tenant scoping pattern:** every new table gets a `companyId` (direct or via `projectId`), every query scoped by `req.companyId` from the verified JWT — the existing, twice-red-teamed pattern, not a new one.
- **RBAC:** extend `lib/permissions.ts`'s `PERMISSIONS` map with new named actions (`procurement.approve`, `ipc.certify`, `budget.revise`, etc.) — do not build a second authorization system. The mission's §2 asks for owner/admin/finance-manager/accountant; introducing new roles is a real schema change (`userRoleEnum`) that should be proposed and reviewed on its own before Phase 1 starts, not silently added — flagged here as a decision point, not pre-decided.
- **Money arithmetic:** every new cost/commitment/forecast calculation uses `lib/money.ts`'s cents-based `computeTotals`/`sumMoney`/`roundMoney` — never raw float arithmetic. This is already the established, tested house rule.
- **Atomic concurrent updates:** every new "adjust a running total" operation (committed-cost ledger, budget revision, IPC cumulative amount) uses the conditional-`UPDATE ... WHERE <guard>` pattern established in `changeOrders.ts` and now known to be missing in the compliance-override code (`TAX_COMPLIANCE_RED_TEAM_AUDIT.md` TC-03/TC-04) — that audit is the cautionary example of what happens when this pattern is skipped in new code.
- **Audit trail:** every new sensitive mutation (budget revision, commitment creation, IPC certification) writes an audit-event row in the same transaction as the mutation, following the exact `lib/compliance/audit.ts` pattern (append-only, no update/delete route ever exposed) — do not invent a second audit mechanism; consider whether `compliance_audit_events` should become a general-purpose `audit_events` table (one schema decision to make explicitly before Phase 1, not two competing tables).
- **Core-vs-country-pack split:** the compliance engine's adapter-registry pattern (`lib/compliance/packs/index.ts`) is the template for keeping Saudi-specific rules (e-invoicing profile, WHT categories) out of the core cost/procurement engine, per the mission's own §26.
- **Testing convention:** every new capability gets real integration tests against a real Postgres instance via Supertest, following the existing `tests/*.test.ts` convention — not mocked unit tests.

## Phase 1 — Foundation (Contract, BOQ, Cost Codes, Budget versioning, Permissions, Audit)

**Repair before extend, per the mission's own rule.** Two pre-existing integrity gaps sit directly in this phase's territory and should be fixed as part of it, not left for later: budget-item changes are currently unaudited (§7 of the current-state audit), and `expense.budgetItemId` is not ownership-validated.

1. **Contract entity** — new table, linked to `projects` (1:1 or 1:many depending on whether multi-contract-per-project is real for this market — a question for the business, not a technical default). Original/revised value, advance %, retention %, payment terms, status, linked BOQ.
2. **BOQ entity** — items with code, description, section, unit, quantity, rate, amount, cost-code link, parent/child hierarchy, revision/versioning (never overwrite a historical BOQ version — append a new version row, matching the compliance engine's `compliance_rule_versions` immutable-versioning pattern).
3. **Cost Code hierarchy** — a real table (company-level canonical list + project-level extensions), replacing `budgetItems.category`'s free text. Migration note: existing `budgetItems.category` strings need a mapping/backfill strategy, not a silent drop — a genuine data-migration decision to make explicitly in Phase 1, with the existing data inspected first (per the mission's own §0 rule against blind destructive migrations).
4. **Budget versioning** — original/revised/approved budget, budget-transfer-between-cost-codes, and the audit trail this capability is currently missing.
5. **RBAC extension** — add the new actions this phase introduces to `lib/permissions.ts`; resolve the role-vocabulary question (does MIDAD need `admin`/`finance_manager`/`accountant` now, or can this phase still run on owner/member with finer action gating?) before committing to a schema change.

## Phase 2 — Cost Control (Committed, Actual, Forecast)

1. **Committed Cost Ledger** — new table: source type (PO/subcontract/other), source ID, project, cost code, BOQ item, committed amount, released amount, remaining. No entries possible yet without Phase 3's procurement/subcontract sources — this phase builds the ledger and its query surface; Phase 3 populates it.
2. **Actual Cost hardening** — fix the `expense.budgetItemId` ownership-validation gap; extend `expenses` (or a new `actual_costs` table, if the existing one doesn't cleanly extend — a decision to make once BOQ/cost-code are real) with cost-code and BOQ-item linkage.
3. **Forecast Engine** — Cost-to-Complete and Estimate-at-Completion, computed transparently from Budget/Committed/Actual (never a black-box predictive model, per the mission's explicit instruction) — this is the first point in the plan where the golden chain's Budget → Committed → Actual → Forecast segment becomes answerable end-to-end.

## Phase 3 — Procurement + Subcontractors

1. **Procurement workflow** — Purchase Request → RFQ → Supplier Quotes → Approval → PO → GRN → Invoice, each step linked to project/cost-code/BOQ-item/budget, each PO/commitment writing into Phase 2's Committed Cost Ledger.
2. **Supplier entity** — structured vendor identity, replacing free-text vendor names on expenses.
3. **Subcontractor entity** — subcontract value/scope/BOQ link, feeding the same Committed Cost Ledger.
4. **Subcontractor IPC** — its own certified-billing workflow (see Phase 5 for the shared IPC pattern this and Owner IPC should both be built from, rather than two independent implementations).

## Phase 4 — Site + Progress

1. **Daily Report structure** — extend `daily_logs` from a single free-text note to structured fields (weather, workforce, subcontractors present, equipment, materials, delays, incidents, safety) — extend the existing table/route, do not replace it; existing daily-log data must remain readable.
2. **Generic evidence/attachment system** — the mission's Document/Evidence requirement (§21) is a prerequisite for photo-backed daily reports and measurement sheets; today only a company logo can be uploaded. This needs a real design (object storage vs. continuing with local disk — local disk is already flagged in the codebase's own comments as a stopgap not meant to survive a multi-instance deployment).
3. **Measurement entity** — BOQ quantity vs. measured vs. approved, evidence-attached.
4. **Progress Engine** — BOQ-weighted, quantity-based, and milestone progress; Planned Value / Earned Value / Actual Cost; CPI/SPI **only surfaced where the underlying data is actually complete enough** (the mission's own explicit guard against showing EVM metrics built on incomplete data).
5. **Material Control** — planned/purchased/received/consumed/variance, connected to Phase 3's procurement and this phase's site data.

## Phase 5 — Billing + Cash

1. **Owner IPC** — a real certified-billing workflow (previous certified, current/cumulative quantity and amount, retention, advance recovery, draft→submitted→reviewed→approved→certified→paid), built on the same reusable Approval-workflow primitive Phase 1's permission extension and Phase 3's subcontractor-IPC both need — **build one shared approval-workflow engine, not two parallel IPC implementations for owner and subcontractor billing.**
2. **Cash Flow** — inflow (advance, IPC, collections, retention release) and outflow (suppliers, subcontractors, payroll, materials, equipment) projections at 30/60/90 days, categorized expected/confirmed/overdue/at-risk.

## Phase 6 — Intelligence (Project Health, Portfolio, Risk, Alerts)

Only meaningful once Phases 1–5 supply real underlying data — this is explicitly why the mission places it after cost/procurement/site/billing, and why this plan does the same. Project Health Score computed only from real data per dimension (cost/schedule/cash/procurement/subcontractors/productivity/risk), each score always paired with an explanation (why, what changed, what to do) per the mission's explicit requirement — not a cosmetic single number.

## Phase 7 — AI

Deferred until the underlying data model (Phases 1–6) is real enough for AI outputs to be grounded in actual figures rather than sparse/empty tables — matches the mission's own explicit sequencing and its "AI must never fabricate, must show source data + reasoning + confidence, must never silently modify financial truth" requirements. The compliance engine's `publishNewRuleVersion()` (human-gated, never auto-invoked) is the existing precedent for "AI proposes, human publishes" — the same shape should govern any AI-suggested action here (create task/RFQ/risk/notification), never an AI-direct financial mutation.

## Phase 8 — Commercial Hardening

Billing/subscription/limits, and a repeat, focused security/tenant-isolation/RBAC pass across every new domain added in Phases 1–7 — the same rigor already applied twice this session to the existing surface (original platform audit, tax-engine audit) should be applied again once the Construction Control domains exist to attack.

## Explicit non-goals for this plan (per the mission's own instructions)

- No full General Ledger / accounting-system replacement — MIDAD owns operations/cost/procurement/billing-workflow, integrates outward to accounting platforms (Sage/Qoyod/etc.), per §27.
- No feature added merely to match a competitor without passing the mission's own 7-question test (§33).
- No Saudi-only hard-coding into the core — every country-specific rule (tax already proven out; e-invoicing, procurement documentation requirements, etc.) goes into a pack, following the compliance engine's precedent.

## Immediate open decisions to resolve before Phase 1 starts (not answered by this plan)

1. Does MIDAD need new roles (`admin`/`finance_manager`/`accountant`) now, or can Phase 1–2 run on finer-grained actions against the existing owner/member roles? This is a real schema change and should be a deliberate product decision, not an implementation-time default.
2. Is a Contract 1:1 or 1:many with a Project? Affects the Contract table's foreign-key shape from day one.
3. Object storage vs. continued local-disk for the evidence/attachment system needed starting Phase 4 — a deployment-environment decision, not purely a code one.
4. Should `compliance_audit_events` be generalized into a product-wide `audit_events` table before Phase 1 adds its own audit trail, to avoid two parallel audit mechanisms?
5. Should the 4 confirmed P0 bugs in the tax-compliance engine (`TAX_COMPLIANCE_RED_TEAM_AUDIT.md`) be fixed before or in parallel with Phase 1, given Billing (Phase 5) already depends on that engine? Recommendation: fix them before Phase 5 needs to build on top of Billing, not necessarily before Phase 1 starts (they don't block Contract/BOQ/Cost-Code/Budget work).

---

**This document is a plan only. Per the mission's explicit instruction, implementation does not begin until this Phase 0 discovery package is reviewed and Phase 1 is explicitly authorized.**
