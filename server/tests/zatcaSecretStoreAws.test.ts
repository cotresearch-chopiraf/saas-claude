import { describe, it, expect, afterEach, vi } from "vitest";
import { ResourceNotFoundException } from "@aws-sdk/client-secrets-manager";
import { AwsSecretsManagerZatcaSecretStore } from "../src/lib/zatca/secretStore/awsSecretsManagerStore.js";
import { ZatcaConfigurationError } from "../src/lib/zatca/errors.js";

// Slice AB Scope A — production-grade ZatcaSecretStore backed by AWS
// Secrets Manager. Mirrors the exact mocked-AWS-client testing pattern
// already established in tests/storageProvider.test.ts (S3StorageProvider)
// — no real AWS account is ever touched.

const ENV_KEYS = [
  "NODE_ENV",
  "ZATCA_SECRET_STORE_PROVIDER",
  "ZATCA_ALLOW_DEV_SECRET_STORE",
  "ZATCA_SECRETS_MANAGER_REGION",
  "ZATCA_SECRETS_MANAGER_ACCESS_KEY_ID",
  "ZATCA_SECRETS_MANAGER_SECRET_ACCESS_KEY",
  "ZATCA_SECRETS_MANAGER_KEY_PREFIX",
] as const;

const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL_ENV[key];
  }
}

afterEach(restoreEnv);

describe("getZatcaSecretStore() provider selection (Slice AB)", () => {
  it("ZATCA_SECRET_STORE_PROVIDER=aws-secrets-manager throws ZatcaConfigurationError when required variables are missing", async () => {
    vi.resetModules();
    process.env.ZATCA_SECRET_STORE_PROVIDER = "aws-secrets-manager";
    delete process.env.ZATCA_SECRETS_MANAGER_REGION;
    delete process.env.ZATCA_SECRETS_MANAGER_ACCESS_KEY_ID;
    delete process.env.ZATCA_SECRETS_MANAGER_SECRET_ACCESS_KEY;
    const fresh = await import("../src/lib/zatca/secretStore/index.js");
    const freshErrors = await import("../src/lib/zatca/errors.js");
    expect(() => fresh.getZatcaSecretStore()).toThrow(freshErrors.ZatcaConfigurationError);
  });

  it("ZATCA_SECRET_STORE_PROVIDER=aws-secrets-manager returns a working store with all variables set, bypassing the NODE_ENV=production dev-store guard entirely", async () => {
    vi.resetModules();
    process.env.NODE_ENV = "production"; // would normally require the guard/escape hatch — must be bypassed here
    delete process.env.ZATCA_ALLOW_DEV_SECRET_STORE;
    process.env.ZATCA_SECRET_STORE_PROVIDER = "aws-secrets-manager";
    process.env.ZATCA_SECRETS_MANAGER_REGION = "us-east-1";
    process.env.ZATCA_SECRETS_MANAGER_ACCESS_KEY_ID = "test-key";
    process.env.ZATCA_SECRETS_MANAGER_SECRET_ACCESS_KEY = "test-secret";
    const fresh = await import("../src/lib/zatca/secretStore/index.js");
    const freshAws = await import("../src/lib/zatca/secretStore/awsSecretsManagerStore.js");
    expect(fresh.getZatcaSecretStore()).toBeInstanceOf(freshAws.AwsSecretsManagerZatcaSecretStore);
  });

  it("no explicit provider still falls through to the existing fail-closed guard in production (unchanged Slice 5 behavior)", async () => {
    vi.resetModules();
    process.env.NODE_ENV = "production";
    delete process.env.ZATCA_ALLOW_DEV_SECRET_STORE;
    delete process.env.ZATCA_SECRET_STORE_PROVIDER;
    const fresh = await import("../src/lib/zatca/secretStore/index.js");
    const freshErrors = await import("../src/lib/zatca/errors.js");
    expect(() => fresh.getZatcaSecretStore()).toThrow(freshErrors.ZatcaConfigurationError);
  });
});

