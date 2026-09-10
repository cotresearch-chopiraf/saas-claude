import { roundMoney } from "./money.js";

// MIDAD Phase E — the deterministic Budget Alert rule engine. Same
// architectural discipline as lib/forecast.ts: this module has no database
// access, no HTTP awareness, and no side effects. routes/budgetAlerts.ts is
// the only caller, and its job is collecting inputs from the existing
// canonical financial sources (reusing routes/forecast.ts's own
// collectForecastInputs/calculateForecast — never re-deriving Budget/Actual
// Cost/Commitments/Forecast independently), then handing them here.
//
// 100% deterministic — no AI, no ML, no external API of any kind, per the
// master prompt's explicit "NO AI" requirement. Every threshold below is an
// explicit, documented constant; no threshold-configuration convention
// exists elsewhere in this codebase (checked: no company/project settings
// table carries anything alert- or threshold-shaped), so these are defined
// here and are never accepted from the frontend as calculation input.

export type BudgetAlertRuleCode =
  | "budget_consumption_threshold"
  | "forecast_over_budget"
  | "actual_commitments_over_budget"
  | "cost_code_risk";

export type BudgetAlertSeverity = "info" | "warning" | "critical";

export interface AlertHit {
  ruleCode: BudgetAlertRuleCode;
  severity: BudgetAlertSeverity;
  metricType: string;
  metricValue: number;
  thresholdValue: number;
  title: string;
  description: string;
  recommendedAction: string;
}

// Rule 1 / Rule 4 share this exact three-tier consumption schedule — see
// each rule's own comment for why reusing one documented schedule (rather
// than inventing a second one for cost codes) is the deliberate choice.
export const CONSUMPTION_INFO_PERCENT = 80;
export const CONSUMPTION_WARNING_PERCENT = 90;
export const CONSUMPTION_CRITICAL_PERCENT = 100;

// Rule 2's own magnitude threshold: how far EAC must exceed the budget,
// in percent of budget, before the alert escalates from WARNING to
// CRITICAL. A single documented constant, not "complicated severity
// mathematics" — deliberately simple per the master prompt's instruction.
export const FORECAST_OVERRUN_CRITICAL_PERCENT = 10;

function consumptionSeverity(percent: number): BudgetAlertSeverity | null {
  if (percent >= CONSUMPTION_CRITICAL_PERCENT) return "critical";
  if (percent >= CONSUMPTION_WARNING_PERCENT) return "warning";
  if (percent >= CONSUMPTION_INFO_PERCENT) return "info";
  return null;
}

function consumptionThresholdFor(severity: BudgetAlertSeverity): number {
  if (severity === "critical") return CONSUMPTION_CRITICAL_PERCENT;
  if (severity === "warning") return CONSUMPTION_WARNING_PERCENT;
  return CONSUMPTION_INFO_PERCENT;
}

// Rule 1 — Budget Consumption Threshold: (actual + commitments) / budget * 100.
// Skips entirely (returns null) when budget <= 0 — a zero/missing budget
// must never divide by zero or be treated as "already exceeded."
export function evaluateBudgetConsumptionRule(input: { budget: number; actual: number; committed: number }): AlertHit | null {
  if (input.budget <= 0) return null;
  const percent = roundMoney(((input.actual + input.committed) / input.budget) * 100);
  const severity = consumptionSeverity(percent);
  if (!severity) return null;

  const threshold = consumptionThresholdFor(severity);
  return {
    ruleCode: "budget_consumption_threshold",
    severity,
    metricType: "budget_consumption_percent",
    metricValue: percent,
    thresholdValue: threshold,
    title: `استهلاك الميزانية وصل إلى ${percent}%`,
    description: `بلغت التكلفة الفعلية والالتزامات مجتمعة ${percent}% من الميزانية المعتمدة (العتبة: ${threshold}%). استهلاك الميزانية مرتفع ويحتاج إلى مراجعة.`,
    recommendedAction:
      severity === "critical"
        ? "أوقف الاعتمادات غير الضرورية وراجع الميزانية فوراً مع الإدارة."
        : severity === "warning"
          ? "راجع الالتزامات المفتوحة وتوقع التكلفة المتبقية قبل اعتماد مصروفات إضافية."
          : "راجع وتيرة الصرف الحالية واستعد لمراجعة الميزانية إذا استمر الاتجاه.",
  };
}

// Rule 2 — Forecast EAC > Approved Budget. eac/variancePercent come from
// lib/forecast.ts's own calculateForecast("commitment_aware", ...) — never
// recomputed here. variancePercent is null when budget is 0 (calculateForecast's
// own "a percentage of zero is undefined" rule) — this rule skips in that case.
export function evaluateForecastOverBudgetRule(input: { budget: number; eac: number; variancePercent: number | null }): AlertHit | null {
  if (input.variancePercent === null) return null;
  if (input.eac <= input.budget) return null;

  // variancePercent = (budget - eac) / budget * 100, so it is negative when
  // eac > budget; its magnitude is exactly "percent over budget."
  const overPercent = roundMoney(-input.variancePercent);
  const severity: BudgetAlertSeverity = overPercent >= FORECAST_OVERRUN_CRITICAL_PERCENT ? "critical" : "warning";

  return {
    ruleCode: "forecast_over_budget",
    severity,
    metricType: "forecast_eac_over_budget_percent",
    metricValue: overPercent,
    thresholdValue: 0,
    title: "التوقع الحالي يتجاوز الميزانية المعتمدة",
    description: `القيمة المتوقعة عند الإنجاز (EAC) تتجاوز الميزانية المعتمدة للمشروع بنسبة ${overPercent}%.`,
    recommendedAction: "راجع افتراضات التوقع والتكلفة المتبقية لتحديد سبب تجاوز التوقع للميزانية المعتمدة.",
  };
}

