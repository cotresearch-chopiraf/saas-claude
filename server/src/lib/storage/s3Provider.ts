import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { SaveFileInput, StorageProvider, StoredFile } from "./types.js";
import { PUBLIC_STORAGE_NAMESPACES, namespaceOfStorageKey } from "./types.js";

// Slice AA — the durable production storage provider this codebase's own
// storage/types.ts header comment already anticipated: "an S3-compatible
// provider later is a new file implementing this same interface plus one
// new 's3' value in the db/schema.ts storageProviderEnum, not a change to
// any calling code or to the files table's shape." That is exactly what
// this file is — no change to files.ts, no change to any route.
//
// S3-compatible rather than AWS-specific: the AWS SDK's S3Client accepts
// an optional custom `endpoint`, which is all that's needed to also target
// Cloudflare R2 or any other S3-compatible object store — see
// S3ProviderConfig.endpoint below.
//
// Tenant isolation: identical model to LocalDiskStorageProvider — a
// storageKey is an opaque, server-generated UUID with no tenant
// information encoded in it, and no bucket-listing capability is ever
// exposed to a caller. The actual tenant check (does this fileId's row
// belong to this companyId?) happens one layer up, in storage/files.ts's
// getFile()/listFilesForEntity() — unchanged by this provider, exactly as
// it already protects the local-disk provider today.

export interface S3ProviderConfig {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  // Only set for a non-AWS S3-compatible endpoint (e.g. R2); leave
  // undefined for real AWS S3, matching the AWS SDK's own convention.
  endpoint?: string;
  // Public base URL if this bucket (or a CDN in front of it) is meant to
  // be served directly, e.g. "https://cdn.example.com". When unset,
  // getPublicUrl() returns null — matching the StorageProvider contract
  // for a provider that cannot serve a public URL directly (a private
  // bucket), exactly as documented in types.ts.
  publicUrlBase?: string;
}

export class S3StorageProvider implements StorageProvider {
  private readonly client: S3Client;

  constructor(private readonly config: S3ProviderConfig) {
    this.client = new S3Client({
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      ...(config.endpoint ? { endpoint: config.endpoint, forcePathStyle: true } : {}),
    });
  }

  async save(input: SaveFileInput): Promise<StoredFile> {
    const ext = input.fileName.includes(".") ? input.fileName.slice(input.fileName.lastIndexOf(".")) : "";
    const storageKey = `${input.namespace}/${randomUUID()}${ext}`;
    const checksum = createHash("sha256").update(input.buffer).digest("hex");

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: storageKey,
        Body: input.buffer,
        ContentType: input.mimeType,
        // Stored for integrity verification without a separate read-back;
        // never used for access control (bucket policy/IAM does that).
        Metadata: { sha256: checksum },
      }),
    );

    return {
      storageProvider: "s3",
      storageKey,
      size: input.buffer.length,
      checksum,
    };
  }

  async readAsBuffer(storageKey: string): Promise<Buffer | null> {
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: storageKey }));
      if (!result.Body) return null;
      const chunks: Uint8Array[] = [];
      // AWS SDK v3's Body is a web/Node stream depending on runtime;
      // transformToByteArray() is the SDK's own documented cross-runtime way
      // to read it fully, avoiding a manual stream-type branch here.
      const bytes = await (result.Body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
      chunks.push(bytes);
      return Buffer.concat(chunks);
    } catch (err) {
      // The SDK throws a NoSuchKey-shaped error for a missing object —
      // matching LocalDiskStorageProvider's own "missing file -> null,
      // never throw" contract rather than forcing every caller to add a
      // try/catch this interface never required before.
      if (err instanceof Error && (err.name === "NoSuchKey" || err.name === "NotFound")) return null;
      throw err;
    }
  }

  getPublicUrl(storageKey: string): string | null {
    if (!this.config.publicUrlBase) return null;
    // P0.5 remediation (FILES-001) — S3_PUBLIC_URL_BASE being configured
    // must never make a PRIVATE namespace (documents,
    // subcontract-ipc-documents) publicly reachable by URL. Only
    // PUBLIC_STORAGE_NAMESPACES (today, "logos") ever gets a real public
    // URL back from this method, regardless of bucket/CDN configuration —
    // the bucket policy/IAM setup is out of this codebase's control, but
    // this application layer never itself constructs or hands out a
    // public URL for a private document.
    if (!PUBLIC_STORAGE_NAMESPACES.has(namespaceOfStorageKey(storageKey))) return null;
    return `${this.config.publicUrlBase.replace(/\/$/, "")}/${storageKey}`;
  }
}
