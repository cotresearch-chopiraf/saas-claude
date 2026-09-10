# MIDAD Post-Audit Backlog

Deferred from Phase F (Professional UX/UI & Information Architecture) per that
phase's own scope-control rule: real gaps found during the audit that would
require a **new feature, a new API endpoint, or a backend aggregate** — out of
bounds for a UI-presentation-only phase. None of these were implemented.
Logged here instead of added silently.

## 1. Portfolio-level financial KPIs on the global Dashboard

The redesigned Dashboard (`client/src/pages/Dashboard.tsx`) intentionally does
**not** show Budget/Forecast/Variance columns per project, or a "Portfolio
Progress"/"Cash Position" KPI. No company-wide aggregate endpoint exists for
these today — only per-project `GET /projects/:id/budget` and
`GET /projects/:id/forecast`. Filling those columns honestly would mean either:

- an N+1 client-side fan-out (one Budget + one Forecast call per project row),
  which is a real performance risk once a company has more than a handful of
  active projects, or
- a new backend aggregate endpoint (e.g. `GET /api/projects/financial-summary`),
  which is a schema/API change outside this phase's scope.

**Recommendation:** a dedicated backend phase to design and add a bounded,
indexed, company-scoped financial-summary aggregate (reusing the existing
`collectForecastInputs`-style canonical sources — never a second calculation
engine), then surface it here.

## 2. Client Portal access status on Project Overview

Section 8 of the Phase F brief asked for a compact "Client Access: ● Active"
card on each project's Overview. No project-scoped "does this project have an
active Client Portal grant" read endpoint was found during discovery (Client
Portal access grants are managed from `/api/client-portal-users`, keyed by
portal user, not indexed by project for a simple per-project read). Adding
this honestly needs either a new query/endpoint or a client-side join across
every portal user's grants — both out of scope for a UI-only phase.

**Recommendation:** add a small `GET /api/projects/:id/client-portal-access`
(or extend an existing project read) in a scoped backend follow-up, then wire
the same compact-card pattern already used for Budget Alerts/Schedule/Punch
List.

## 3. Nitaqat/GOSI compliance status on Project Overview

The Phase F brief's example ("Workforce Compliance: ● Healthy") assumes a
per-project compliance status. The actual data model (Phase D1) is
deliberately **company-wide, not project-scoped** — compliance periods,
Nitaqat, and GOSI records carry no `projectId`. There is no honest per-project
status to show without inventing a mapping that doesn't exist in the data
model. Not implemented, and not a candidate for a naive workaround — see
Phase D1's own discovery report for why it's company-wide by design.

**Recommendation:** if a future phase genuinely needs project-level workforce
compliance visibility, that decision belongs with a product/architecture
discussion, not a UI-phase shortcut.

## 4. Per-group sidebar collapse in the global App Shell

The redesigned global sidebar (`client/src/components/Layout.tsx`) supports a
whole-sidebar collapse (icon rail with tooltips), matching the brief's
"collapsible... tooltips when collapsed" instruction. Collapsing individual
groups independently (e.g. hiding "الامتثال" while keeping "تجاري" open) was
not built — the existing `ProjectSidebar.tsx` precedent this pattern was
modeled on doesn't have per-group collapse either, and with only 6 groups /
2-4 items each, the value is marginal relative to the added state-management
complexity. Revisit if the group count grows materially.

## 5. Full RTL/responsive device matrix verification

**Status: partially resolved in Phase F.1.** Real browser verification (Chromium
via Playwright, desktop 1440px / tablet 834px / mobile 390px) was performed for:
Dashboard (incl. search/status-filter/sort on the project table), Project
Overview (incl. the new Project Health card), the global nav's collapsed
sidebar and mobile drawer, the project workspace's own mobile drawer, Budget
Alerts, Payroll, Labor Compliance, and the Gantt/Schedule page. Two real bugs
were found and fixed this way (see `client/src/ui/MetricCard.tsx` and
`client/src/ui/Modal.tsx` history) — proving code inspection alone would have
missed them.

**Still not driven in a real browser:** Forms in isolation (the brief's own
"logical sections" requirement — existing create/edit forms were not
individually re-verified), the Client Portal experience, the ZATCA settings
flow, and the ~19 individual pages listed in item 6 below. Recommend covering
these in a follow-up pass, ideally as an automated Playwright visual-regression
suite rather than ad hoc manual screenshots each phase.