// Rule 3 — Actual + Commitments > Approved Budget. A stronger signal than
// Rule 1's consumption threshold: the committed/actual exposure has already
// exceeded the approved budget outright, not merely approached it — always
// CRITICAL, matching the master prompt's own worked example exactly (no
// invented magnitude sub-tiers).
export function evaluateActualCommitmentsOverBudgetRule(input: { budget: number; actual: number; committed: number }): AlertHit | null {
  if (input.budget <= 0) return null;
  const exposure = roundMoney(input.actual + input.committed);
  if (exposure <= input.budget) return null;

  const variance = roundMoney(exposure - input.budget);
  return {
    ruleCode: "actual_commitments_over_budget",
    severity: "critical",
    metricType: "exposure_over_budget_amount",
    metricValue: variance,
    thresholdValue: 0,
    title: "التكلفة الفعلية والالتزامات تجاوزت الميزانية المعتمدة",
    description: "مجموع التكلفة الفعلية والالتزامات التعاقدية تجاوز الميزانية المعتمدة لهذا المشروع.",
    recommendedAction: "راجع الالتزامات المفتوحة فوراً — التكلفة الفعلية والالتزامات مجتمعة تجاوزت الميزانية المعتمدة بالفعل.",
  };
}

// Rule 4 — Cost Code Risk. Identical consumption math to Rule 1, scoped to
// one cost code's own budget (Σ budgetItems.plannedAmount WHERE costCodeId =
// X) instead of the whole project. Reuses the SAME documented thresholds —
// a second invented threshold schedule for cost codes would be exactly the
// kind of ungrounded math the master prompt warns against. Skips (null)
// when the cost code has no budget mapped to it (costCodeBudget <= 0) —
// never fabricates a denominator.
export function evaluateCostCodeRiskRule(input: { costCodeBudget: number; costCodeActual: number; costCodeCommitted: number }): AlertHit | null {
  if (input.costCodeBudget <= 0) return null;
  const percent = roundMoney(((input.costCodeActual + input.costCodeCommitted) / input.costCodeBudget) * 100);
  const severity = consumptionSeverity(percent);
  if (!severity) return null;

  const threshold = consumptionThresholdFor(severity);
  return {
    ruleCode: "cost_code_risk",
    severity,
    metricType: "cost_code_consumption_percent",
    metricValue: percent,
    thresholdValue: threshold,
    title: "استهلاك مرتفع على بند تكلفة محدد",
    description: `بلغ استهلاك بند التكلفة (فعلي + التزامات) ${percent}% من ميزانيته المخصصة (العتبة: ${threshold}%).`,
    recommendedAction: "راجع بند التكلفة المحدد ومقارنته بميزانيته المخصصة قبل الاستمرار في الإنفاق عليه.",
  };
}

// Deterministic dedup key: rule + scope (project or cost code) + severity
// TIER. A new key only when the threshold tier itself changes (e.g.
// info -> warning -> critical), so repeated evaluation at an unchanged
// severity never creates a duplicate, while a genuine escalation always
// does. Never includes a timestamp or a raw metric value — either would
// defeat deduplication.
export function buildDeduplicationKey(hit: AlertHit, costCodeId: string | null): string {
  return `${hit.ruleCode}:${costCodeId ?? "project"}:${hit.severity}`;
}

// Rule 5 (Burn Rate) is intentionally NOT implemented. This codebase's own
// Cash Flow domain (routes/cashflow.ts) already explicitly declined to
// build any date-range/time-phased projection because "the current data
// model has no time-phasing mechanism for Commitment/Expense/ETC" (see that
// file's own `advanceLimitation`/assumptions comments and
// docs/MIDAD_CASHFLOW_MODEL.md) — a burn-rate calculation fundamentally
// requires phasing spend over time, the exact capability that domain
// already documented as unsupported. Implementing it here would invent the
// same "fake precision" the codebase has already explicitly rejected
// elsewhere, not derive it from genuinely reliable historical data.
//
// Rule 6 (Consumption Ahead of Progress) is intentionally NOT implemented.
// No authoritative single project-level physical progress percentage
// exists anywhere in this codebase: measurements.ts/sumApprovedQuantity
// only gives a per-BOQ-item cumulative approved quantity, never a project
// rollup; projectTasks.progressPercent (Phase C1/Gantt) is an unrelated,
// separately-scoped task-planning field, not a financial/physical progress
// metric. Fabricating a rollup here (e.g. averaging BOQ-item percentages)
// would be exactly the invented single metric the master prompt explicitly
// forbids ("Do not invent a single authoritative project progress
// percentage").
