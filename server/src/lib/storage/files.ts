import { and, eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { files } from "../../db/schema.js";
import { storageProvider } from "./provider.js";

export interface UploadFileInput {
  companyId: string;
  uploadedBy: string;
  entityType: string;
  entityId: string;
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  namespace: string;
  // Set when this upload REPLACES an earlier evidence file for the same
  // entity — the previous row is never updated or deleted, a new row is
  // inserted referencing it, so historical evidence is never silently
  // replaced (Phase 1 requirement).
  previousVersionId?: string;
}

export async function uploadFile(input: UploadFileInput) {
  const stored = await storageProvider.save({
    buffer: input.buffer,
    fileName: input.fileName,
    mimeType: input.mimeType,
    namespace: input.namespace,
  });

  let version = 1;
  if (input.previousVersionId) {
    const previous = await db.query.files.findFirst({ where: eq(files.id, input.previousVersionId) });
    version = (previous?.version ?? 0) + 1;
  }

  const [record] = await db
    .insert(files)
    .values({
      companyId: input.companyId,
      storageProvider: stored.storageProvider,
      storageKey: stored.storageKey,
      fileName: input.fileName,
      mimeType: input.mimeType,
      size: stored.size,
      checksum: stored.checksum,
      uploadedBy: input.uploadedBy,
      entityType: input.entityType,
      entityId: input.entityId,
      version,
      previousVersionId: input.previousVersionId ?? null,
    })
    .returning();

  return record;
}

export async function getFile(companyId: string, fileId: string) {
  return db.query.files.findFirst({ where: and(eq(files.id, fileId), eq(files.companyId, companyId)) });
}

export async function listFilesForEntity(companyId: string, entityType: string, entityId: string) {
  return db.query.files.findMany({
    where: and(eq(files.companyId, companyId), eq(files.entityType, entityType), eq(files.entityId, entityId)),
    orderBy: (f, { desc }) => [desc(f.uploadedAt)],
  });
}

export function publicUrlFor(storageKey: string): string | null {
  return storageProvider.getPublicUrl(storageKey);
}

export async function readFileBuffer(storageKey: string): Promise<Buffer | null> {
  return storageProvider.readAsBuffer(storageKey);
}
