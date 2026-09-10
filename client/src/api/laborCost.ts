import { apiFetch } from "./client";
import type { ProjectLaborCost } from "./types";

// Thin typed wrapper over the existing, verified read-only labor-cost
// visibility endpoint (server/src/routes/laborCost.ts). Always
// `posted: false` — this is pre-posting Labor Allocation data, never part
// of Actual Cost/Budget/Forecast. See that route's own file comment.
export function getProjectLaborCost(projectId: string): Promise<ProjectLaborCost> {
  return apiFetch<ProjectLaborCost>(`/projects/${projectId}/labor-cost`);
}
