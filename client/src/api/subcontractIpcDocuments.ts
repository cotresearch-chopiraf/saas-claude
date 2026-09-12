import { apiFetch, ApiError, getToken } from "./client";
import type { SubcontractIpcDocument } from "./types";

// MIDAD Phase 3 — thin typed wrappers over the Subcontractor IPC Evidence
// API (server/src/routes/subcontractIpcDocuments.ts), mirroring
// api/documents.ts's own pattern exactly. No calculation, no authorization
// logic — the backend is the sole source of truth for what evidence
// belongs to a given IPC.

export function listSubcontractIpcDocuments(projectId: string, ipcId: string): Promise<SubcontractIpcDocument[]> {
  return apiFetch<SubcontractIpcDocument[]>(`/projects/${projectId}/subcontract-ipcs/${ipcId}/documents`);
}

// Bypasses apiFetch (same reason as uploadProjectDocument): a multipart
// body must not carry a "Content-Type: application/json" header.
export async function uploadSubcontractIpcDocument(t: (key: string) => string, projectId: string, ipcId: string, file: File): Promise<SubcontractIpcDocument> {
  const form = new FormData();
  form.append("document", file);
  const res = await fetch(`/api/projects/${projectId}/subcontract-ipcs/${ipcId}/documents`, {
    method: "POST",
    headers: { Authorization: `Bearer ${getToken()}` },
    body: form,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.error ?? t("documentsPage.uploadError"), res.status);
  return body as SubcontractIpcDocument;
}

// Authenticated binary download — mirrors downloadProjectDocument exactly.
// The server never exposes a public storage URL for private IPC evidence.
export async function downloadSubcontractIpcDocument(t: (key: string) => string, projectId: string, ipcId: string, documentId: string, fileName: string): Promise<void> {
  const res = await fetch(`/api/projects/${projectId}/subcontract-ipcs/${ipcId}/documents/${documentId}`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) throw new ApiError(t("quotesPage.actions.downloadError"), res.status);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}
