import { platformApiFetch } from "./platformClient";
import type { TenantExportBundle, TenantImportPreview, TenantImportResult } from "./types";

export function exportOrganization(id: string): Promise<TenantExportBundle> {
  return platformApiFetch(`/platform/organizations/${id}/export`, { method: "POST" });
}

export function validateTenantImport(bundle: TenantExportBundle): Promise<TenantImportPreview> {
  return platformApiFetch("/platform/tenant-import/validate", { method: "POST", body: JSON.stringify({ bundle }) });
}

export function confirmTenantImport(bundle: TenantExportBundle, confirmationCompanyName: string): Promise<TenantImportResult> {
  return platformApiFetch("/platform/tenant-import/confirm", {
    method: "POST",
    body: JSON.stringify({ bundle, confirmationCompanyName }),
  });
}
