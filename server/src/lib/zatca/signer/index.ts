import { XadesZatcaSigner } from "./xadesZatcaSigner.js";
import type { ZatcaSigner } from "./types.js";

// Slice 5 continuation — real signer wired in. XadesZatcaSigner itself
// still fails honestly (ZatcaConfigurationError, never a fabricated
// signature) whenever a credential lacks a private key — true for every
// EGS unit onboarded before CSR/CSID issuance (task #51) actually
// persists one. See xadesZatcaSigner.ts's file comment for what "real"
// means here vs. what remains unverified against zatca.gov.sa.
export function getZatcaSigner(): ZatcaSigner {
  return new XadesZatcaSigner();
}

export * from "./types.js";
