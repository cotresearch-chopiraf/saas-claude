import { NotImplementedSigner } from "./notImplementedSigner.js";
import type { ZatcaSigner } from "./types.js";

export function getZatcaSigner(): ZatcaSigner {
  return new NotImplementedSigner();
}

export * from "./types.js";
