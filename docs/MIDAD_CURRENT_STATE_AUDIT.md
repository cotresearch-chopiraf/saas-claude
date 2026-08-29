# MIDAD — Current-State Capability Audit (Phase 0, Read-Only)

**Method:** every capability below was traced UI → API → service → database → calculation → permission → audit → tests, per the mission's requirement, not judged from filenames. Where a trace stops partway (e.g., an API exists but no UI calls it), that is stated explicitly.

**Classification key:** EXISTS · PARTIAL · MISSING · BROKEN · DUPLICATED · UNSAFE · UI-ONLY · BACKEND-ONLY · UNTESTED (a capability can carry more than one tag).

---

## 1. Organizations (tenant)

**EXISTS.** `companies` table is the tenant root. Every table either has a direct `companyId` FK or reaches one transitively. Tenant isolation was independently red-teamed twice this session (original platform audit, and again during the tax-engine audit) — every cross-tenant read/write attempt tried was denied (404, no leakage). **Trace:** UI (implicit, one company per logged-in user) → `req.companyId` from JWT → every query scoped → confirmed in tests (`multiTenant.test.ts`).

## 2. Users / Roles / Permissions

**PARTIAL.** Two roles only (`owner`, `member`), company-wide, not project-scoped. `lib/permissions.ts` is a real, centralized, tested authorization primitive (`authorization.test.ts`) — **the mechanism is solid; the vocabulary of roles and actions is far narrower than MIDAD's mission requires** (no `admin`, `finance_manager`, `accountant`; no project-level role assignment at all). **Trace:** UI (`Team.tsx` invites members) → `POST /company/invites` → `requireOwner`/`requirePermission` → `users.role` column → not separately audited as its own event type, only individual actions gated by it are logged.

## 3. Projects

**PARTIAL.** Flat entity: name, client, address, status, single `budgetTotal`, start date. **No WBS, no phases/packages, no parent/child hierarchy, no site/branch, no linked contract.** `routes/projects.ts` — full CRUD, correctly tenant-scoped, `project.delete` is owner-gated (confirmed in the RBAC remediation). **Trace:** `ProjectDetail.tsx` → `GET/PATCH/DELETE /projects/:id` → `projects` table → no calculation engine beyond raw storage → tested (`multiTenant.test.ts`, `authorization.test.ts`).

## 4. Contracts

