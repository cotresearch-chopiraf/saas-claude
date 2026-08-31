import { describe, it, expect } from "vitest";
import { DevInMemorySecretStore } from "../src/lib/zatca/secretStore/devSecretStore.js";

// MIDAD ZATCA Slice 3 — the dev-only in-memory ZatcaSecretStore. No
// database, no HTTP — pure unit tests of tenant scoping and round-tripping.

describe("DevInMemorySecretStore", () => {
  it("round-trips a stored secret for the owning company", async () => {
    const store = new DevInMemorySecretStore();
    const ref = await store.put("company-a", "egs-1", { binarySecurityToken: "tok", secret: "sec" });
    expect(await store.resolve("company-a", ref)).toEqual({ binarySecurityToken: "tok", secret: "sec" });
  });

  it("TENANT ISOLATION: a different company cannot resolve another company's secretRef", async () => {
    const store = new DevInMemorySecretStore();
    const ref = await store.put("company-a", "egs-1", { binarySecurityToken: "tok", secret: "sec" });
    expect(await store.resolve("company-b", ref)).toBeNull();
  });

  it("returns null for an unknown reference", async () => {
    const store = new DevInMemorySecretStore();
    expect(await store.resolve("company-a", "dev:does-not-exist")).toBeNull();
  });

  it("delete is a no-op for a different company and does not affect the real owner's secret", async () => {
    const store = new DevInMemorySecretStore();
    const ref = await store.put("company-a", "egs-1", { binarySecurityToken: "tok", secret: "sec" });
    await store.delete("company-b", ref);
    expect(await store.resolve("company-a", ref)).not.toBeNull();
  });

  it("delete by the owning company removes the secret", async () => {
    const store = new DevInMemorySecretStore();
    const ref = await store.put("company-a", "egs-1", { binarySecurityToken: "tok", secret: "sec" });
    await store.delete("company-a", ref);
    expect(await store.resolve("company-a", ref)).toBeNull();
  });

  it("re-putting for the same egsUnitId returns a new reference and keeps both resolvable until deleted", async () => {
    const store = new DevInMemorySecretStore();
    const ref1 = await store.put("company-a", "egs-1", { binarySecurityToken: "t1", secret: "s1" });
    const ref2 = await store.put("company-a", "egs-1", { binarySecurityToken: "t2", secret: "s2" });
    expect(ref1).not.toBe(ref2);
    expect(await store.resolve("company-a", ref1)).toEqual({ binarySecurityToken: "t1", secret: "s1" });
    expect(await store.resolve("company-a", ref2)).toEqual({ binarySecurityToken: "t2", secret: "s2" });
  });

  it("the returned reference never embeds the raw secret material", async () => {
    const store = new DevInMemorySecretStore();
    const ref = await store.put("company-a", "egs-1", {
      binarySecurityToken: "SUPER-SECRET-TOKEN-VALUE",
      secret: "SUPER-SECRET-PASSWORD-VALUE",
    });
    expect(ref).not.toContain("SUPER-SECRET-TOKEN-VALUE");
    expect(ref).not.toContain("SUPER-SECRET-PASSWORD-VALUE");
  });
});
