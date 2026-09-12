import { portalApiFetch, getPortalToken } from "./portalClient";
import { ApiError } from "../../api/client";
import type { PortalDocument } from "./types";

// MIDAD Phase B3 — thin typed wrappers over the verified Client Portal
// documents API (server/src/routes/clientPortalDocuments.ts). No filtering,
// no authorization logic here — the server alone decides which documents
// are visible; this file only shapes the two calls.

export function listPortalDocuments(projectId: string): Promise<PortalDocument[]> {
  return portalApiFetch<PortalDocument[]>(`/portal/projects/${projectId}/documents`);
}

// Bypasses portalApiFetch (same reason api/documents.ts's
// downloadProjectDocument does) — a binary download is not JSON, and the
// server never exposes a public/unauthenticated URL for a portal document.
export async function downloadPortalDocument(t: (key: string) => string, projectId: string, documentId: string, fileName: string): Promise<void> {
  const res = await fetch(`/api/portal/projects/${projectId}/documents/${documentId}`, {
    headers: { Authorization: `Bearer ${getPortalToken()}` },
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
