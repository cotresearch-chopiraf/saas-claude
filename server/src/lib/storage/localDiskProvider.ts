import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { StorageProvider, SaveFileInput, StoredFile } from "./types.js";
import { PUBLIC_STORAGE_NAMESPACES, namespaceOfStorageKey, sanitizeExtension } from "./types.js";

// Local disk — the same stopgap the original logo-upload feature already
// used (fine for a single persistent server, lost on redeploy to an
// ephemeral host; that limitation is unchanged by this refactor, only now
// it's isolated behind one interface instead of scattered across
// lib/uploads.ts and routes/company.ts).
//
// P0.5 remediation (FILES-001) — this used to be the ONE root every
// namespace (logos, documents, subcontract-ipc-documents) was written
// under, and it is also exactly the directory app.ts's unauthenticated
// express.static("/uploads", ...) serves — meaning any private document
// was reachable by anyone who knew or guessed its storage key, with no
// authentication at all. storageRoot is now the PUBLIC root: only
// namespaces listed in PUBLIC_STORAGE_NAMESPACES (today, just "logos") are
// ever written here. Every other namespace goes to privateStorageRoot
// below, a sibling directory express.static is never mounted over — so a
// private document physically does not exist anywhere under storageRoot,
// regardless of whether its storageKey is ever guessed or leaked.
export const storageRoot = path.resolve(process.cwd(), "uploads");

// Sibling of storageRoot, not a subdirectory of it — deliberately, so that
// mounting express.static over storageRoot (or any future change to what
// that mount covers) can never accidentally reach this directory too.
export const privateStorageRoot = path.resolve(process.cwd(), "private-uploads");

// storageKey's shape ("<namespace>/<uuid><ext>") is unchanged by this
// remediation — only which physical root a given namespace resolves
// against changes. This keeps the `files` table's storageKey column
// semantics stable (no data migration of the key VALUES themselves is
// needed); what changes is where new uploads for a private namespace
// physically land on disk going forward. See this file's own docs/
// operational note for what that means for a deployment that already has
// files on local disk from before this change.
function rootForNamespace(namespace: string): string {
  return PUBLIC_STORAGE_NAMESPACES.has(namespace) ? storageRoot : privateStorageRoot;
}

export class LocalDiskStorageProvider implements StorageProvider {
  async save(input: SaveFileInput): Promise<StoredFile> {
    const root = rootForNamespace(input.namespace);
    const dir = path.join(root, input.namespace);
    fs.mkdirSync(dir, { recursive: true });

    const ext = sanitizeExtension(path.extname(input.fileName) || "");
    const storageKey = `${input.namespace}/${randomUUID()}${ext}`;
    const absolute = path.join(root, storageKey);
    fs.writeFileSync(absolute, input.buffer);

    return {
      storageProvider: "local",
      storageKey,
      size: input.buffer.length,
      checksum: createHash("sha256").update(input.buffer).digest("hex"),
    };
  }

  async readAsBuffer(storageKey: string): Promise<Buffer | null> {
    const root = rootForNamespace(namespaceOfStorageKey(storageKey));
    const absolute = path.resolve(root, storageKey);
    // Defensive path-traversal guard — mirrors the check already used in
    // lib/uploads.ts's logoFileToDataUri, kept here since storageKey values
    // are never fully trusted even though they're server-generated (see
    // getPublicUrl below, which parses one back from a URL).
    if (!absolute.startsWith(root) || !fs.existsSync(absolute)) return null;
    return fs.readFileSync(absolute);
  }

  getPublicUrl(storageKey: string): string | null {
    // Only a namespace actually written under the public root can ever
    // have a working /uploads/... URL — returning one for a private
    // namespace would hand back a URL that (correctly) 404s, which is a
    // confusing failure mode a caller shouldn't have to hit; null is the
    // honest answer instead, matching the S3 provider's own contract for
    // "this key has no public URL."
    if (!PUBLIC_STORAGE_NAMESPACES.has(namespaceOfStorageKey(storageKey))) return null;
    return `/uploads/${storageKey}`;
  }
}

export const storageProvider: StorageProvider = new LocalDiskStorageProvider();
