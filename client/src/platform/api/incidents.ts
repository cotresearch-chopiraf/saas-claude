import { platformApiFetch } from "./platformClient";
import type { Incident, IncidentSeverity, IncidentStatus } from "./types";

export function listIncidents(filter: { status?: IncidentStatus; companyId?: string } = {}): Promise<Incident[]> {
  const params = new URLSearchParams();
  if (filter.status) params.set("status", filter.status);
  if (filter.companyId) params.set("companyId", filter.companyId);
  const qs = params.toString();
  return platformApiFetch(`/platform/incidents${qs ? `?${qs}` : ""}`);
}

export function getIncident(id: string): Promise<Incident> {
  return platformApiFetch(`/platform/incidents/${id}`);
}

export function createIncident(input: {
  companyId?: string | null;
  title: string;
  description: string;
  severity: IncidentSeverity;
  affectedService: string;
  correlationId?: string;
}): Promise<Incident> {
  return platformApiFetch("/platform/incidents", { method: "POST", body: JSON.stringify(input) });
}

export function updateIncidentStatus(id: string, status: IncidentStatus, resolutionNotes?: string): Promise<Incident> {
  return platformApiFetch(`/platform/incidents/${id}/status`, { method: "PATCH", body: JSON.stringify({ status, resolutionNotes }) });
}
