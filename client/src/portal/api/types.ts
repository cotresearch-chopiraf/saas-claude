// MIDAD Phase B1/B2 — Client Portal — kept out of ../../api/types.ts on
// purpose, same reasoning as ../../platform/api/types.ts: a
// ClientPortalUser is not a tenant User, and a PortalProject here is a
// deliberately reduced, client-safe view of Project (matching exactly
// what server/src/routes/clientPortalProjects.ts returns) — never the
// full internal Project shape, and none of these types should ever be
// reachable from tenant-side or platform-side code.

export interface ClientPortalUser {
  id: string;
  name: string;
  email: string;
}

export type PortalProjectStatus = "active" | "on_hold" | "completed";

export interface PortalProject {
  id: string;
  name: string;
  status: PortalProjectStatus;
  startDate: string | null;
  clientName: string | null;
  address: string | null;
}
