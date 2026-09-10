import { Router, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { files } from "../db/schema.js";
import { readFileBuffer } from "../lib/storage/index.js";
import { PROJECT_DOCUMENT_ENTITY_TYPE } from "./documents.js";

// MIDAD Phase B3 — Client Portal document listing + download. Mounted at
// /api/portal/projects/:projectId/documents behind clientPortalAuth AND
// requireClientProjectAccess (same two-middleware chain
// clientPortalProjectsRouter's own :projectId route uses), so by the time
// any handler below runs: the Client Portal User is authenticated, and
// req.clientPortalGrantCompanyId is the grant row's own companyId — never
// req.params.projectId's company, never anything client-supplied. Every
// query below filters on that grant-derived companyId, the project_document
// entity type/id pair, AND clientVisible = true — all four of B3's required
// conditions enforced at the database layer, never in React.
//
// A document that fails ANY of those four conditions (wrong company, wrong
// project, wrong entityType, or clientVisible = false) returns the exact
// same 404 as a nonexistent file id — this route never distinguishes
// "hidden" from "doesn't exist", the same posture
// requireClientProjectAccess.ts already documents for projects.
export const clientPortalDocumentsRouter = Router({ mergeParams: true });

type ProjectParams = { projectId: string };
type DocumentParams = ProjectParams & { fileId: string };

// Client-safe subset only: no companyId, no uploadedBy/uploader name, no
// storageKey/storageProvider, no version/previousVersionId lineage (an
// internal-only concept a client has no use for and that could hint at
// document history it never had visibility into).
interface PortalDocument {
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  uploadedAt: Date;
}

function toPortalDocument(f: typeof files.$inferSelect): PortalDocument {
  return { id: f.id, fileName: f.fileName, mimeType: f.mimeType, size: f.size, uploadedAt: f.uploadedAt };
}

clientPortalDocumentsRouter.get("/", async (req: Request<ProjectParams>, res: Response) => {
  const rows = await db.query.files.findMany({
    where: and(
      eq(files.companyId, req.clientPortalGrantCompanyId!),
      eq(files.entityType, PROJECT_DOCUMENT_ENTITY_TYPE),
      eq(files.entityId, req.params.projectId),
      eq(files.clientVisible, true),
    ),
    orderBy: (f, { desc }) => [desc(f.uploadedAt)],
  });
  res.json(rows.map(toPortalDocument));
});

clientPortalDocumentsRouter.get("/:fileId", async (req: Request<DocumentParams>, res: Response) => {
  const file = await db.query.files.findFirst({
    where: and(
      eq(files.id, req.params.fileId),
      eq(files.companyId, req.clientPortalGrantCompanyId!),
      eq(files.entityType, PROJECT_DOCUMENT_ENTITY_TYPE),
      eq(files.entityId, req.params.projectId),
      eq(files.clientVisible, true),
    ),
  });
  if (!file) return res.status(404).json({ error: "الملف غير موجود" });

  const buffer = await readFileBuffer(file.storageKey);
  if (!buffer) return res.status(404).json({ error: "الملف غير موجود" });

  res.setHeader("Content-Type", file.mimeType);
  res.setHeader("Content-Disposition", "attachment");
  res.send(buffer);
});