**MISSING as a distinct entity.** There is no `contracts` table, no contract number, no original-vs-revised contract value, no advance/retention terms, no payment-terms field, no contract status lifecycle. The closest analogs are `quotes` (pre-work estimate, becomes `accepted`) and `invoices` (optionally linked to the originating `quote` via `invoices.quoteId`) — **but neither carries contract-level fields** (advance %, retention %, payment terms, overall contract value distinct from a single quote/invoice's line-item sum). A "contract" today is an *implicit* concept, never modeled.

## 5. BOQ (Bill of Quantities)

**MISSING entirely.** No table, no route, no UI. `quoteItems`/`invoiceItems` are flat `{description, amount}` pairs — no quantity, no unit, no rate, no section/hierarchy, no cost-code link, no budget-quantity-vs-actual-quantity tracking. This is the single largest structural gap for MIDAD's stated "golden chain," since BOQ is the mission's own root node.

## 6. Cost Codes

**MISSING as a canonical hierarchy; PARTIAL as an ad hoc substitute.** `budgetItems.category` is a **free-text string** (`z.string().min(2)` in `budget.ts`) — a user can type anything, no enum, no hierarchy (no "01 Labor / 02 Materials / ..."), no cross-project standardization, no way to roll up costs by a consistent code across projects. `expenses.budgetItemId` optionally links an expense to a budget-item (i.e., indirectly to a category string), but this link is **not ownership-validated** (a pre-existing finding from the original platform audit, still true: an expense's `budgetItemId` is accepted with no check that it belongs to the same project/company).

## 7. Budget

**PARTIAL.** `projects.budgetTotal` (single number) + `budget_items` (category string + planned amount) + `expenses` (actual spend, optionally tagged to a budget item). `GET /projects/:id/budget` computes `planned`, `spent`, `remaining` via `lib/money.ts` (cents-accurate, confirmed correct). **No budget versioning, no revision history, no approval workflow for a budget change, no "original vs. revised" distinction, no budget-transfer concept between cost codes.** A `PATCH` to a budget item silently overwrites the old value with no audit trail — this **directly violates** the mission's "never allow silent budget modification" requirement, today, for the *existing* budget feature (not a new gap MIDAD would introduce — a real, current gap). **Trace:** `BudgetPanel.tsx` → `budget.ts` routes → `budget_items`/`expenses` tables → `lib/money.ts` for totals → no audit → tested only for basic CRUD, not for the missing audit trail (there's nothing to test).

## 8. Procurement

**MISSING entirely.** No purchase-request, RFQ, supplier-quote-comparison, purchase-order, or goods-receipt entity or workflow exists anywhere. `expenses` is the only "money went out" record, and it is a single-step, unapproved, immediately-actual entry — there is no "committed but not yet actual" state for anything procurement-related.

## 9. Suppliers

**MISSING.** No `suppliers`/`vendors` table. `expenses.description` is free text; there is no structured vendor identity, no vendor performance tracking, no vendor tax-ID capture (distinct from the client-tax-ID fields that exist on invoices).

## 10. Inventory / Materials

**MISSING.** No material master, no stock/consumption tracking, no planned-vs-purchased-vs-received-vs-consumed variance of any kind.

## 11. Subcontractors

**MISSING as a distinct entity.** No `subcontracts` table, no subcontractor identity separate from a generic "expense" or "vendor," no subcontractor-specific IPC, retention, or advance-recovery logic.

## 12. Site Operations

**PARTIAL, UI-and-backend exist but very lightweight.** `daily_logs` table: `{projectId, note (free text), logDate}` — that is the entire schema. `DailyLogsPanel.tsx` on the client. **No structured fields for weather, workforce count, subcontractor presence, equipment, materials, delays, incidents, or safety observations** — everything is a single free-text note. No photo/evidence attachment on a daily log (the only file-upload capability anywhere in the app is the company logo). **Trace:** `DailyLogsPanel.tsx` → `dailyLogs.ts` (`POST/GET/DELETE`) → `daily_logs` table → no calculation, no linkage to progress/cost/resources → no dedicated tests (only implicitly exercised, not unit-tested).

## 13. Labor

**MISSING.** No labor/timesheet entity anywhere.

## 14. Equipment

**MISSING.** No equipment entity anywhere.

## 15. Progress

**MISSING.** No `%complete` field on projects, tasks, or anything else. `tasks.status` is a 3-state enum (`todo/in_progress/done`) with no weighting, no quantity basis, no schedule-linked percentage. No earned-value concept, no Planned Value / Earned Value / Actual Cost triad, no CPI/SPI anywhere.

## 16. Measurements

**MISSING.** No measurement-sheet entity, no measured-vs-approved-quantity workflow, no attachment-backed evidence for a quantity claim.

## 17. Owner Billing / IPC

**PARTIAL, and materially different in shape from what MIDAD's mission specifies.** `invoices` table: status enum `draft → sent → paid` (confirmed correctly enforced as a strict lifecycle, including the fix from the prior remediation preventing `draft → paid` skip). **What is missing relative to a real IPC:** no previous-certified amount, no current-vs-cumulative quantity/amount split, no retention withholding, no advance-recovery deduction, no "submitted → reviewed → approved → certified → paid" multi-party workflow (today it is a two-state `draft/sent` then a single `mark-paid` action, with no review/approval step and no distinction between "the client approved this" and "we recorded that we got paid"). **This is a real, working, but fundamentally simpler billing primitive than an IPC** — it is closer to "send an invoice, mark it paid" than to a certified-progress-billing instrument.

## 18. Subcontractor IPC

**MISSING entirely.** There is no subcontractor billing concept at all — subcontractor payments, if they occur today, would have to be recorded as a generic `expense`, with none of retention, advance recovery, or a certification workflow.

## 19. Change Orders

**PARTIAL/EXISTS for its own narrow scope, not connected to the wider chain.** `change_orders` table: `{projectId, title, description, amountDelta, status: pending/approved/rejected}`. Approving one **correctly, atomically** adjusts `projects.budgetTotal` (confirmed fixed and dynamically verified for concurrency-safety in the prior remediation — this is one of the better-tested pieces of the whole system). **What's missing:** no link to a contract or BOQ item, no distinction between a client variation (revenue-impacting) and an internal budget adjustment, no schedule-impact field, no "approved but not yet billed" tracking, no potential-vs-confirmed revenue view. Today a change order is purely a budget-adjustment record, not a commercial instrument.

## 20. Costs (Budget / Committed / Actual / Forecast)

**PARTIAL — Budget and Actual exist; Committed and Forecast are entirely MISSING.** This is one of the mission's own P0 headline requirements (§6–8) and today the system can only answer two of the four numbers in "Budget = 8M, Committed = 6M, Actual = 4.5M, Forecast = 8.7M" — it has Budget (`budgetTotal`/`budget_items`) and Actual (`expenses`), and has **no concept of Committed cost** (no PO/subcontract commitment ledger to source it from) and **no Forecast engine** (no Cost-to-Complete, no Estimate-at-Completion calculation anywhere in the codebase).

## 21. Commitments

**MISSING.** No commitment ledger of any kind (follows directly from Procurement and Subcontractors both being missing — there is nothing to source a commitment from).

## 22. Cash Flow

**MISSING.** No inflow/outflow projection, no 30/60/90-day forecast, no distinction between expected/confirmed/overdue/at-risk cash. The only "cash" signal in the system today is an invoice's `status` (`paid` or not) and a company-wide tax/revenue summary the user requested earlier this session (paid-invoice tax total) — neither is a cash-flow forecast.

## 23. Documents / Evidence

**PARTIAL, minimal.** The only file-upload capability in the entire codebase is company-logo upload (`lib/uploads.ts`, `multer` local disk). **No generic "attach evidence to any record" system exists** — no photo attachment on a daily log, no drawing/measurement-sheet attachment, no document versioning, no document-to-transaction linkage of the kind the mission specifies.

## 24. Schedule

**MISSING.** No Gantt/schedule/activity/milestone entity anywhere — `tasks` is a flat to-do list (title, assignee name as free text, due date, 3-state status), not a scheduling engine, and has no dependency, duration, or critical-path concept.

## 25. Risks

**MISSING.** No risk entity, no risk detection logic, no severity/probability/impact model anywhere.

## 26. Approvals

**PARTIAL.** The RBAC layer (`lib/permissions.ts`) enforces *who* can perform a small set of sensitive actions (change-order approval, invoice send/mark-paid, quote send, project delete, company/compliance management) — but this is a **binary gate, not a workflow**. There is no generic, reusable "submitted → reviewed → approved/rejected, with comment and audit" engine that could be applied to a purchase request, an IPC, or a budget change. Each of the few gated actions has its own hard-coded status enum (e.g., invoice `draft/sent/paid`) rather than a shared approval-workflow primitive.

## 27. Notifications

**MISSING (functionally).** `sendMail()` only `console.log`s — no real email delivery, no SMS, no push, no in-app notification center or unread-count model exists anywhere.

## 28. Reporting

**MISSING beyond one CSV export.** `GET /projects/:id/budget/export.csv` is the only reporting capability found in the entire codebase — a flat CSV of budget items and expenses for one project. No portfolio-level report, no VAT/tax summary report (despite the tax engine now computing real per-invoice tax data, there is no aggregated tax report), no PDF report beyond the quote/invoice documents themselves.

## 29. Portfolio Intelligence

**MISSING entirely.** No cross-project dashboard exists — `Dashboard.tsx` was not deeply traced in this pass but the route map confirms there is no `/portfolio` or equivalent route, and no aggregation query across projects was found in `routes/projects.ts` beyond a per-company flat list.

## 30. AI

**MISSING entirely.** No AI/LLM SDK dependency exists in `server/package.json`, no AI-related route, no anomaly-detection, forecasting, explanation, or recommendation logic of any kind.

---

## Bonus: the ONE domain that already demonstrates the pattern MIDAD's mission asks for everywhere else

**Tax & Compliance** (`lib/compliance/`, `routes/compliance.ts`, 7 country packs) is the single existing subsystem built with exactly the "global core + country/config pack" architecture the mission's §26 asks for across the whole product — a country-agnostic engine, versioned/immutable rule packs, an official-default-vs-company-override layer with audited resets, and historical-immutability guarantees for invoices. **It is genuinely well-architected** and should be treated as the template for how MIDAD's own core-vs-country-pack split ought to look elsewhere (e.g., a future Saudi-specific procurement/e-invoicing pack). **It is also, as of the just-delivered `TAX_COMPLIANCE_RED_TEAM_AUDIT.md`, carrying 4 confirmed P0 bugs** (a quote tax-display inconsistency, an unaudited invoice-creation tax-rate bypass, and two concurrency races in the override system) that have not yet been fixed — cited here for completeness, not re-litigated; see that report for detail. It has **zero UI** — every capability described above is API-only, confirmed by the complete client route list in `MIDAD_ARCHITECTURE_MAP.md` §B.

---

## Summary table

| Domain | Status |
|---|---|
| Organizations | EXISTS |
| Users/Roles/Permissions | PARTIAL (2 roles, no project-scoping) |
| Projects | PARTIAL (flat, no WBS) |
| Contracts | MISSING |
| BOQ | MISSING |
| Cost Codes | MISSING (free-text substitute only) |
| Budget | PARTIAL (no versioning/approval/audit) |
| Procurement | MISSING |
| Suppliers | MISSING |
| Inventory/Materials | MISSING |
| Subcontractors | MISSING |
| Site Operations | PARTIAL (unstructured free-text log only) |
| Labor | MISSING |
| Equipment | MISSING |
| Progress | MISSING |
| Measurements | MISSING |
| Owner IPC | PARTIAL (simple invoice, not a certified-billing instrument) |
| Subcontractor IPC | MISSING |
| Change Orders | PARTIAL (budget-only, not commercially linked) |
| Committed Cost | MISSING |
| Actual Cost | PARTIAL (via expenses, no cost-code discipline) |
| Forecast | MISSING |
| Cash Flow | MISSING |
| Documents/Evidence | PARTIAL (logo upload only) |
| Schedule | MISSING |
| Risks | MISSING |
| Approvals | PARTIAL (RBAC gate, not a workflow engine) |
| Notifications | MISSING (console.log stub) |
| Reporting | MISSING (one CSV export) |
| Portfolio Intelligence | MISSING |
| AI | MISSING |
| Tax & Compliance | EXISTS, well-architected, 4 confirmed P0 bugs unresolved |
