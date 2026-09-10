import { Router, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { files, projects } from "../db/schema.js";
import { uploadFile, getFile, readFileBuffer } from "../lib/storage/index.js";
import { requirePermission } from "../lib/permissions.js";
import { recordAuditEvent } from "../lib/audit.js";

// MIDAD UI-10 — project-scoped Documents (evidence repository).
//
// Entity type: every project document is stored in the existing polymorphic
// `files` table with entityType = PROJECT_DOCUMENT_ENTITY_TYPE and
// entityId = the project's own id. This is the ONLY entity type this route
// ever reads or writes — never inferred, never mixed with any other
// caller's entityType (e.g. "company_logo").
export const PROJECT_DOCUMENT_ENTITY_TYPE = "project_document";

type ProjectParams = { projectId: string };
type DocumentParams = ProjectParams & { documentId: string };

export const documentsRouter = Router({ mergeParams: true });

// Same tenant/project-ownership pattern as every other project sub-resource
// (dailyLogs.ts, contracts.ts, invoices.ts's projectInvoicesRouter, ...).
documentsRouter.use(async (req: Request<ProjectParams>, res: Response, next: NextFunction) => {
  const project = await db.query.projects.findFirst({
    where: and(eq(projects.id, req.params.projectId), eq(projects.companyId, req.companyId!)),
  });
  if (!project) return res.status(404).json({ error: "المشروع غير موجود" });
  next();
});

// --- File policy ---
// 10 MB: generous enough for a scanned contract or a set of site photos,
// while still bounded (multer buffers the whole upload in memory — see
// lib/uploads.ts's identical memoryStorage choice for the logo feature).
const MAX_DOCUMENT_SIZE = 10 * 1024 * 1024;

// A narrow initial whitelist for project evidence: PDF, common raster
// images, and the common Office document/spreadsheet formats. No SVG
// (unlike the owner-only logo upload, this is member-uploadable — an SVG
// can carry a script payload, so it is deliberately excluded here even
// though the logo feature allows it). MIME is client-reported only
// (file.mimetype) — this codebase has no content-sniffing capability
// anywhere, matching the exact same limitation the logo upload already has.
const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

const documentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_DOCUMENT_SIZE },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      return cb(new Error("نوع الملف غير مسموح به"));
    }
    cb(null, true);
  },
});

// Mirrors lib/uploads.ts's handleLogoUpload exactly: multer/fileFilter
// errors (including the size-limit MulterError) surface as a clean 400
// here rather than falling through to the generic 500 handler.
function handleDocumentUpload(req: Request, res: Response, next: NextFunction) {
  documentUpload.single("document")(req, res, (err: unknown) => {
    if (err) {
      const message = err instanceof Error ? err.message : "تعذّر رفع الملف";
      return res.status(400).json({ error: message });
    }
    next();
  });
}

// Never exposes storageKey (internal storage-layout detail) or any
// unsupported field (status/category/approval — none of that exists on
// `files`). uploadedByName comes from a direct relational join (the
// `filesRelations.uploader` relation already defined in schema.ts) — not
// from listFilesForEntity(), which has no `with` support; upload/download
// below still go through the shared storage service unchanged. clientVisible
// (Phase B3) IS exposed here — this is the internal-facing response, and an
// internal user managing a document's visibility needs to see its current
// state.
function toDocumentResponse(row: {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  uploadedAt: Date;
  version: number;
  previousVersionId: string | null;
  clientVisible: boolean;
  uploader?: { name: string } | null;
}) {
  return {
    id: row.id,
    fileName: row.fileName,
    mimeType: row.mimeType,
    size: row.size,
    uploadedAt: row.uploadedAt,
    uploadedByName: row.uploader?.name ?? null,
    version: row.version,
    previousVersionId: row.previousVersionId,
    clientVisible: row.clientVisible,
  };
}

documentsRouter.get("/", async (req: Request<ProjectParams>, res: Response) => {
  const rows = await db.query.files.findMany({
    where: and(
      eq(files.companyId, req.companyId!),
      eq(files.entityType, PROJECT_DOCUMENT_ENTITY_TYPE),
      eq(files.entityId, req.params.projectId),
    ),
    orderBy: (f, { desc }) => [desc(f.uploadedAt)],
    with: { uploader: { columns: { name: true } } },
  });
  res.json(rows.map(toDocumentResponse));
});

