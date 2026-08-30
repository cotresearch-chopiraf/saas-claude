import { platformApiFetch } from "./platformClient";
import type { OrganizationPage } from "./types";

export function listOrganizations(limit = 20, offset = 0, search = ""): Promise<OrganizationPage> {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (search.trim()) params.set("search", search.trim());
  return platformApiFetch(`/platform/organizations?${params.toString()}`);
}
