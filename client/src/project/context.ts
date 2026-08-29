import { useOutletContext } from "react-router-dom";
import type { Project } from "../api/types";

export interface ProjectOutletContext {
  project: Project | null;
  projectId: string;
}

// Every section route (project/sections.ts) renders inside
// ProjectWorkspace's <Outlet/> and can reach the already-loaded project
// record via this hook instead of re-fetching it.
export function useProjectContext(): ProjectOutletContext {
  return useOutletContext<ProjectOutletContext>();
}
