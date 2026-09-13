import { platformApiFetch } from "./platformClient";
import type { HandoverSummary } from "./types";

export function getHandoverSummary(): Promise<HandoverSummary> {
  return platformApiFetch("/platform/handover/summary");
}