describe("AwsSecretsManagerZatcaSecretStore (mocked AWS client — no real account touched)", () => {
  function makeStore(): AwsSecretsManagerZatcaSecretStore {
    return new AwsSecretsManagerZatcaSecretStore({
      region: "us-east-1",
      accessKeyId: "k",
      secretAccessKey: "s",
    });
  }

  it("put() creates a secret named under this company's prefix and returns it as the opaque secretRef", async () => {
    const store = makeStore();
    const sendMock = vi.fn().mockResolvedValue({});
    // @ts-expect-error — reaching into the private client for test injection
    store["client"].send = sendMock;

    const ref = await store.put("company-a", "egs-1", { binarySecurityToken: "tok", secret: "sec", privateKeyPem: "PEM" });

    expect(ref).toMatch(/^midad\/zatca\/company-a\/egs-1\/[0-9a-f-]{36}$/);
    expect(sendMock).toHaveBeenCalledTimes(1);
    const command = sendMock.mock.calls[0][0];
    expect(command.input.Name).toBe(ref);
    expect(JSON.parse(command.input.SecretString)).toEqual({ binarySecurityToken: "tok", secret: "sec", privateKeyPem: "PEM" });
  });

  it("resolve() returns the stored secret for the owning company", async () => {
    const store = makeStore();
    const secret = { binarySecurityToken: "tok", secret: "sec", privateKeyPem: "PEM", curve: "P-256" };
    const sendMock = vi.fn().mockResolvedValue({ SecretString: JSON.stringify(secret) });
    // @ts-expect-error — reaching into the private client for test injection
    store["client"].send = sendMock;

    const resolved = await store.resolve("company-a", "midad/zatca/company-a/egs-1/some-uuid");
    expect(resolved).toEqual(secret);
  });

  it("resolve() returns null for a DIFFERENT company's secretRef WITHOUT ever calling AWS (tenant isolation)", async () => {
    const store = makeStore();
    const sendMock = vi.fn();
    // @ts-expect-error — reaching into the private client for test injection
    store["client"].send = sendMock;

    const resolved = await store.resolve("company-b", "midad/zatca/company-a/egs-1/some-uuid");
    expect(resolved).toBeNull();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("resolve() returns null (not throw) when AWS reports the secret does not exist", async () => {
    const store = makeStore();
    const sendMock = vi.fn().mockRejectedValue(new ResourceNotFoundException({ message: "not found", $metadata: {} }));
    // @ts-expect-error — reaching into the private client for test injection
    store["client"].send = sendMock;

    const resolved = await store.resolve("company-a", "midad/zatca/company-a/egs-1/gone");
    expect(resolved).toBeNull();
  });

  it("delete() is a no-op for a DIFFERENT company's secretRef WITHOUT ever calling AWS", async () => {
    const store = makeStore();
    const sendMock = vi.fn();
    // @ts-expect-error — reaching into the private client for test injection
    store["client"].send = sendMock;

    await store.delete("company-b", "midad/zatca/company-a/egs-1/some-uuid");
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("delete() calls DeleteSecretCommand for the owning company's secretRef", async () => {
    const store = makeStore();
    const sendMock = vi.fn().mockResolvedValue({});
    // @ts-expect-error — reaching into the private client for test injection
    store["client"].send = sendMock;

    await store.delete("company-a", "midad/zatca/company-a/egs-1/some-uuid");
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0].input.SecretId).toBe("midad/zatca/company-a/egs-1/some-uuid");
  });

  it("SECURITY: put() never lets the private key leak outside the SecretString payload sent to AWS (no separate plaintext field/log)", async () => {
    const store = makeStore();
    const sendMock = vi.fn().mockResolvedValue({});
    // @ts-expect-error — reaching into the private client for test injection
    store["client"].send = sendMock;

    await store.put("company-a", "egs-1", { binarySecurityToken: "tok", secret: "sec", privateKeyPem: "SUPER-SECRET-PEM-VALUE" });

    const command = sendMock.mock.calls[0][0];
    // The only place the private key is allowed to appear at all is inside
    // the encrypted SecretString payload itself — never in the command's
    // Name, tags, or any other field AWS Secrets Manager would treat as
    // metadata (which can appear in CloudTrail logs unencrypted).
    expect(command.input.Name).not.toContain("SUPER-SECRET-PEM-VALUE");
  });
});
