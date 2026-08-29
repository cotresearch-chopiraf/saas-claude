# MIDAD — Domain Map (Phase 0, Read-Only)

Quick-reference companion to `MIDAD_CURRENT_STATE_AUDIT.md` — for each of the 30 domains in the MIDAD strategic product model, the closest existing code entity (if any), by exact file/table name, so Phase 1+ work has a precise starting point instead of a re-discovery pass.

| # | MIDAD Domain | Closest Existing Entity | DB Table(s) | Server Route(s) | Client | Notes |
|---|---|---|---|---|---|---|
| 1 | Organizations | Companies | `companies` | `routes/company.ts` | `Settings.tsx`, `Team.tsx` | Tenant root, solid |
| 2 | Users/Roles/Permissions | Users + RBAC | `users` | `routes/auth.ts`, `routes/company.ts`; `lib/permissions.ts` | `Team.tsx` | 2 roles only, company-wide |
| 3 | Projects | Projects | `projects` | `routes/projects.ts` | `Dashboard.tsx`, `ProjectDetail.tsx` | Flat, no hierarchy |
| 4 | Contracts | *(none — quotes/invoices are the nearest analog)* | `quotes`, `invoices` | `routes/quotes.ts`, `routes/invoices.ts` | `Quotes.tsx`, `Invoices.tsx` | No contract-level fields (advance/retention/terms) |
| 5 | BOQ | *(none)* | — | — | — | Not modeled at all |
| 6 | Cost Codes | Budget-item category (free text) | `budget_items.category` | `routes/budget.ts` | `BudgetPanel.tsx` | No hierarchy/enum |
| 7 | Budget | Budget items + project total | `projects.budgetTotal`, `budget_items`, `expenses` | `routes/budget.ts` | `BudgetPanel.tsx` | No versioning/approval |
| 8 | Procurement | *(none)* | — | — | — | `expenses` is direct-actual only, no PR/RFQ/PO/GRN |
| 9 | Suppliers | *(none)* | — | — | — | Vendor is free-text on `expenses.description` only |
| 10 | Inventory/Materials | *(none)* | — | — | — | — |
| 11 | Subcontractors | *(none)* | — | — | — | — |
| 12 | Site Operations | Daily logs | `daily_logs` | `routes/dailyLogs.ts` | `DailyLogsPanel.tsx` | Single free-text note field |
| 13 | Labor | *(none)* | — | — | — | — |
| 14 | Equipment | *(none)* | — | — | — | — |
| 15 | Progress | *(none)* | — | — | — | `tasks.status` is a 3-state to-do flag, not %complete |
| 16 | Measurements | *(none)* | — | — | — | — |
| 17 | Owner Billing/IPC | Invoices | `invoices`, `invoice_items` | `routes/invoices.ts` | `Invoices.tsx`, `PublicInvoice.tsx` | draft→sent→paid only, no cumulative/retention/advance |
| 18 | Subcontractor IPC | *(none)* | — | — | — | — |
| 19 | Change Orders | Change orders | `change_orders` | `routes/changeOrders.ts` | `ChangeOrdersPanel.tsx` | Budget-only, no contract/BOQ/billing link |
| 20 | Costs (Budget/Committed/Actual/Forecast) | Budget + Expenses (2 of 4) | `budget_items`, `expenses` | `routes/budget.ts` | `BudgetPanel.tsx` | No Committed, no Forecast |
| 21 | Commitments | *(none)* | — | — | — | — |
| 22 | Cash Flow | *(none)* | — | — | — | Invoice `status`/`paidAt` is the only cash-adjacent signal |
| 23 | Documents/Evidence | Company logo upload only | `companies.logoPath` | `lib/uploads.ts`, `routes/company.ts` | `Settings.tsx` | No generic attachment system |
| 24 | Schedule | Tasks (flat to-do) | `tasks` | `routes/tasks.ts` | `TaskPanel.tsx` | No dependencies/duration/critical path |
| 25 | Risks | *(none)* | — | — | — | — |
| 26 | Approvals | RBAC action gate | — | `lib/permissions.ts` | — | Binary gate, not a workflow engine |
| 27 | Notifications | Console-log mailer stub | — | `lib/mailer.ts` | — | No real delivery of any kind |
| 28 | Reporting | Budget CSV export | — | `routes/budget.ts` (`/export.csv`) | `BudgetPanel.tsx` | Single report, one project at a time |
| 29 | Portfolio Intelligence | *(none)* | — | — | `Dashboard.tsx` (per-company project list only) | No cross-project aggregation found |
| 30 | AI | *(none)* | — | — | — | No AI SDK dependency exists in the repo |
| — | **Tax & Compliance** *(not in the mission's 30, but real and substantial)* | Compliance engine + 7 country packs | `compliance_rule_versions`, `company_compliance_profiles`, `company_tax_overrides`, `compliance_audit_events`, `company_tax_identifiers` | `routes/compliance.ts`, `lib/compliance/*` | **none — API only** | Well-architected, 4 confirmed P0 bugs (see `TAX_COMPLIANCE_RED_TEAM_AUDIT.md`) |

**Reading this table:** 21 of the 30 mission domains have **no existing entity at all** (`—` in every column). 7 have a partial analog that would need real extension, not replacement, to reach what the mission specifies. 2 (Organizations, Users/Roles baseline) are solid foundations to build on directly. This is the honest, unpadded starting position for Phase 1 planning.
