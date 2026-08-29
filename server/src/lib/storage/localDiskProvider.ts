import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { StorageProvider, SaveFileInput, StoredFile } from "./types.js";

// Local disk — the same stopgap the original logo-upload feature already
// used (fine for a single persistent server, lost on redeploy to an
// ephemeral host; that limitation is unchanged by this refactor, only now
// it's isolated behind one interface instead of scattered across
// lib/uploads.ts and routes/company.ts).
export const storageRoot = path.resolve(process.cwd(), "uploads");

export class LocalDiskStorageProvider implements StorageProvider {
  async save(input: SaveFileInput): Promise<StoredFile> {
    const dir = path.join(storageRoot, input.namespace);
    fs.mkdirSync(dir, { recursive: true });

    const ext = path.extname(input.fileName) || "";
    const storageKey = `${input.namespace}/${randomUUID()}${ext}`;
    const absolute = path.join(storageRoot, storageKey);
    fs.writeFileSync(absolute, input.buffer);

    return {
      storageProvider: "local",
      storageKey,
      size: input.buffer.length,
      checksum: createHash("sha256").update(input.buffer).digest("hex"),
    };
  }

  async readAsBuffer(storageKey: string): Promise<Buffer | null> {
    const absolute = path.resolve(storageRoot, storageKey);
    // Defensive path-traversal guard — mirrors the check already used in
    // lib/uploads.ts's logoFileToDataUri, kept here since storageKey values
    // are never fully trusted even though they're server-generated (see
    // getPublicUrl below, which parses one back from a URL).
    if (!absolute.startsWith(storageRoot) || !fs.existsSync(absolute)) return null;
    return fs.readFileSync(absolute);
  }

  getPublicUrl(storageKey: string): string {
    return `/uploads/${storageKey}`;
  }
}

export const storageProvider: StorageProvider = new LocalDiskStorageProvider();
