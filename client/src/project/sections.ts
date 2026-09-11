// Single source of truth for the project workspace's navigation — every
// later UI phase (UI-01..UI-05) plugs its real screen in by pointing an
// existing entry's `element` at a real component instead of ComingSoon;
// the route path, sidebar grouping, and active-state logic never need to
// change. See project/ProjectWorkspace.tsx / ProjectSidebar.tsx.
//
// `group` is purely a visual grouping label in the sidebar — it carries no
// financial meaning and must never be read as implying these domains
// share a calculation or a total. Cost Plan, Contract, and BOQ sit in one
// visual group ("التجاري") because they're all "what was agreed" concepts a
// PM/estimator checks together, not because they are the same number —
// docs/MIDAD_FINANCIAL_MODEL.md's canonical separation is unchanged by
// this grouping.
export interface ProjectSection {
  key: string;
  path: string;
  // Dot-path suffix under the i18n `project.sections.*` / `project.groups.*`
  // trees (see client/src/i18n/translations/*.ts) — not display text itself,
  // so the sidebar always renders in the user's current language.
  group: string;
  // Reserved for a later phase to gate a section on a permission (e.g. an
  // owner-only section) — unused by any section today, since every
  // section listed here is either read-only or not yet a real screen.
  // Foundation only defines the shape; it introduces no new gating logic.
  permission?: string;
}

// MIDAD Phase F — UX/IA consolidation. Previously 9 separate groups (one
// per feature-addition phase — "الجدولة" for C1, "التشغيل" for C2, etc.),
// which read as the order features were BUILT rather than how a user
// actually thinks about a project. Consolidated to 5 groups matching how a
// PM/estimator/financial controller actually scans a project: Overview,
// Commercial (what was agreed), Cost Control (what it's costing/will
// cost), Execution (site/field activity), Commercial Documents (billing
// instruments). This is a label/grouping change ONLY — every key, path,
// and the section list itself is otherwise unchanged; no route, no
// permission, no financial calculation is touched.
export const projectSectionGroups = ["overview", "commercial", "costControl", "execution", "commercialDocuments"] as const;

export const projectSections: ProjectSection[] = [
  { key: "overview", path: "overview", group: "overview" },
  { key: "contract", path: "contract", group: "commercial" },
  { key: "boq", path: "boq", group: "commercial" },
  { key: "cost-plan", path: "cost-plan", group: "commercial" },
  { key: "actual-cost", path: "actual-cost", group: "costControl" },
  { key: "procurement", path: "procurement", group: "costControl" },
  { key: "forecast", path: "forecast", group: "costControl" },
  { key: "cash-flow", path: "cash-flow", group: "costControl" },
  { key: "progress", path: "progress", group: "execution" },
  // MIDAD Phase C1 — Gantt Scheduling Foundation. Deliberately not
  // conflated with "progress" above (Measurement/IPC physical-quantity
  // progress is a different concept from schedule task progress) — the two
  // stay separate section entries, simply grouped together visually under
  // "execution" since both are field/execution concerns a PM checks
  // together.
  { key: "schedule", path: "schedule", group: "execution" },
  { key: "operations", path: "operations", group: "execution" },
  // MIDAD Phase C2 — Punch Lists / Site Deficiencies. Alongside operations/
  // schedule — a punch item is site observation/deficiency tracking, the
  // same field-execution class.
  { key: "punch-list", path: "punch-list", group: "execution" },
  { key: "ipc", path: "ipc", group: "commercialDocuments" },
  { key: "invoices", path: "invoices", group: "commercialDocuments" },
  { key: "documents", path: "documents", group: "commercialDocuments" },
];

// Deliberately outside projectSections/projectSectionGroups: this is the
// pre-MIDAD flat budget/expense + change-order UI, still fully backed by
// its original working API, kept reachable so no existing functionality
// is lost — but visually separated in the sidebar (see ProjectSidebar.tsx)
// and never presented as the canonical Cost Plan, so it can never be
// mistaken for the "cost-plan" placeholder above once that becomes real.
// `labelKey` is looked up under `project.legacyBudget` in the i18n dict.
export const legacySection = { key: "legacy-budget", path: "legacy-budget", labelKey: "legacyBudget" };
