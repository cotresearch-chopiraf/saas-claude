import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { PlatformAuthProvider } from "../auth/PlatformAuthContext";
import { I18nProvider } from "../../i18n/I18nProvider";
import { PlatformOrganizationDetail } from "./PlatformOrganizationDetail";
import type { OrganizationDetail, PlatformOrgUser } from "../api/types";

vi.mock("../api/platformClient", async () => {
  const actual = await vi.importActual<typeof import("../api/platformClient")>("../api/platformClient");
  return { ...actual, getPlatformToken: () => null, platformApiFetch: vi.fn() };
});

import { platformApiFetch } from "../api/platformClient";

const org: OrganizationDetail = {
  id: "org-1",
  name: "شركة الاختبار",
  createdAt: "2026-01-01T00:00:00.000Z",
  status: "active",
  plan: { key: "pro", name: "الاحترافية" },
  entitlements: {},
  usage: { userCount: 2, projectCount: 3 },
  zatca: { egsUnitCount: 1, byStatus: {} },
};

const orgUser: PlatformOrgUser = { id: "u-1", name: "سارة أحمد", email: "sara@test.com", role: "owner", status: "active", createdAt: "2026-01-01T00:00:00.000Z" };

function mockDefault(overrides: Partial<Record<string, unknown>> = {}) {
  vi.mocked(platformApiFetch).mockImplementation((path: unknown) => {
    const p = String(path);
    if (p === "/platform/organizations/org-1") return Promise.resolve(overrides.org ?? org);
    if (p === "/platform/organizations/org-1/users") return Promise.resolve(overrides.users ?? { users: [orgUser] });
    if (p === "/platform/plans") return Promise.resolve({ plans: [] });
    return Promise.reject(new Error(`unexpected: ${p}`));
  });
}

function renderPage() {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={["/platform/organizations/org-1"]}>
        <PlatformAuthProvider>
          <Routes>
            <Route path="/platform/organizations/:id" element={<PlatformOrganizationDetail />} />
          </Routes>
        </PlatformAuthProvider>
      </MemoryRouter>
    </I18nProvider>,
  );
}

describe("<PlatformOrganizationDetail/>", () => {
  it("renders organization detail, usage metrics, and its users", async () => {
    mockDefault();
    renderPage();
    await waitFor(() => expect(screen.getByText("شركة الاختبار")).toBeInTheDocument());
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("سارة أحمد")).toBeInTheDocument();
  });

  it("shows an error state with retry on load failure", async () => {
    const { ApiError } = await import("../../api/client");
    vi.mocked(platformApiFetch).mockRejectedValue(new ApiError("تعذّر تحميل بيانات المؤسسة", 500));
    renderPage();
    await waitFor(() => expect(screen.getByText("تعذّر تحميل بيانات المؤسسة")).toBeInTheDocument());
  });

  it("suspending requires a reason and calls the suspend endpoint", async () => {
    mockDefault();
    renderPage();
    await waitFor(() => expect(screen.getByText("شركة الاختبار")).toBeInTheDocument());

    fireEvent.click(screen.getByText("تعليق"));
    fireEvent.change(screen.getByPlaceholderText("سبب التعليق"), { target: { value: "شكوى أمنية" } });

    let capturedBody: unknown = null;
    vi.mocked(platformApiFetch).mockImplementation((path: unknown, opts?: RequestInit) => {
      const p = String(path);
      if (p === "/platform/organizations/org-1/suspend" && opts?.method === "POST") {
        capturedBody = JSON.parse(opts.body as string);
        return Promise.resolve({ id: "org-1", status: "suspended", revokedSessionCount: 1 });
      }
      if (p === "/platform/organizations/org-1") return Promise.resolve({ ...org, status: "suspended" });
      if (p === "/platform/organizations/org-1/users") return Promise.resolve({ users: [orgUser] });
      return Promise.reject(new Error(`unexpected: ${p}`));
    });

    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "تعليق" }));
    await waitFor(() => expect(capturedBody).toEqual({ reason: "شكوى أمنية" }));
  });
});
