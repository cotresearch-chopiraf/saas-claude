// Provider barrel + the one factory function domain/routes code should
// call — never `new FatooraProvider(...)` directly outside this file, so a
// future alternate implementation (e.g. a recorded-fixture provider for
// tests) is a one-line change here rather than a hunt across call sites.

import { FatooraProvider } from "./fatooraProvider.js";
import type { ZatcaEnvironmentName, ZatcaProvider } from "./types.js";

export function getZatcaProvider(environment: ZatcaEnvironmentName): ZatcaProvider {
  return new FatooraProvider(environment);
}

export * from "./types.js";
