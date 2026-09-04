import { DevInMemorySecretStore } from "./devSecretStore.js";
import { AwsSecretsManagerZatcaSecretStore } from "./awsSecretsManagerStore.js";
import { ZatcaConfigurationError } from "../errors.js";
import type { ZatcaSecretStore } from "./types.js";

// Process-lifetime singleton — the in-memory dev store must be the SAME
// instance across every request, or a secret stored by one request would
// be unresolvable by the next. Swap the implementation constructed here
// when a real production ZatcaSecretStore exists; nothing else changes.
let singleton: ZatcaSecretStore | undefined;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new ZatcaConfigurationError(`ZATCA_SECRET_STORE_PROVIDER=aws-secrets-manager requires ${name} to be set`);
  }
  return value;
}

// Slice 5 — production-safety guard. This codebase has no other NODE_ENV
// check anywhere (confirmed by a fresh grep before adding this), but the
// existing deployment target (vercel.json) sets NODE_ENV=production for
// real deployments, making this a genuine, meaningful signal here rather
// than an invented convention. DevInMemorySecretStore silently losing
// every credential on a restart (see its own file comment) is a
// development convenience that must never run unnoticed in production —
// so a real production deployment with no real ZatcaSecretStore wired in
// fails loudly, the first time any route touches it, rather than quietly
// serving from memory. ZATCA_ALLOW_DEV_SECRET_STORE is an explicit,
// deliberate escape hatch (e.g. a staging environment that sets
// NODE_ENV=production for other reasons) — never set by default.
// Exported so tests can exercise the guard's decision logic directly,
// without needing to defeat getZatcaSecretStore()'s module-lifetime
// singleton via module-registry resets.
export function assertSecretStoreSafeForEnvironment(): void {
  const isProduction = process.env.NODE_ENV === "production";
  const explicitlyAllowed = process.env.ZATCA_ALLOW_DEV_SECRET_STORE === "true";
  if (isProduction && !explicitlyAllowed) {
    throw new ZatcaConfigurationError(
      "No production ZatcaSecretStore is configured (NODE_ENV=production). DevInMemorySecretStore must never run " +
        "unnoticed in production — it loses every credential on restart and was never meant to be durable. " +
        "Implement a real ZatcaSecretStore (see lib/zatca/secretStore/types.ts) and wire it in here, or set " +
        "ZATCA_ALLOW_DEV_SECRET_STORE=true if this NODE_ENV=production environment is deliberately non-production.",
    );
  }
}

// Slice AB Scope A — an explicit ZATCA_SECRET_STORE_PROVIDER=aws-secrets-manager
// is an informed operator choice, exactly like Slice AA's mailer/storage
// providers: it bypasses assertSecretStoreSafeForEnvironment() entirely
// (there is nothing unsafe to guard against — this IS the durable
// production store the guard exists to demand), and is honored in every
// NODE_ENV, not just production, so a staging/CI environment can also opt
// into it deliberately. No explicit provider set falls through to the
// existing, unchanged guard behavior below.
export function getZatcaSecretStore(): ZatcaSecretStore {
  if (!singleton) {
    const explicitProvider = process.env.ZATCA_SECRET_STORE_PROVIDER;
    if (explicitProvider === "aws-secrets-manager") {
      singleton = new AwsSecretsManagerZatcaSecretStore({
        region: requireEnv("ZATCA_SECRETS_MANAGER_REGION"),
        accessKeyId: requireEnv("ZATCA_SECRETS_MANAGER_ACCESS_KEY_ID"),
        secretAccessKey: requireEnv("ZATCA_SECRETS_MANAGER_SECRET_ACCESS_KEY"),
        keyPrefix: process.env.ZATCA_SECRETS_MANAGER_KEY_PREFIX || undefined,
      });
      return singleton;
    }

    assertSecretStoreSafeForEnvironment();
    singleton = new DevInMemorySecretStore();
  }
  return singleton;
}

export * from "./types.js";
