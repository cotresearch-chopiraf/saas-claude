import { platformApiFetch } from "./platformClient";
import type { FeatureFlag, FeatureFlagOverride } from "./types";

export function listFeatureFlags(): Promise<{ flags: FeatureFlag[] }> {
  return platformApiFetch("/platform/feature-flags");
}

export function createFeatureFlag(input: {
  key: string;
  description: string;
  globalEnabled?: boolean;
  defaultEnabledForOrgs?: boolean;
  enabledEnvironments?: string[] | null;
}): Promise<FeatureFlag> {
  return platformApiFetch("/platform/feature-flags", { method: "POST", body: JSON.stringify(input) });
}

export function updateFeatureFlag(
  key: string,
  input: { description?: string; globalEnabled?: boolean; defaultEnabledForOrgs?: boolean; enabledEnvironments?: string[] | null },
): Promise<FeatureFlag> {
  return platformApiFetch(`/platform/feature-flags/${key}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function listFeatureFlagOverrides(key: string): Promise<{ overrides: FeatureFlagOverride[] }> {
  return platformApiFetch(`/platform/feature-flags/${key}/overrides`);
}

export function setFeatureFlagOverride(key: string, companyId: string, enabled: boolean): Promise<FeatureFlagOverride> {
  return platformApiFetch(`/platform/feature-flags/${key}/overrides/${companyId}`, { method: "PUT", body: JSON.stringify({ enabled }) });
}

export function clearFeatureFlagOverride(key: string, companyId: string): Promise<void> {
  return platformApiFetch(`/platform/feature-flags/${key}/overrides/${companyId}`, { method: "DELETE" });
}
