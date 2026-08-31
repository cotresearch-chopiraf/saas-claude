import { platformApiFetch } from "./platformClient";
import type { PlatformZatcaSummary } from "./types";

export function getPlatformZatcaSummary(): Promise<PlatformZatcaSummary> {
  return platformApiFetch<PlatformZatcaSummary>("/platform/zatca");
}
