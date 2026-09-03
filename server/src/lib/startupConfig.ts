// Slice Z — one authoritative startup-configuration check, replacing the
// prior behavior where a missing DATABASE_URL or JWT_SECRET let the
// process boot successfully and only fail on the first request that
// actually needed it (a misconfigured deployment looked "healthy" until a
// real user hit it). This module only names which required variable is
// missing — it never reads, logs, or returns the value of any variable,
// required or not.
//
// Deliberately narrow: only variables the production server genuinely
// cannot run without. This is not a place to invent new configuration
// requirements (e.g. ZATCA/CORS/PORT are all legitimately optional today —
// see .env.example — and stay that way here).
export class StartupConfigError extends Error {
  constructor(missing: string[]) {
    super(`Missing required environment variable(s): ${missing.join(", ")}`);
    this.name = "StartupConfigError";
  }
}

const REQUIRED_ENV_VARS = ["DATABASE_URL", "JWT_SECRET"] as const;

// Accepts an env object (defaults to process.env) so this stays a pure,
// isolated function callers can test directly against a fake env — never
// process.exit, never a global side effect, so it can't destabilize the
// rest of the suite.
export function validateStartupConfig(env: NodeJS.ProcessEnv = process.env): void {
  const missing = REQUIRED_ENV_VARS.filter((name) => !env[name] || env[name]!.trim() === "");
  if (missing.length > 0) {
    throw new StartupConfigError(missing);
  }
}
