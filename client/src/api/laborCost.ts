import { apiFetch } from "./client";
import type { ProjectLaborCost } from "./types";

// Thin typed wrapper over the existing, verified read-only labor-cost
// visibility endpoint (server/src/routes/laborCost.ts). Reports the
// allocated total AND how much of it has actually been posted
// (postedTotal/unpostedTotal) — never a second Actual Cost source; see
// that route's own file comment.
export function getProjectLaborCost(projectId: string): Promise<ProjectLaborCost> {
  return apiFetch<ProjectLaborCost>(`/projects/${projectId}/labor-cost`);
}
