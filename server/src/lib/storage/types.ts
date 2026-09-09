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

// P0.5 remediation — the only namespace ever meant to be reachable without
// authentication (company branding logos). Every other namespace
// (documents, subcontract-ipc-documents, and any future one) is private:
// access must always go through the authenticated, company/project/entity
// -scoped download route (routes/documents.ts, routes/
// subcontractIpcDocuments.ts), never a public static mount or a
// provider-constructed public URL. Both storage providers (local disk,
// S3-compatible) consult this same set — a namespace never becomes public
// just because a provider's configuration happens to make it reachable
// (e.g. S3_PUBLIC_URL_BASE being set does not make "documents" public).
export const PUBLIC_STORAGE_NAMESPACES = new Set<string>(["logos"]);

// storageKey is always "<namespace>/<rest>" (see localDiskProvider.ts /
// s3Provider.ts's save()) — recovering the namespace from a bare
// storageKey is what lets readAsBuffer()/getPublicUrl() (which only take a
// key, by this interface's own design) decide public-vs-private without
// needing the namespace threaded through separately.
export function namespaceOfStorageKey(storageKey: string): string {
  return storageKey.split("/")[0] ?? "";
}

// Final Launch Gate Audit, Phase 2A — a client-supplied original filename
// is untrusted input. Both storage providers previously derived the
// on-disk/on-key extension directly from it (`path.extname(fileName)` /
// `fileName.slice(fileName.lastIndexOf("."))`) with only the upload's MIME
// TYPE validated, never the filename's extension characters themselves.
// That extension becomes part of the persisted storageKey — and, for the
// "logos" namespace, company.logoPath (routes/company.ts) and from there
// lib/uploads.ts's logoFileToDataUri() derives a MIME string directly from
// it, which lib/documentHtml.ts interpolates unescaped into an <img
// src="..."> attribute during server-side PDF rendering (lib/pdf.ts).
// A filename like `evil.png" onerror="alert(1)` survives untouched through
// every one of those steps and reliably breaks out of that HTML attribute
// — confirmed by tracing the exact transformation each step performs, not
// merely by type-level reasoning. Restricting every storage key's
// extension to a short alphanumeric string (never `"`, `<`, `>`, `'`, `/`,
// whitespace, or any other attribute/path-breaking character) closes this
// at its one shared source for every current and future namespace, rather
// than patching each downstream consumer separately.
const SAFE_EXTENSION_PATTERN = /^\.[a-zA-Z0-9]{1,10}$/;

export function sanitizeExtension(rawExtension: string): string {
  return SAFE_EXTENSION_PATTERN.test(rawExtension) ? rawExtension : "";
}
