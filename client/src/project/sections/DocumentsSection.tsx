import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { PageHeader } from "../../ui/PageHeader";
import { Card } from "../../ui/Card";
import { Button } from "../../ui/Button";
import { FinancialTable, type FinancialColumn } from "../../ui/FinancialTable";
import { ErrorState } from "../../ui/ErrorState";
import { formatFileSize, formatDate } from "../../lib/format";
import { listProjectDocuments, uploadProjectDocument, downloadProjectDocument, setDocumentClientVisibility } from "../../api/documents";
import { ApiError } from "../../api/client";
import type { ProjectDocument } from "../../api/types";
import { useProjectContext } from "../context";

// Client-side mirror of server/src/routes/documents.ts's ALLOWED_MIME_TYPES
// — advisory only, for immediate feedback before a request is even sent.
// The backend independently re-validates every upload regardless; this
// list existing here is never a security boundary.
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
const MAX_DOCUMENT_SIZE = 10 * 1024 * 1024;
const ACCEPT_ATTR = ".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.xls,.xlsx";

// Documents (UI-10) — a project-scoped evidence repository, the thinnest
// complete layer over the existing generic `files` storage service (see
// server/src/routes/documents.ts for the full design rationale). This is
// intentionally NOT a document-management system: no categories, no
// approval workflow, no versioning UI (the backend doesn't expose one yet
// beyond the version/previousVersionId link on the response), and no
// delete (the storage service has no delete capability at all). Nothing
// here is a financial figure — file size is a byte count, not money.
export function DocumentsSection() {
  const { projectId } = useProjectContext();
  const [documents, setDocuments] = useState<ProjectDocument[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [visibilityError, setVisibilityError] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function load() {
    setError(null);
    setDocuments(null);
    listProjectDocuments(projectId)
      .then(setDocuments)
      .catch((err) => setError(err instanceof Error ? err.message : "تعذّر تحميل مستندات المشروع"));
  }
  useEffect(load, [projectId]);

  function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    setNotice(null);
    setUploadError(null);
    const file = e.target.files?.[0] ?? null;
    setSelectedFile(file);
    if (!file) {
      setValidationError(null);
      return;
    }
    if (!ALLOWED_MIME_TYPES.has(file.type)) {
      setValidationError("نوع الملف غير مسموح به. الأنواع المسموحة: PDF، صور (PNG, JPEG, WEBP)، مستندات Word أو Excel");
      return;
    }
    if (file.size > MAX_DOCUMENT_SIZE) {
      setValidationError("حجم الملف يتجاوز الحد الأقصى المسموح به (10 ميجابايت)");
      return;
    }
    setValidationError(null);
  }

  async function onUpload() {
    // uploading guards against a rapid double-click firing two uploads of
    // the same file while the first request is still in flight.
    if (!selectedFile || validationError || uploading) return;
    setUploading(true);
    setUploadError(null);
    try {
      await uploadProjectDocument(projectId, selectedFile);
      setNotice("تم رفع الملف بنجاح");
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      load();
    } catch (err) {
      setUploadError(err instanceof ApiError ? err.message : "تعذّر رفع الملف");
    } finally {
      setUploading(false);
    }
  }

  // MIDAD Phase B3 — explicit Client Portal visibility toggle. Server-
  // authoritative (owner-only, clientPortal.manage); this checkbox reflects
  // whatever the last successful PATCH returned, never an optimistic guess
  // — on failure the row is left exactly as it was and the error surfaces
  // inline, no silent revert needed because nothing was changed locally.
  async function onToggleVisibility(doc: ProjectDocument) {
    if (togglingId) return;
    setVisibilityError(null);
    setTogglingId(doc.id);
    try {
      const updated = await setDocumentClientVisibility(projectId, doc.id, !doc.clientVisible);
      setDocuments((prev) => prev?.map((d) => (d.id === updated.id ? updated : d)) ?? prev);
    } catch (err) {
      setVisibilityError(err instanceof ApiError ? err.message : "تعذّر تحديث ظهور المستند للعميل");
    } finally {
      setTogglingId(null);
    }
  }

  const columns: FinancialColumn<ProjectDocument>[] = [
    {
      key: "fileName",
      header: "اسم الملف",
      render: (d) => (
        <span className="block max-w-xs truncate" title={d.fileName}>
          {d.fileName}
        </span>
      ),
    },
    { key: "mimeType", header: "النوع", render: (d) => d.mimeType },
    { key: "size", header: "الحجم", align: "end", render: (d) => formatFileSize(d.size) },
    { key: "uploadedAt", header: "تاريخ الرفع", render: (d) => formatDate(d.uploadedAt) },
    { key: "uploadedByName", header: "بواسطة", render: (d) => d.uploadedByName ?? "—" },
    {
      key: "clientVisible",
      header: "مرئي للعميل",
      render: (d) => (
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={d.clientVisible}
            disabled={togglingId === d.id}
            onChange={() => onToggleVisibility(d)}
          />
        </label>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title="المستندات" subtitle="مرفقات وأدلة هذا المشروع تحديداً." />

      <Card className="p-5">
        <h2 className="mb-3 font-semibold text-stone-800">رفع مستند جديد</h2>
        <p className="mb-3 text-xs text-stone-500">
          الأنواع المسموحة: PDF، صور (PNG, JPEG, WEBP)، مستندات Word أو Excel — الحد الأقصى للحجم: 10 ميجابايت
        </p>

        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPT_ATTR}
            onChange={onFileChange}
            className="text-sm text-stone-600 file:mr-3 file:rounded-md file:border-0 file:bg-stone-100 file:px-3 file:py-1.5 file:text-sm file:text-stone-700"
          />
          <Button size="sm" onClick={onUpload} disabled={!selectedFile || !!validationError || uploading}>
            {uploading ? "جارٍ الرفع..." : "رفع"}
          </Button>
        </div>

        {selectedFile && !validationError && (
          <p className="mt-2 text-xs text-stone-500">
            الملف المحدد: {selectedFile.name} ({formatFileSize(selectedFile.size)})
          </p>
        )}
        {validationError && <p className="mt-2 text-xs text-danger-600">{validationError}</p>}
        {uploadError && (
          <div className="mt-3">
            <ErrorState message={uploadError} />
          </div>
        )}
        {notice && <p className="mt-3 text-sm text-success-700">{notice}</p>}
      </Card>

      {visibilityError && (
        <div>
          <ErrorState message={visibilityError} />
        </div>
      )}

      <FinancialTable
        columns={columns}
        rows={documents}
        rowKey={(d) => d.id}
        error={documents === null ? error : null}
        onRetry={load}
        emptyMessage="لا توجد مستندات لهذا المشروع بعد"
        rowActions={(d) => (
          <button
            type="button"
            onClick={() => downloadProjectDocument(projectId, d.id, d.fileName)}
            className="text-sm text-primary hover:underline"
          >
            تنزيل
          </button>
        )}
      />
    </div>
  );
}
