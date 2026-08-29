import { roundMoney } from "./money.js";

// The one canonical Forecast (ETC/EAC) calculation for the whole product —
// see docs/MIDAD_FORECAST_MODEL.md for the full model. This function has no
// database access, no HTTP awareness, and no side effects: routes/forecast.ts
// is the only caller, and its entire job is collecting the four inputs below
// from their canonical sources, then handing them here. Never re-implement
// this formula anywhere else (a route, a test, a future UI component).

export type ForecastMethod = "cost_to_complete" | "commitment_aware";

export interface ForecastInputs {
  // BAC — Σ budgetItems.plannedAmount for the project. The Cost Plan
  // baseline; NOT contracts.revisedValue, NOT projects.budgetTotal.
  costPlan: number;
  // AC — Σ expenses.amount for the project, dated on/before the cutoff.
  actualCost: number;
  // Σ commitment amount for commitments that are active/partially_fulfilled
  // /closed (never draft/cancelled), as of the cutoff. See
  // routes/forecast.ts for exactly how this is computed and cut off.
  committedCost: number;
  // Certified IPC value as of the cutoff — contextual only, never blended
  // into the ETC/EAC arithmetic (see "Method C" in the docs for why).
  certifiedValue: number;
}

export interface ForecastCalculation extends ForecastInputs {
  method: ForecastMethod;
  // max(BAC - AC, 0) — how much of the plan has not yet been spent.
  // Method-independent: this is a property of the plan and actuals alone.
  remainingCost: number;
  etc: number;
  eac: number;
  // costPlan - eac. Positive = under plan, negative = over plan.
  variance: number;
  // (variance / costPlan) * 100, rounded. null when costPlan is 0 — a
  // percentage of zero is undefined, not zero; callers must handle null
  // explicitly rather than being handed a misleading 0.
  variancePercent: number | null;
}

export function calculateForecast(method: ForecastMethod, inputs: ForecastInputs): ForecastCalculation {
  const { costPlan, actualCost, committedCost, certifiedValue } = inputs;

  const remainingCost = Math.max(roundMoney(costPlan - actualCost), 0);

  let etc: number;
  let eac: number;
  if (method === "cost_to_complete") {
    // Method A — conservative baseline. Ignores commitments entirely: the
    // whole remaining plan is treated as still-to-be-spent, whether or not
    // part of it is already contractually committed.
    etc = remainingCost;
    eac = roundMoney(actualCost + etc);
  } else {
    // Method B — commitment-aware. The remaining plan net of what's
    // already committed is the only part still genuinely uncertain;
    // committedCost itself is added back in full so EAC still reflects the
    // full expected outflow (AC already spent + committedCost contractually
    // owed + the still-uncommitted remainder of the plan). This does not
    // double-count: committedCost and the uncommitted remainder are two
    // disjoint pieces of BAC, not two views of the same money.
    const etcUncommitted = Math.max(roundMoney(costPlan - actualCost - committedCost), 0);
    etc = etcUncommitted;
    eac = roundMoney(actualCost + committedCost + etcUncommitted);
  }

  const variance = roundMoney(costPlan - eac);
  const variancePercent = costPlan === 0 ? null : roundMoney((variance / costPlan) * 100);

  return {
    method,
    costPlan,
    actualCost,
    committedCost,
    certifiedValue,
    remainingCost,
    etc,
    eac,
    variance,
    variancePercent,
  };
}
