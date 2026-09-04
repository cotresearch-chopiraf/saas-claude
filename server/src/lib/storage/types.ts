// The abstraction boundary approved for Phase 1: the rest of the
// application never writes bytes to a filesystem or a bucket directly —
// it calls this interface. Today only LocalDiskStorageProvider exists
// (localDiskProvider.ts); an S3-compatible provider later is a new file
// implementing this same interface plus one new "s3" value in the
// db/schema.ts storageProviderEnum, not a change to any calling code or to
// the `files` table's shape.

export interface StoredFile {
  storageProvider: "local" | "s3";
  storageKey: string;
  size: number;
  checksum: string;
}

export interface SaveFileInput {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  // A logical grouping, e.g. "logos" — kept simple and flat (not an
  // arbitrary caller-supplied path) so a provider implementation controls
  // its own key layout and a caller can never write outside its namespace.
  namespace: string;
}

export interface StorageProvider {
  save(input: SaveFileInput): Promise<StoredFile>;
  readAsBuffer(storageKey: string): Promise<Buffer | null>;
  // Returns null for a provider/configuration that can't serve a public
  // URL directly (e.g. a private bucket needing a signed URL, not built in
  // Phase 1) — callers must handle that case rather than assume one exists.
  getPublicUrl(storageKey: string): string | null;
}
