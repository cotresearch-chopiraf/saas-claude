import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { PlatformAuthProvider } from "../auth/PlatformAuthContext";
import { I18nProvider } from "../../i18n/I18nProvider";
import { PlatformFeatureFlags } from "./PlatformFeatureFlags";
import type { FeatureFlag } from "../api/types";

vi.mock("../api/platformClient", async () => {
  const actual = await vi.importActual<typeof import("../api/platformClient")>("../api/platformClient");
  return { ...actual, getPlatformToken: () => null, platformApiFetch: vi.fn() };
});

import { platformApiFetch } from "../api/platformClient";

const flag: FeatureFlag = {
  id: "f-1",
  key: "new_dashboard",
  description: "لوحة تحكم جديدة",
  globalEnabled: false,
  defaultEnabledForOrgs: false,
  enabledEnvironments: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function renderPage() {
  return render(
    <I18nProvider>
      <MemoryRouter>
        <PlatformAuthProvider>
          <PlatformFeatureFlags />
        </PlatformAuthProvider>
      </MemoryRouter>
    </I18nProvider>,
  );
}

describe("<PlatformFeatureFlags/>", () => {
  it("renders flags with their global/default state", async () => {
    vi.mocked(platformApiFetch).mockResolvedValue({ flags: [flag] });
    renderPage();
    await waitFor(() => expect(screen.getByText("new_dashboard")).toBeInTheDocument());
    expect(screen.getByText("معطّلة للجميع")).toBeInTheDocument();
  });

  it("opens overrides and adds a per-company override", async () => {
    vi.mocked(platformApiFetch).mockImplementation((path: unknown) => {
      const p = String(path);
      if (p === "/platform/feature-flags") return Promise.resolve({ flags: [flag] });
      if (p === "/platform/feature-flags/new_dashboard/overrides") return Promise.resolve({ overrides: [] });
      return Promise.reject(new Error(`unexpected: ${p}`));
    });
    renderPage();
    await waitFor(() => expect(screen.getByText("new_dashboard")).toBeInTheDocument());

    fireEvent.click(screen.getByText("الاستثناءات"));
    await waitFor(() => expect(screen.getByText("لا توجد استثناءات لهذه الميزة.")).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText("معرّف المؤسسة"), { target: { value: "org-1" } });

    let capturedPath = "";
    let capturedBody: unknown = null;
    vi.mocked(platformApiFetch).mockImplementation((path: unknown, opts?: RequestInit) => {
      capturedPath = String(path);
      if (opts?.method === "PUT") {
        capturedBody = JSON.parse(opts.body as string);
        return Promise.resolve({ id: "o-1", companyId: "org-1", flagKey: "new_dashboard", enabled: true, setByPlatformOperatorId: "op-1", updatedAt: "x" });
      }
      return Promise.resolve({ overrides: [] });
    });

    fireEvent.click(screen.getByText("فرض التفعيل"));
    await waitFor(() => expect(capturedPath).toBe("/platform/feature-flags/new_dashboard/overrides/org-1"));
    expect(capturedBody).toEqual({ enabled: true });
  });
});
