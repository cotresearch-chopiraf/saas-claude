import { Router, type Request, type Response, type NextFunction } from "express";
import multer from "multer";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { files, subcontractIpcs } from "../db/schema.js";
import { requirePermission } from "../lib/permissions.js";
import { uploadFile, getFile, readFileBuffer } from "../lib/storage/index.js";

// MIDAD Phase 3 — Subcontractor IPC Evidence. Same generic `files`-table
// storage pattern as project Documents (routes/documents.ts), with its own
// independent entity type — every Subcontractor IPC's evidence lives here
// under entityType = SUBCONTRACT_IPC_DOCUMENT_ENTITY_TYPE and
// entityId = the subcontract IPC's own id. This route never reads or
// writes PROJECT_DOCUMENT_ENTITY_TYPE rows, and documents.ts is never
// modified by this file. Purely additive evidence: no financial field on
// subcontractIpcs/subcontractIpcLines is ever read or written here.
export const SUBCONTRACT_IPC_DOCUMENT_ENTITY_TYPE = "subcontract_ipc";

type SubcontractIpcParams = { projectId: string; ipcId: string };
type DocumentParams = SubcontractIpcParams & { documentId: string };

export const subcontractIpcDocumentsRouter = Router({ mergeParams: true });

// Locally duplicated ownership check — same shape as subcontractIpcs.ts's
// own findOwnedSubcontractIpc, deliberately NOT imported from there (that
// helper is private/unexported by design; every route file owns its own
// copy of this pattern, never a shared cross-file helper).
async function findOwnedSubcontractIpc(companyId: string, projectId: string, ipcId: string) {
  return db.query.subcontractIpcs.findFirst({
    where: and(eq(subcontractIpcs.id, ipcId), eq(subcontractIpcs.projectId, projectId), eq(subcontractIpcs.companyId, companyId)),
  });
}

// Tenant/project/IPC ownership scoping — every route below runs behind this.
subcontractIpcDocumentsRouter.use(async (req: Request<SubcontractIpcParams>, res: Response, next: NextFunction) => {
  const ipc = await findOwnedSubcontractIpc(req.companyId!, req.params.projectId, req.params.ipcId);
  if (!ipc) return res.status(404).json({ error: "الشهادة غير موجودة" });
  next();
});

// --- File policy --- identical whitelist/size limit to documents.ts; this
// is project evidence of the same kind (site photos, delivery notes,
// subcontractor invoices), just scoped to a Subcontractor IPC instead of
// the whole project.
const MAX_DOCUMENT_SIZE = 10 * 1024 * 1024;
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

function handleDocumentUpload(req: Request, res: Response, next: NextFunction) {
  documentUpload.single("document")(req, res, (err: unknown) => {
    if (err) {
      const message = err instanceof Error ? err.message : "تعذّر رفع الملف";
      return res.status(400).json({ error: message });
    }
    next();
  });
}

// Never exposes storageKey — same discipline as documents.ts's own
// toDocumentResponse.
function toDocumentResponse(row: {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  uploadedAt: Date;
  version: number;
  previousVersionId: string | null;
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
  };
}

subcontractIpcDocumentsRouter.get("/", async (req: Request<SubcontractIpcParams>, res: Response) => {
  const rows = await db.query.files.findMany({
    where: and(
      eq(files.companyId, req.companyId!),
      eq(files.entityType, SUBCONTRACT_IPC_DOCUMENT_ENTITY_TYPE),
      eq(files.entityId, req.params.ipcId),
    ),
    orderBy: (f, { desc }) => [desc(f.uploadedAt)],
    with: { uploader: { columns: { name: true } } },
  });
  res.json(rows.map(toDocumentResponse));
});

// Upload is gated by subcontractIpc.manage (owner-only) — same permission
// every other mutation on this IPC already requires, reused verbatim; no
// new permission is added anywhere. Read (GET /, GET /:documentId) stays
// member-open, matching project Documents' own member-open precedent.
subcontractIpcDocumentsRouter.post(
  "/",
  requirePermission("subcontractIpc.manage"),
  handleDocumentUpload,
  async (req: Request<SubcontractIpcParams>, res: Response) => {
    if (!req.file) return res.status(400).json({ error: "لم يتم إرفاق ملف" });

    const record = await uploadFile({
      companyId: req.companyId!,
      uploadedBy: req.userId!,
      entityType: SUBCONTRACT_IPC_DOCUMENT_ENTITY_TYPE,
      entityId: req.params.ipcId,
      buffer: req.file.buffer,
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
      namespace: "subcontract-ipc-documents",
    });

    const withUploader = await db.query.files.findFirst({
      where: eq(files.id, record.id),
      with: { uploader: { columns: { name: true } } },
    });
    res.status(201).json(toDocumentResponse(withUploader!));
  },
);

// Authenticated binary download — deliberately NOT publicUrlFor(). Verifies
// company ownership (getFile already scopes by companyId) AND that the
// file is a subcontract_ipc document belonging to THIS ipc — a project
// document (or any other entityType) with a guessed id can never be
// reached through this route, and neither can another IPC's evidence.
subcontractIpcDocumentsRouter.get("/:documentId", async (req: Request<DocumentParams>, res: Response) => {
  const file = await getFile(req.companyId!, req.params.documentId);
  if (!file || file.entityType !== SUBCONTRACT_IPC_DOCUMENT_ENTITY_TYPE || file.entityId !== req.params.ipcId) {
    return res.status(404).json({ error: "الملف غير موجود" });
  }

  const buffer = await readFileBuffer(file.storageKey);
  if (!buffer) return res.status(404).json({ error: "الملف غير موجود" });

  res.setHeader("Content-Type", file.mimeType);
  res.setHeader("Content-Disposition", "attachment");
  res.send(buffer);
});
