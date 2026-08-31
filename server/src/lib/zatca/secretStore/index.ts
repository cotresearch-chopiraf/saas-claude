import { DevInMemorySecretStore } from "./devSecretStore.js";
import type { ZatcaSecretStore } from "./types.js";

// Process-lifetime singleton — the in-memory dev store must be the SAME
// instance across every request, or a secret stored by one request would
// be unresolvable by the next. Swap the implementation constructed here
// when a real production ZatcaSecretStore exists; nothing else changes.
let singleton: ZatcaSecretStore | undefined;

export function getZatcaSecretStore(): ZatcaSecretStore {
  if (!singleton) singleton = new DevInMemorySecretStore();
  return singleton;
}

export * from "./types.js";
