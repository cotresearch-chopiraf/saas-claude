import { apiFetch, ApiError, getToken } from "./client";
import type { ProjectDocument } from "./types";

// Thin typed wrappers over the existing, verified Documents API
// (server/src/routes/documents.ts) — no calculation, no authorization
// logic, no client-side project filtering. The backend is the sole source
// of truth for which documents belong to this project.

export function listProjectDocuments(projectId: string): Promise<ProjectDocument[]> {
  return apiFetch<ProjectDocument[]>(`/projects/${projectId}/documents`);
}

// Bypasses apiFetch (same reason pages/Settings.tsx's uploadLogo does):
// a multipart body must not carry a "Content-Type: application/json"
// header — the browser sets its own multipart boundary.
export async function uploadProjectDocument(projectId: string, file: File): Promise<ProjectDocument> {
  const form = new FormData();
  form.append("document", file);
  const res = await fetch(`/api/projects/${projectId}/documents`, {
    method: "POST",
    headers: { Authorization: `Bearer ${getToken()}` },
    body: form,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.error ?? "تعذّر رفع الملف", res.status);
  return body as ProjectDocument;
}

// Authenticated binary download — mirrors pages/Invoices.tsx's
// downloadInvoicePdf exactly. The server deliberately never exposes a
// public storage URL for a private project document.
export async function downloadProjectDocument(projectId: string, documentId: string, fileName: string): Promise<void> {
  const res = await fetch(`/api/projects/${projectId}/documents/${documentId}`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) throw new ApiError("تعذّر تنزيل الملف", res.status);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}
