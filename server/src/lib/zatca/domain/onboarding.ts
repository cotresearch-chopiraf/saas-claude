// Onboarding status (Slice 4) — a PURE, computed VIEW over data that
// already exists (company_tax_identifiers via domain/config.ts's identity,
// zatca_egs_units' own status/csidStatus/secretRef via domain/egsUnits.ts)
// — no new table, no new persisted state machine, no DB access in this
// file at all. Slice 3 deliberately kept status (EGS connection lifecycle)
// and csidStatus (CSID issuance lifecycle) as two separate real columns
// rather than one boolean; this file adds a third, read-only lens over the
// same facts for the specific "what should the tenant do next" question,
// and is never itself written back to the database.

export type ZatcaOnboardingStatus =
  | "not_configured"
  | "configuration_incomplete"
  | "ready_for_simulation"
  | "simulation_connected"
  | "simulation_failed"
  | "production_not_enabled";

export interface OnboardingIdentityInput {
  vatNumber: string | null;
  commercialRegistration: string | null;
}

export interface OnboardingEgsUnitInput {
  environment: "simulation" | "production";
  status: "not_onboarded" | "onboarding" | "active" | "revoked" | "deactivated";
  hasCredential: boolean;
}

export interface OnboardingStatusSummary {
  status: ZatcaOnboardingStatus;
  identityComplete: boolean;
  hasSimulationEgsUnit: boolean;
  hasProductionEgsUnit: boolean;
  simulationConnected: boolean;
  productionConnected: boolean;
}

export function computeOnboardingStatus(
  identity: OnboardingIdentityInput,
  egsUnits: OnboardingEgsUnitInput[],
): OnboardingStatusSummary {
  const identityComplete = Boolean(identity.vatNumber && identity.commercialRegistration);
  const simulationUnits = egsUnits.filter((u) => u.environment === "simulation");
  const productionUnits = egsUnits.filter((u) => u.environment === "production");
  const simulationConnected = simulationUnits.some((u) => u.status === "active");
  const productionConnected = productionUnits.some((u) => u.status === "active");

  let status: ZatcaOnboardingStatus;
  if (!identityComplete && egsUnits.length === 0) {
    status = "not_configured";
  } else if (!identityComplete || simulationUnits.length === 0) {
    status = "configuration_incomplete";
  } else if (simulationConnected) {
    status = productionUnits.length > 0 && !productionConnected ? "production_not_enabled" : "simulation_connected";
  } else if (simulationUnits.some((u) => u.status === "revoked")) {
    status = "simulation_failed";
  } else if (simulationUnits.some((u) => u.hasCredential && u.status !== "deactivated")) {
    status = "ready_for_simulation";
  } else {
    status = "configuration_incomplete";
  }

  return {
    status,
    identityComplete,
    hasSimulationEgsUnit: simulationUnits.length > 0,
    hasProductionEgsUnit: productionUnits.length > 0,
    simulationConnected,
    productionConnected,
  };
}
