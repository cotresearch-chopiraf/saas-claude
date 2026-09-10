import { portalApiFetch } from "./portalClient";
import type { PortalProject } from "./types";

// Thin typed wrappers over the existing, verified Client Portal project
// API (server/src/routes/clientPortalProjects.ts) — no calculation, no
// authorization logic. The server derives access entirely from the
// authenticated Client Portal identity's own grants; no companyId or
// projectId filter is ever sent by the caller beyond the one project id
// the client already knows (from its own project list).

export function listPortalProjects(): Promise<PortalProject[]> {
  return portalApiFetch<PortalProject[]>("/portal/projects");
}

export function getPortalProject(projectId: string): Promise<PortalProject> {
  return portalApiFetch<PortalProject>(`/portal/projects/${projectId}`);
}