## 6. Individual page polish (Phase F.1 §17) — not fully covered

Phase F.1 focused its actual UI changes on the App Shell, Dashboard, and
Project Overview (the two highest-traffic screens, same prioritization Phase F
already established) plus a Project Health card and a sortable portfolio
table. The ~19 other listed pages (Contract, BOQ, Cost Plan, Procurement,
Actual Cost, Progress, Forecast, Cash Flow, IPC, Subcontract IPC, Invoices,
Documents, Operations, Punch List, Employees, Labor Allocation, Customers,
Suppliers, Quotes, Team, Settings, ZATCA) were **not** individually reviewed or
redesigned this phase — they already follow the established `PageHeader` /
`Card` / `FinancialTable` primitives from earlier phases, but a dedicated
per-page Header/Summary/Content/Actions audit (per the master prompt's §17
template) was not performed. Recommend a dedicated follow-up phase, working
through the list in priority order (financial pages first: Cost Plan,
Forecast, Cash Flow, IPC, Invoices), rather than attempting all ~19 in one
UI-only pass.

## 7. Portfolio table Budget/Actual+Commitments/Forecast/Variance/Risk columns

Phase F.1's brief (§6) asked for these columns on the Dashboard's project
table again. Not implemented, same root cause as item 1 above (no
company-wide financial aggregate endpoint exists; per-row fan-out would be
N+1). Search, status filter, and column sorting were added this phase (all
client-side over already-loaded rows); the financial columns remain blocked
on the same backend aggregate recommended in item 1.

## Phase F.2 additions

Item 6 above is now superseded: Phase F.2 actually reviewed every page it
lists (via a 4-way research pass covering Commercial/Cost Control/Execution
&amp; Workforce/Compliance &amp; Documents &amp; Admin &amp; Portal) and fixed the
consistency gaps that survived verification — `Quotes.tsx` and `Invoices.tsx`
(previously hand-rolled, predating the shared UI kit) rebuilt on
`PageHeader`/`FinancialTable`/`Badge`/`MetricCard`; `Team.tsx`/`Settings.tsx`
given `PageHeader`/`ErrorState`/`Card`; `TaskPanel.tsx`/`DailyLogsPanel.tsx`
(used by Operations) given `Badge`/`EmptyState`/`Button`;
`PayrollPeriodDetail.tsx`'s `window.prompt()` reject flow replaced with an
in-app `Modal` form; IPC/Subcontract-IPC's "certify" action no longer shares
"رفض"'s danger styling; `FinancialTable` gained reusable sortable-header
support. Two audit suggestions were investigated and found to already match
established convention on closer inspection (not applied): `CostPlanSection`'s
per-tab primary-action placement mirrors `LaborCompliance.tsx`'s own
Tabs-without-header-action pattern, and `ActualCostSection`/`ForecastSection`'s
whole-page loading/error early-return (rather than passing error into
`FinancialTable`) is the same pattern `OverviewSection.tsx` uses deliberately
to avoid a misleading zero-value flash before data resolves.

**Genuinely deferred (not applied this phase):**

- `LaborCompliance.tsx` (6 list views — periods/snapshots/Nitaqat/GOSI/
  exceptions) and `ZatcaOnboardingPanel.tsx` (2 history lists) still hand-roll
  `<ul><li>` rows instead of the shared `Table` primitive. Each file is
  800–950 lines with no dedicated visual-regression coverage; converting all
  8 list views in one pass was judged higher-risk than warranted for a
  cosmetic table-primitive swap. Recommend converting one file at a time in
  a follow-up, verifying each in a real browser before moving to the next.
- The native `<input type="file">` control (Documents upload) renders its
  browser-default "Choose File" / "No file chosen" label in English inside
  an otherwise fully Arabic page. Fixing this requires a custom styled file
  -input component (a real primitive addition, not a class tweak) — out of
  scope for a UI-polish-only pass; candidate for a small dedicated
  `FileInput` primitive in a future phase.
- `CashFlowSection.tsx`'s "افتراضات الحساب" block still hand-builds its own
  `<dl>/<dt>/<dd>` row markup instead of reusing the `Field` helper already
  defined in `ForecastSection.tsx`/`IpcSection.tsx` — zero visual difference
  today (the markup is already identical), purely a code-dedup opportunity,
  not applied to avoid touching a working file for no user-visible gain.
