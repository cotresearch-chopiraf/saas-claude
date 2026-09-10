import { apiFetch } from "./client";
import type { ProjectSchedule, ProjectTask, ProjectTaskDependency } from "./types";

// MIDAD Phase C1 — thin typed wrappers over the verified Gantt Scheduling
// API (server/src/routes/projectSchedule.ts). No calculation, no
// authorization logic — the backend is the sole source of truth for
// hierarchy validity, date/progress bounds, and dependency-cycle rejection.

export function getProjectSchedule(projectId: string): Promise<ProjectSchedule> {
  return apiFetch<ProjectSchedule>(`/projects/${projectId}/schedule`);
}

export interface CreateTaskInput {
  name: string;
  description?: string;
  taskType?: "task" | "milestone";
  status?: ProjectTask["status"];
  startDate: string;
  endDate: string;
  progressPercent?: number;
  parentTaskId?: string | null;
  sortOrder?: number;
}

export function createProjectTask(projectId: string, input: CreateTaskInput): Promise<ProjectTask> {
  return apiFetch<ProjectTask>(`/projects/${projectId}/schedule/tasks`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export type UpdateTaskInput = Partial<CreateTaskInput>;

export function updateProjectTask(projectId: string, taskId: string, input: UpdateTaskInput): Promise<ProjectTask> {
  return apiFetch<ProjectTask>(`/projects/${projectId}/schedule/tasks/${taskId}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export function deleteProjectTask(projectId: string, taskId: string): Promise<void> {
  return apiFetch<void>(`/projects/${projectId}/schedule/tasks/${taskId}`, { method: "DELETE" });
}

export function createTaskDependency(
  projectId: string,
  predecessorTaskId: string,
  successorTaskId: string,
): Promise<ProjectTaskDependency> {
  return apiFetch<ProjectTaskDependency>(`/projects/${projectId}/schedule/dependencies`, {
    method: "POST",
    body: JSON.stringify({ predecessorTaskId, successorTaskId }),
  });
}

export function deleteTaskDependency(projectId: string, dependencyId: string): Promise<void> {
  return apiFetch<void>(`/projects/${projectId}/schedule/dependencies/${dependencyId}`, { method: "DELETE" });
}
