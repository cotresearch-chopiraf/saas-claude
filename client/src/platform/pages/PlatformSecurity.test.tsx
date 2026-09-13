import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { PlatformAuthProvider } from "../auth/PlatformAuthContext";
import { I18nProvider } from "../../i18n/I18nProvider";
import { PlatformSecurity } from "./PlatformSecurity";
import type { SecurityOverview } from "../api/types";

vi.mock("../api/platformClient", async () => {
  const actual = await vi.importActual<typeof import("../api/platformClient")>("../api/platformClient");
  return { ...actual, getPlatformToken: () => null, platformApiFetch: vi.fn() };
});

import { platformApiFetch } from "../api/platformClient";

const overview: SecurityOverview = {
  adminSessions: { total: 3, active: 1, expired: 1, revoked: 1 },
  tenantSessions: { activeCount: 5, oldestActiveSessionCreatedAt: null, oldestActiveSessionAgeSeconds: null },
  notAvailable: ["failedLoginEvents"],
};

function renderPage() {
  return render(
    <I18nProvider>
      <MemoryRouter>
        <PlatformAuthProvider>
          <PlatformSecurity />
        </PlatformAuthProvider>
      </MemoryRouter>
    </I18nProvider>,
  );
}

describe("<PlatformSecurity/>", () => {
  it("renders the overview tab with real counts and the honesty note", async () => {
    vi.mocked(platformApiFetch).mockResolvedValue(overview);
    renderPage();
    await waitFor(() => expect(screen.getByText("5")).toBeInTheDocument());
    expect(screen.getAllByText("1").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/failedLoginEvents/)).toBeInTheDocument();
  });

  it("switches to the sensitive actions tab and loads its feed", async () => {
    vi.mocked(platformApiFetch).mockImplementation((path: unknown) => {
      const p = String(path);
      if (p === "/platform/security/overview") return Promise.resolve(overview);
      if (p.startsWith("/platform/security/sensitive-actions")) {
        return Promise.resolve({
          events: [
            {
              id: "e-1",
              action: "organization.suspended",
              entityType: "company",
              entityId: "org-1",
              companyId: "org-1",
              companyName: "شركة الاختبار",
              platformOperatorId: "op-1",
              platformOperatorName: "المشغّل",
              reason: "شكوى",
              metadata: {},
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          limit: 20,
          offset: 0,
          hasMore: false,
        });
      }
      return Promise.reject(new Error(`unexpected: ${p}`));
    });
    renderPage();
    await waitFor(() => expect(screen.getByText("5")).toBeInTheDocument());

    fireEvent.click(screen.getByText("الإجراءات الحساسة"));
    await waitFor(() => expect(screen.getByText(/organization.suspended/)).toBeInTheDocument());
  });
});
