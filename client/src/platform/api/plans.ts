import { platformApiFetch } from "./platformClient";
import type { Plan, PlanLimits } from "./types";

export function listPlans(): Promise<{ plans: Plan[] }> {
  return platformApiFetch("/platform/plans");
}

export function createPlan(input: { key: string; name: string; description?: string; isActive?: boolean; limits?: PlanLimits }): Promise<Plan> {
  return platformApiFetch("/platform/plans", { method: "POST", body: JSON.stringify(input) });
}

export function updatePlan(
  key: string,
  input: { name?: string; description?: string | null; isActive?: boolean; limits?: PlanLimits },
): Promise<Plan> {
  return platformApiFetch(`/platform/plans/${key}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function assignPlan(companyId: string, planKey: string | null): Promise<{ companyId: string; planId: string | null }> {
  return platformApiFetch(`/platform/plans/assignments/${companyId}`, { method: "PUT", body: JSON.stringify({ planKey }) });
}
