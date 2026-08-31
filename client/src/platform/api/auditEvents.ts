import { platformApiFetch } from "./platformClient";
import type { PlatformActivityPage } from "./types";

export function listPlatformActivity(limit = 20, offset = 0): Promise<PlatformActivityPage> {
  return platformApiFetch(`/platform/audit-events?limit=${limit}&offset=${offset}`);
}
