import { platformApiFetch } from "./platformClient";
import type { OrganizationPage } from "./types";

export function listOrganizations(limit = 20, offset = 0): Promise<OrganizationPage> {
  return platformApiFetch(`/platform/organizations?limit=${limit}&offset=${offset}`);
}
