import { describe, it, expect, afterEach, vi } from "vitest";
import { assertSecretStoreSafeForEnvironment } from "../src/lib/zatca/secretStore/index.js";
import { ZatcaConfigurationError } from "../src/lib/zatca/errors.js";

// MIDAD ZATCA Slice 5 — production-safety guard for the dev-only in-memory
// ZatcaSecretStore. Tests the guard's decision function directly (see its
// own export comment for why), plus one end-to-end test proving
// getZatcaSecretStore() itself actually enforces it.

const originalNodeEnv = process.env.NODE_ENV;
const originalAllowFlag = process.env.ZATCA_ALLOW_DEV_SECRET_STORE;

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalAllowFlag === undefined) delete process.env.ZATCA_ALLOW_DEV_SECRET_STORE;
  else process.env.ZATCA_ALLOW_DEV_SECRET_STORE = originalAllowFlag;
});

describe("assertSecretStoreSafeForEnvironment", () => {
  it("does not throw when NODE_ENV is unset (matches this environment's actual default)", () => {
    delete process.env.NODE_ENV;
    expect(() => assertSecretStoreSafeForEnvironment()).not.toThrow();
  });

  it("does not throw for a non-production NODE_ENV (e.g. development/test)", () => {
    process.env.NODE_ENV = "development";
    expect(() => assertSecretStoreSafeForEnvironment()).not.toThrow();
  });

  it("throws ZatcaConfigurationError when NODE_ENV=production with no escape hatch set", () => {
    process.env.NODE_ENV = "production";
    delete process.env.ZATCA_ALLOW_DEV_SECRET_STORE;
    expect(() => assertSecretStoreSafeForEnvironment()).toThrow(ZatcaConfigurationError);
  });

  it("the production error message never references any real secret value (there is none yet -- it's a pure config-state message)", () => {
    process.env.NODE_ENV = "production";
    delete process.env.ZATCA_ALLOW_DEV_SECRET_STORE;
    try {
      assertSecretStoreSafeForEnvironment();
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ZatcaConfigurationError);
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain("production");
      expect(message).toContain("ZATCA_ALLOW_DEV_SECRET_STORE");
    }
  });

  it("does NOT throw when NODE_ENV=production AND the explicit escape hatch is set", () => {
    process.env.NODE_ENV = "production";
    process.env.ZATCA_ALLOW_DEV_SECRET_STORE = "true";
    expect(() => assertSecretStoreSafeForEnvironment()).not.toThrow();
  });

  it("does NOT silently allow a non-'true' escape-hatch value to bypass the guard (no truthy-string coercion)", () => {
    process.env.NODE_ENV = "production";
    process.env.ZATCA_ALLOW_DEV_SECRET_STORE = "yes"; // not the exact string "true"
    expect(() => assertSecretStoreSafeForEnvironment()).toThrow(ZatcaConfigurationError);
  });
});

describe("getZatcaSecretStore() end-to-end (fresh module instance)", () => {
  it("throws before ever constructing a store when NODE_ENV=production", async () => {
    vi.resetModules();
    process.env.NODE_ENV = "production";
    delete process.env.ZATCA_ALLOW_DEV_SECRET_STORE;
    // Both re-imported fresh from the SAME reset module graph -- vi.resetModules()
    // gives errors.js a new identity too, so the statically-imported
    // ZatcaConfigurationError class above would fail an instanceof check
    // against an error thrown by this fresh graph even though it's
    // functionally the same error.
    const fresh = await import("../src/lib/zatca/secretStore/index.js");
    const freshErrors = await import("../src/lib/zatca/errors.js");
    expect(() => fresh.getZatcaSecretStore()).toThrow(freshErrors.ZatcaConfigurationError);
  });

  it("returns a working store when NODE_ENV is not production", async () => {
    vi.resetModules();
    delete process.env.NODE_ENV;
    const fresh = await import("../src/lib/zatca/secretStore/index.js");
    const store = fresh.getZatcaSecretStore();
    const ref = await store.put("company-x", "egs-x", { binarySecurityToken: "t", secret: "s" });
    expect(await store.resolve("company-x", ref)).toEqual({ binarySecurityToken: "t", secret: "s" });
  });
});