documentsRouter.post("/", handleDocumentUpload, async (req: Request<ProjectParams>, res: Response) => {
  if (!req.file) return res.status(400).json({ error: "لم يتم إرفاق ملف" });

  const record = await uploadFile({
    companyId: req.companyId!,
    uploadedBy: req.userId!,
    entityType: PROJECT_DOCUMENT_ENTITY_TYPE,
    entityId: req.params.projectId,
    buffer: req.file.buffer,
    fileName: req.file.originalname,
    mimeType: req.file.mimetype,
    namespace: "documents",
  });

  const withUploader = await db.query.files.findFirst({
    where: eq(files.id, record.id),
    with: { uploader: { columns: { name: true } } },
  });
  res.status(201).json(toDocumentResponse(withUploader!));
});

// Authenticated binary download — deliberately NOT publicUrlFor(), which
// would serve the file unauthenticated via app.ts's /uploads static mount.
// Verifies company ownership (getFile already scopes by companyId) AND
// that the file is a project_document belonging to THIS project — a
// company_logo row (or any other entityType) with a guessed id can never
// be reached through this route, and neither can another project's or
// another company's document.
documentsRouter.get("/:documentId", async (req: Request<DocumentParams>, res: Response) => {
  const file = await getFile(req.companyId!, req.params.documentId);
  if (!file || file.entityType !== PROJECT_DOCUMENT_ENTITY_TYPE || file.entityId !== req.params.projectId) {
    return res.status(404).json({ error: "الملف غير موجود" });
  }

  const buffer = await readFileBuffer(file.storageKey);
  if (!buffer) return res.status(404).json({ error: "الملف غير موجود" });

  res.setHeader("Content-Type", file.mimeType);
  // No user-controlled filename in the header (avoids any header-injection/
  // encoding concern for Arabic/long filenames) — the client applies the
  // real display name via <a download="...">, exactly like the existing
  // invoice/quote PDF download convention in pages/Invoices.tsx.
  res.setHeader("Content-Disposition", "attachment");
  res.send(buffer);
});

// MIDAD Phase B3 — explicit client visibility toggle. Reuses
// clientPortal.manage (Phase B1): flipping this flag is the exact same
// class of decision that permission already governs — "who outside this
// company can read this company's project data" — just at document grain
// instead of project grain, so a second permission would only fragment
// one trust boundary into two without adding precision. An ordinary member
// can upload/view/download documents (unchanged), but only an owner may
// decide one becomes visible to the client, matching the master prompt's
// "do not make ordinary members able to expose documents" requirement.
const visibilitySchema = z.object({ clientVisible: z.boolean() });

documentsRouter.patch(
  "/:documentId",
  requirePermission("clientPortal.manage"),
  async (req: Request<DocumentParams>, res: Response) => {
    const parsed = visibilitySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

    const existing = await getFile(req.companyId!, req.params.documentId);
    if (!existing || existing.entityType !== PROJECT_DOCUMENT_ENTITY_TYPE || existing.entityId !== req.params.projectId) {
      return res.status(404).json({ error: "الملف غير موجود" });
    }

    if (existing.clientVisible === parsed.data.clientVisible) {
      const withUploader = await db.query.files.findFirst({
        where: eq(files.id, existing.id),
        with: { uploader: { columns: { name: true } } },
      });
      return res.json(toDocumentResponse(withUploader!));
    }

    const updated = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(files)
        .set({ clientVisible: parsed.data.clientVisible })
        .where(eq(files.id, existing.id))
        .returning();

      await recordAuditEvent(tx, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: parsed.data.clientVisible ? "client_document_visibility_enabled" : "client_document_visibility_disabled",
        entityType: PROJECT_DOCUMENT_ENTITY_TYPE,
        entityId: existing.id,
        beforeValue: { clientVisible: existing.clientVisible },
        afterValue: { clientVisible: row.clientVisible },
        metadata: { projectId: req.params.projectId },
      });

      return row;
    });

    const withUploader = await db.query.files.findFirst({
      where: eq(files.id, updated.id),
      with: { uploader: { columns: { name: true } } },
    });
    res.json(toDocumentResponse(withUploader!));
  },
);
