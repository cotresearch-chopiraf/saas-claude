import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { PlatformAuthProvider } from "../auth/PlatformAuthContext";
import { I18nProvider } from "../../i18n/I18nProvider";
import { PlatformBackupCenter } from "./PlatformBackupCenter";
import type { BackupCenterStatus } from "../api/types";

vi.mock("../api/platformClient", async () => {
  const actual = await vi.importActual<typeof import("../api/platformClient")>("../api/platformClient");
  return { ...actual, getPlatformToken: () => null, platformApiFetch: vi.fn() };
});

import { platformApiFetch } from "../api/platformClient";

function renderPage() {
  return render(
    <I18nProvider>
      <MemoryRouter>
        <PlatformAuthProvider>
          <PlatformBackupCenter />
        </PlatformAuthProvider>
      </MemoryRouter>
    </I18nProvider>,
  );
}

describe("<PlatformBackupCenter/>", () => {
  it("shows a warning when no backup is found", async () => {
    const status: BackupCenterStatus = { found: false, backupDirectory: "/backups", manifest: null, ageSeconds: null, restoreDrillTrackedIn: "docs/BACKUP_STRATEGY.md" };
    vi.mocked(platformApiFetch).mockResolvedValue(status);
    renderPage();
    await waitFor(() => expect(screen.getByText("لم يتم العثور على نسخة احتياطية")).toBeInTheDocument());
  });

  it("renders manifest details for the latest backup", async () => {
    const status: BackupCenterStatus = {
      found: true,
      backupDirectory: "/backups",
      manifest: {
        manifestVersion: "1",
        createdAt: "2026-01-01T00:00:00.000Z",
        app: { packageVersion: "0.1.0" },
        schema: { migrationCount: 50, latestMigrationTag: "0050_woozy_red_ghost" },
        database: { dumpFile: "database.dump", format: "custom", checksumSha256: "abc", sizeBytes: 1024, rowCounts: {} },
        storage: { included: true, provider: "local" },
      },
      ageSeconds: 3600,
      restoreDrillTrackedIn: "docs/BACKUP_STRATEGY.md",
    };
    vi.mocked(platformApiFetch).mockResolvedValue(status);
    renderPage();
    await waitFor(() => expect(screen.getByText(/0050_woozy_red_ghost/)).toBeInTheDocument());
    expect(screen.getByText(/docs\/BACKUP_STRATEGY\.md/)).toBeInTheDocument();
  });
});
