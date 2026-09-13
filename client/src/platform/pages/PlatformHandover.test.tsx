import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { PlatformAuthProvider } from "../auth/PlatformAuthContext";
import { I18nProvider } from "../../i18n/I18nProvider";
import { PlatformHandover } from "./PlatformHandover";
import type { HandoverSummary } from "../api/types";

vi.mock("../api/platformClient", async () => {
  const actual = await vi.importActual<typeof import("../api/platformClient")>("../api/platformClient");
  return { ...actual, getPlatformToken: () => null, platformApiFetch: vi.fn() };
});

import { platformApiFetch } from "../api/platformClient";

const summary: HandoverSummary = {
  organizations: { total: 4, active: 3, suspended: 1 },
  platformOperators: { total: 2, owners: 1, admins: 1, active: 2 },
  featureFlags: { total: 5, globallyEnabled: 2 },
  plans: { total: 3, active: 2 },
  openIncidents: { open: 1, investigating: 0 },
  backup: { found: true, ageSeconds: 120, restoreDrillTrackedIn: "docs/BACKUP_STRATEGY.md" },
  schema: { migrationCount: 50, latestMigrationTag: "0050_woozy_red_ghost" },
  zatca: { liveExternalVerification: false, statusDocument: "docs/zatca/LIVE_SANDBOX_VERIFICATION.md" },
  notAvailable: ["productionHostingProvider", "automatedBackupsEnabled"],
  launchChecklistDocument: "docs/PRODUCTION_LAUNCH_CHECKLIST.md",
};

function renderPage() {
  return render(
    <I18nProvider>
      <MemoryRouter>
        <PlatformAuthProvider>
          <PlatformHandover />
        </PlatformAuthProvider>
      </MemoryRouter>
    </I18nProvider>,
  );
}

describe("<PlatformHandover/>", () => {
  it("renders real aggregate figures and never hides the notAvailable list", async () => {
    vi.mocked(platformApiFetch).mockResolvedValue(summary);
    renderPage();
    await waitFor(() => expect(screen.getByText("3 / 4")).toBeInTheDocument());
    expect(screen.getByText("productionHostingProvider")).toBeInTheDocument();
    expect(screen.getByText("automatedBackupsEnabled")).toBeInTheDocument();
    expect(screen.getByText("docs/zatca/LIVE_SANDBOX_VERIFICATION.md")).toBeInTheDocument();
  });

  it("shows an error state on load failure", async () => {
    const { ApiError } = await import("../../api/client");
    vi.mocked(platformApiFetch).mockRejectedValue(new ApiError("تعذّر تحميل ملخّص التسليم", 500));
    renderPage();
    await waitFor(() => expect(screen.getByText("تعذّر تحميل ملخّص التسليم")).toBeInTheDocument());
  });
});
