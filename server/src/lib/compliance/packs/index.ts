import type { CountryCode, CountryComplianceAdapter } from "../types.js";
import { saudiArabiaPack } from "./saudiArabia.js";
import { uaePack } from "./uae.js";
import { qatarPack } from "./qatar.js";
import { kuwaitPack } from "./kuwait.js";
import { bahrainPack } from "./bahrain.js";
import { omanPack } from "./oman.js";
import { moroccoPack } from "./morocco.js";

// The only place a country pack is registered. Adding a country means
// adding one import + one map entry here — nothing in engine.ts,
// overrides.ts, profile.ts, or routes/compliance.ts contains a single
// `if (countryCode === "SA")` anywhere; they all go through this registry.
const registry = new Map<CountryCode, CountryComplianceAdapter>();
for (const pack of [saudiArabiaPack, uaePack, qatarPack, kuwaitPack, bahrainPack, omanPack, moroccoPack]) {
  registry.set(pack.countryCode, pack);
}

export function registerCountryPack(adapter: CountryComplianceAdapter) {
  registry.set(adapter.countryCode, adapter);
}

export function getCountryPack(countryCode: CountryCode): CountryComplianceAdapter | undefined {
  return registry.get(countryCode);
}

export function listSupportedCountries(): CountryCode[] {
  return [...registry.keys()];
}
