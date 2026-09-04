import { LocalDiskStorageProvider } from "./localDiskProvider.js";
import { S3StorageProvider } from "./s3Provider.js";
import type { StorageProvider } from "./types.js";

export class StorageConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageConfigurationError";
  }
}

// Slice AA — provider selection, mirroring the exact fail-closed pattern
// already established for lib/zatca/secretStore/index.ts: a production
// deployment must never silently end up on the ephemeral local-disk
// provider just because nothing was configured. Unlike the ZATCA secret
// store (a pure dev-only vs. none binary), "local" here is itself a
// legitimate, nameable choice via STORAGE_PROVIDER=local — so what's
// forbidden is specifically an *unset* STORAGE_PROVIDER in production
// (the silent case), not an operator explicitly choosing "local" (an
// informed, explicit choice this function has no basis to second-guess).
let cachedProvider: StorageProvider | null = null;

export function resetStorageProviderForTests(): void {
  cachedProvider = null;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new StorageConfigurationError(`STORAGE_PROVIDER=s3 requires ${name} to be set`);
  }
  return value;
}

export function getStorageProvider(): StorageProvider {
  if (cachedProvider) return cachedProvider;

  const explicitProvider = process.env.STORAGE_PROVIDER;

  if (explicitProvider === "s3") {
    cachedProvider = new S3StorageProvider({
      bucket: requireEnv("S3_BUCKET"),
      region: requireEnv("S3_REGION"),
      accessKeyId: requireEnv("S3_ACCESS_KEY_ID"),
      secretAccessKey: requireEnv("S3_SECRET_ACCESS_KEY"),
      endpoint: process.env.S3_ENDPOINT || undefined,
      publicUrlBase: process.env.S3_PUBLIC_URL_BASE || undefined,
    });
    return cachedProvider;
  }

  if (explicitProvider === "local") {
    cachedProvider = new LocalDiskStorageProvider();
    return cachedProvider;
  }

  // No explicit STORAGE_PROVIDER set. Development/test may default to
  // local disk — production must fail closed instead of silently doing
  // the same (this is exactly the "file uploaded" false-success state
  // this slice's own rules forbid: local disk on an ephemeral host loses
  // the file on the very next redeploy).
  if (process.env.NODE_ENV === "production") {
    throw new StorageConfigurationError(
      "No STORAGE_PROVIDER is configured for production. Set STORAGE_PROVIDER=s3 (with S3_BUCKET/S3_REGION/" +
        "S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY) for durable storage, or STORAGE_PROVIDER=local if this " +
        "NODE_ENV=production environment deliberately accepts ephemeral local-disk storage.",
    );
  }

  cachedProvider = new LocalDiskStorageProvider();
  return cachedProvider;
}

// Backward-compatible named export — every existing caller (files.ts)
// imports `storageProvider` directly rather than calling a getter. Using a
// Proxy means the underlying provider is still resolved lazily (so the
// fail-closed guard above still runs at first real use, not at import
// time — matching getZatcaSecretStore()'s own lazy-singleton timing)
// while every existing `storageProvider.save(...)` call site keeps working
// completely unchanged.
export const storageProvider: StorageProvider = new Proxy({} as StorageProvider, {
  get(_target, prop, receiver) {
    const real = getStorageProvider();
    const value = Reflect.get(real, prop, receiver);
    return typeof value === "function" ? value.bind(real) : value;
  },
});
