import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { PlatformAuthProvider } from "../auth/PlatformAuthContext";
import { I18nProvider } from "../../i18n/I18nProvider";
import { PlatformTenantImport } from "./PlatformTenantImport";
import type { TenantExportBundle, TenantImportPreview } from "../api/types";

vi.mock("../api/platformClient", async () => {
  const actual = await vi.importActual<typeof import("../api/platformClient")>("../api/platformClient");
  return { ...actual, getPlatformToken: () => null, platformApiFetch: vi.fn() };
});

import { platformApiFetch } from "../api/platformClient";

const bundle: TenantExportBundle = {
  manifest: {
    manifestVersion: "1",
    exportedAt: "2026-01-01T00:00:00.000Z",
    schema: { migrationCount: 50, latestMigrationTag: "0050_woozy_red_ghost" },
    companyId: "org-1",
    companyName: "شركة الاختبار",
    includesAuditEvents: true,
    includesDocumentBytes: false,
    redactedColumns: {},
    excludedTables: [],
    tableRowCounts: {},
    checksumSha256: "abc",
  },
  company: {},
  tables: {},
};

function renderPage() {
  return render(
    <I18nProvider>
      <MemoryRouter>
        <PlatformAuthProvider>
          <PlatformTenantImport />
        </PlatformAuthProvider>
      </MemoryRouter>
    </I18nProvider>,
  );
}

function makeFile(bundle: TenantExportBundle): File {
  return new File([JSON.stringify(bundle)], "export.json", { type: "application/json" });
}

describe("<PlatformTenantImport/>", () => {
  it("validates an uploaded file and blocks import when the company already exists", async () => {
    const preview: TenantImportPreview = {
      manifest: bundle.manifest,
      companyName: "شركة الاختبار",
      checksumValid: true,
      schemaCompatible: true,
      currentSchemaLatestTag: "0050_woozy_red_ghost",
      companyIdAlreadyExists: true,
      canImport: false,
      blockers: ["company_id_already_exists"],
    };
    vi.mocked(platformApiFetch).mockResolvedValue(preview);

    renderPage();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [makeFile(bundle)] } });

    await waitFor(() => expect(screen.getByText("شركة الاختبار")).toBeInTheDocument());
    expect(screen.getByText(/توجد مؤسسة بهذا المعرّف بالفعل/)).toBeInTheDocument();
    expect(screen.queryByText("تأكيد الاستيراد")).not.toBeInTheDocument();
  });

  it("allows confirming import once canImport is true and the name matches", async () => {
    const preview: TenantImportPreview = {
      manifest: bundle.manifest,
      companyName: "شركة الاختبار",
      checksumValid: true,
      schemaCompatible: true,
      currentSchemaLatestTag: "0050_woozy_red_ghost",
      companyIdAlreadyExists: false,
      canImport: true,
      blockers: [],
    };
    vi.mocked(platformApiFetch).mockResolvedValue(preview);

    renderPage();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [makeFile(bundle)] } });

    await waitFor(() => expect(screen.getByText("تأكيد الاستيراد")).toBeInTheDocument());

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "شركة الاختبار" } });

    let capturedBody: unknown = null;
    vi.mocked(platformApiFetch).mockImplementation((path: unknown, opts?: RequestInit) => {
      if (String(path) === "/platform/tenant-import/confirm" && opts?.method === "POST") {
        capturedBody = JSON.parse(opts.body as string);
        return Promise.resolve({
          companyId: "org-1",
          companyName: "شركة الاختبار",
          importedTableRowCounts: {},
          verified: true,
          passwordResetRequiredForImportedUsers: true,
        });
      }
      return Promise.reject(new Error(`unexpected: ${path}`));
    });

    fireEvent.click(screen.getByText("تأكيد الاستيراد"));
    await waitFor(() => expect(screen.getByText("اكتمل الاستيراد")).toBeInTheDocument());
    expect(capturedBody).toMatchObject({ confirmationCompanyName: "شركة الاختبار" });
  });
});
