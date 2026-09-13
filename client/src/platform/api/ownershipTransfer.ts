import { platformApiFetch } from "./platformClient";
import type { OwnershipTransferCandidate, OwnershipTransferResult } from "./types";

export function listOwnershipTransferCandidates(): Promise<{ operators: OwnershipTransferCandidate[] }> {
  return platformApiFetch("/platform/ownership-transfer/operators");
}

export function transferOwnership(input: { newOwnerOperatorId: string; confirmationEmail: string; reason: string }): Promise<OwnershipTransferResult> {
  return platformApiFetch("/platform/ownership-transfer", { method: "POST", body: JSON.stringify(input) });
}
