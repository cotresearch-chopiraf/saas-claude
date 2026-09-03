import { describe, it, expect } from "vitest";
import { validateStartupConfig, StartupConfigError } from "../src/lib/startupConfig.js";

// Slice Z — pure-function tests against a fake env object; never touches
// the real process.env, so this can never destabilize any other test's
// configuration.
describe("Slice Z — startup configuration validation", () => {
  it("throws when DATABASE_URL is missing", () => {
    expect(() => validateStartupConfig({ JWT_SECRET: "a-real-secret" })).toThrow(StartupConfigError);
  });

  it("throws when JWT_SECRET is missing", () => {
    expect(() => validateStartupConfig({ DATABASE_URL: "postgres://user:pass@host:5432/db" })).toThrow(
      StartupConfigError,
    );
  });

  it("throws when both are missing, naming both in the error message", () => {
    try {
      validateStartupConfig({});
      throw new Error("expected validateStartupConfig to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(StartupConfigError);
      expect((err as Error).message).toContain("DATABASE_URL");
      expect((err as Error).message).toContain("JWT_SECRET");
    }
  });

  it("treats an empty-string value the same as a missing one", () => {
    expect(() => validateStartupConfig({ DATABASE_URL: "", JWT_SECRET: "   " })).toThrow(StartupConfigError);
  });

  it("succeeds when both required variables are present and non-empty", () => {
    expect(() =>
      validateStartupConfig({ DATABASE_URL: "postgres://user:pass@host:5432/db", JWT_SECRET: "a-real-secret" }),
    ).not.toThrow();
  });

  it("never includes the value of a present variable in a thrown error's message", () => {
    // Even in the missing-JWT_SECRET case, a real DATABASE_URL value must
    // never leak into the error text.
    const secretLookingDbUrl = "postgres://user:super-secret-password@host:5432/db";
    try {
      validateStartupConfig({ DATABASE_URL: secretLookingDbUrl });
    } catch (err) {
      expect((err as Error).message).not.toContain("super-secret-password");
      expect((err as Error).message).not.toContain(secretLookingDbUrl);
    }
  });
});
