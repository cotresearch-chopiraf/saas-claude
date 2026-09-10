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

RTL correctness was verified by code inspection (every new component uses
logical properties — `border-e`, `text-end`, `justify-end` — matching the
codebase's existing convention) and by the existing automated test suite's
`[dir="rtl"]` assertions. It was **not** verified by manually driving the app
in a real browser at each of desktop/laptop/tablet/mobile breakpoints (no
running dev server + browser session was exercised this phase). Recommend a
manual pass (or a Playwright visual-regression suite) before claiming full
responsive confidence.
