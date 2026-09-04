import { describe, it, expect, afterEach, vi } from "vitest";
import {
  getStorageProvider,
  resetStorageProviderForTests,
  StorageConfigurationError,
} from "../src/lib/storage/provider.js";
import { LocalDiskStorageProvider } from "../src/lib/storage/localDiskProvider.js";
import { S3StorageProvider } from "../src/lib/storage/s3Provider.js";

// Slice AA — provider selection, mirroring the exact fail-closed testing
// pattern already established for mailer.test.ts / zatcaSecretStoreGuard.test.ts.

const ENV_KEYS = [
  "NODE_ENV",
  "STORAGE_PROVIDER",
  "S3_BUCKET",
  "S3_REGION",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_ENDPOINT",
  "S3_PUBLIC_URL_BASE",
] as const;

const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (ORIGINAL_ENV[key] === undefined) delete process.env[key];
    else process.env[key] = ORIGINAL_ENV[key];
  }
}

afterEach(() => {
  restoreEnv();
  resetStorageProviderForTests();
});

describe("getStorageProvider() selection", () => {
  it("defaults to LocalDiskStorageProvider when NODE_ENV is unset (matches this environment's actual default)", () => {
    delete process.env.NODE_ENV;
    delete process.env.STORAGE_PROVIDER;
    expect(getStorageProvider()).toBeInstanceOf(LocalDiskStorageProvider);
  });

  it("throws StorageConfigurationError when NODE_ENV=production with no STORAGE_PROVIDER set (never silently falls back to ephemeral local disk)", () => {
    process.env.NODE_ENV = "production";
    delete process.env.STORAGE_PROVIDER;
    expect(() => getStorageProvider()).toThrow(StorageConfigurationError);
  });

  it("STORAGE_PROVIDER=local works even in production (explicit opt-in, not a silent fallback)", () => {
    process.env.NODE_ENV = "production";
    process.env.STORAGE_PROVIDER = "local";
    expect(getStorageProvider()).toBeInstanceOf(LocalDiskStorageProvider);
  });

  it("throws StorageConfigurationError when STORAGE_PROVIDER=s3 with required S3 variables missing", () => {
    process.env.STORAGE_PROVIDER = "s3";
    delete process.env.S3_BUCKET;
    delete process.env.S3_REGION;
    delete process.env.S3_ACCESS_KEY_ID;
    delete process.env.S3_SECRET_ACCESS_KEY;
    expect(() => getStorageProvider()).toThrow(StorageConfigurationError);
  });

  it("returns an S3StorageProvider when STORAGE_PROVIDER=s3 with all required variables set", () => {
    process.env.STORAGE_PROVIDER = "s3";
    process.env.S3_BUCKET = "test-bucket";
    process.env.S3_REGION = "us-east-1";
    process.env.S3_ACCESS_KEY_ID = "test-key-id";
    process.env.S3_SECRET_ACCESS_KEY = "test-secret";
    expect(getStorageProvider()).toBeInstanceOf(S3StorageProvider);
  });

  it("caches the provider across calls until resetStorageProviderForTests()", () => {
    delete process.env.NODE_ENV;
    const first = getStorageProvider();
    const second = getStorageProvider();
    expect(first).toBe(second);
  });
});

describe("S3StorageProvider (mocked AWS client — no real bucket touched)", () => {
  it("save() uploads with the correct bucket/content-type and returns an opaque storageKey never containing the caller's original filename", async () => {
    const sendMock = vi.fn().mockResolvedValue({});
    const provider = new S3StorageProvider({
      bucket: "test-bucket",
      region: "us-east-1",
      accessKeyId: "k",
      secretAccessKey: "s",
    });
    // @ts-expect-error — reaching into the private client for test injection
    provider["client"].send = sendMock;

    const result = await provider.save({
      buffer: Buffer.from("hello world"),
      fileName: "evidence-photo.jpg",
      mimeType: "image/jpeg",
      namespace: "project-documents",
    });

    expect(result.storageProvider).toBe("s3");
    expect(result.storageKey).toMatch(/^project-documents\/[0-9a-f-]{36}\.jpg$/);
    expect(result.storageKey).not.toContain("evidence-photo");
    expect(sendMock).toHaveBeenCalledTimes(1);
    const command = sendMock.mock.calls[0][0];
    expect(command.input.Bucket).toBe("test-bucket");
    expect(command.input.ContentType).toBe("image/jpeg");
  });

  it("getPublicUrl() returns null when no publicUrlBase is configured (private bucket)", () => {
    const provider = new S3StorageProvider({
      bucket: "test-bucket",
      region: "us-east-1",
      accessKeyId: "k",
      secretAccessKey: "s",
    });
    expect(provider.getPublicUrl("some/key.jpg")).toBeNull();
  });

  it("getPublicUrl() builds a URL under the configured public base when set", () => {
    const provider = new S3StorageProvider({
      bucket: "test-bucket",
      region: "us-east-1",
      accessKeyId: "k",
      secretAccessKey: "s",
      publicUrlBase: "https://cdn.example.com/",
    });
    expect(provider.getPublicUrl("logos/abc.png")).toBe("https://cdn.example.com/logos/abc.png");
  });

  it("readAsBuffer() returns null for a missing object rather than throwing", async () => {
    const notFound = new Error("not found");
    notFound.name = "NoSuchKey";
    const provider = new S3StorageProvider({
      bucket: "test-bucket",
      region: "us-east-1",
      accessKeyId: "k",
      secretAccessKey: "s",
    });
    // @ts-expect-error — reaching into the private client for test injection
    provider["client"].send = vi.fn().mockRejectedValue(notFound);

    expect(await provider.readAsBuffer("missing/key.jpg")).toBeNull();
  });
});
