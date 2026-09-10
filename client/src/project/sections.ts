// Single source of truth for the project workspace's navigation — every
// later UI phase (UI-01..UI-05) plugs its real screen in by pointing an
// existing entry's `element` at a real component instead of ComingSoon;
// the route path, sidebar grouping, and active-state logic never need to
// change. See project/ProjectWorkspace.tsx / ProjectSidebar.tsx.
//
// `group` is purely a visual grouping label in the sidebar — it carries no
// financial meaning and must never be read as implying these domains
// share a calculation or a total. Cost Plan, Commitment, and Actual Cost
// sit in one visual group ("التكاليف") because they're all cost-side
// concepts an estimator/PM checks together, not because they are the same
// number — docs/MIDAD_FINANCIAL_MODEL.md's canonical separation is
// unchanged by this grouping.
export interface ProjectSection {
  key: string;
  path: string;
  label: string;
  group: string;
  // Reserved for a later phase to gate a section on a permission (e.g. an
  // owner-only section) — unused by any section today, since every
  // section listed here is either read-only or not yet a real screen.
  // Foundation only defines the shape; it introduces no new gating logic.
  permission?: string;
}

export const projectSectionGroups = ["المشروع", "الجدولة", "العقد والنطاق", "التكاليف", "التقدم", "التوقعات والتدفقات", "الإيرادات", "التشغيل", "المستندات"] as const;

export const projectSections: ProjectSection[] = [
  { key: "overview", path: "overview", label: "نظرة عامة", group: "المشروع" },
  // MIDAD Phase C1 — Gantt Scheduling Foundation. Its own group ("الجدولة"),
  // deliberately separate from "التقدم" (which is Measurement/IPC physical
  // quantity progress — a different concept from schedule task progress,
  // per this phase's own explicit no-conflation requirement).
  { key: "schedule", path: "schedule", label: "الجدول الزمني", group: "الجدولة" },
  { key: "contract", path: "contract", label: "العقد", group: "العقد والنطاق" },
  { key: "boq", path: "boq", label: "جدول الكميات", group: "العقد والنطاق" },
  { key: "cost-plan", path: "cost-plan", label: "خطة التكلفة", group: "التكاليف" },
  { key: "procurement", path: "procurement", label: "المشتريات والالتزامات", group: "التكاليف" },
  { key: "actual-cost", path: "actual-cost", label: "التكلفة الفعلية", group: "التكاليف" },
  { key: "progress", path: "progress", label: "القياسات", group: "التقدم" },
  { key: "ipc", path: "ipc", label: "شهادات الدفع (IPC)", group: "التقدم" },
  { key: "forecast", path: "forecast", label: "التوقعات المالية", group: "التوقعات والتدفقات" },
  { key: "cash-flow", path: "cash-flow", label: "التدفق النقدي", group: "التوقعات والتدفقات" },
  { key: "invoices", path: "invoices", label: "الفواتير", group: "الإيرادات" },
  { key: "operations", path: "operations", label: "المهام والسجل اليومي", group: "التشغيل" },
  // MIDAD Phase C2 — Punch Lists / Site Deficiencies. Alongside "operations"
  // in the same field-level group — a punch item is site observation/
  // deficiency tracking, the same operational class as Tasks/Daily Log,
  // not scheduling (C1) or financial progress (التقدم).
  { key: "punch-list", path: "punch-list", label: "قائمة الملاحظات", group: "التشغيل" },
  { key: "documents", path: "documents", label: "المستندات", group: "المستندات" },
];

// Deliberately outside projectSections/projectSectionGroups: this is the
// pre-MIDAD flat budget/expense + change-order UI, still fully backed by
// its original working API, kept reachable so no existing functionality
// is lost — but visually separated in the sidebar (see ProjectSidebar.tsx)
// and never presented as the canonical Cost Plan, so it can never be
// mistaken for the "cost-plan" placeholder above once that becomes real.
export const legacySection = { key: "legacy-budget", path: "legacy-budget", label: "الميزانية والمصروفات (النموذج السابق)" };
