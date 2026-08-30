import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { PlatformAuthProvider } from "../auth/PlatformAuthContext";
import { PlatformOrganizations } from "./PlatformOrganizations";
import { PlatformSupportSession } from "./PlatformSupportSession";
import type { Organization, OrganizationPage } from "../api/types";

vi.mock("../api/platformClient", async () => {
  const actual = await vi.importActual<typeof import("../api/platformClient")>("../api/platformClient");
  return { ...actual, getPlatformToken: () => null, platformApiFetch: vi.fn() };
});

import { platformApiFetch } from "../api/platformClient";

const orgA: Organization = { id: "org-1", name: "شركة الاختبار", createdAt: "2026-01-01T00:00:00.000Z" };

function mockList(page: OrganizationPage) {
  vi.mocked(platformApiFetch).mockImplementation((path: unknown) => {
    const p = String(path);
    if (p.startsWith("/platform/organizations")) return Promise.resolve(page);
    return Promise.reject(new Error(`unexpected: ${p}`));
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/platform/organizations"]}>
      <PlatformAuthProvider>
        <Routes>
          <Route path="/platform/organizations" element={<PlatformOrganizations />} />
          <Route path="/platform/support-sessions/:id" element={<PlatformSupportSession />} />
        </Routes>
      </PlatformAuthProvider>
    </MemoryRouter>,
  );
}

describe("<PlatformOrganizations/>", () => {
  it("renders organizations from backend-provided data", async () => {
    mockList({ organizations: [orgA], limit: 20, offset: 0, hasMore: false });
    renderPage();
    await waitFor(() => expect(screen.getByText("شركة الاختبار")).toBeInTheDocument());
  });

  it("shows an honest empty state when there are no organizations", async () => {
    mockList({ organizations: [], limit: 20, offset: 0, hasMore: false });
    renderPage();
    await waitFor(() => expect(screen.getByText("لا توجد شركات بعد")).toBeInTheDocument());
  });

  it("shows an error state with retry on failure", async () => {
    const { ApiError } = await import("../../api/client");
    vi.mocked(platformApiFetch).mockRejectedValue(new ApiError("تعذّر الاتصال", 500));
    renderPage();
    await waitFor(() => expect(screen.getByText("تعذّر الاتصال")).toBeInTheDocument());
    expect(screen.getByText("إعادة المحاولة")).toBeInTheDocument();
  });

  it("shows load-more when hasMore is true and appends the next page", async () => {
    mockList({ organizations: [orgA], limit: 1, offset: 0, hasMore: true });
    renderPage();
    await waitFor(() => expect(screen.getByText("تحميل المزيد")).toBeInTheDocument());

    const orgB: Organization = { id: "org-2", name: "شركة ثانية", createdAt: "2026-01-02T00:00:00.000Z" };
    vi.mocked(platformApiFetch).mockImplementation((path: unknown) => {
      const p = String(path);
      if (p.includes("offset=1")) return Promise.resolve({ organizations: [orgB], limit: 1, offset: 1, hasMore: false });
      return Promise.reject(new Error(`unexpected: ${p}`));
    });
    fireEvent.click(screen.getByText("تحميل المزيد"));

    await waitFor(() => expect(screen.getByText("شركة ثانية")).toBeInTheDocument());
    expect(screen.queryByText("تحميل المزيد")).not.toBeInTheDocument();
  });

  it("requesting support access creates a session and navigates to its activity view", async () => {
    mockList({ organizations: [orgA], limit: 20, offset: 0, hasMore: false });
    renderPage();
    await waitFor(() => expect(screen.getByText("شركة الاختبار")).toBeInTheDocument());

    fireEvent.click(screen.getByText("طلب وصول دعم"));
    fireEvent.change(screen.getByPlaceholderText("سبب طلب الوصول"), { target: { value: "investigating a bug" } });

    let capturedBody: unknown = null;
    vi.mocked(platformApiFetch).mockImplementation((path: unknown, opts?: RequestInit) => {
      const p = String(path);
      const method = opts?.method;
      if (p === "/platform/support-sessions" && method === "POST") {
        capturedBody = JSON.parse(opts!.body as string);
        return Promise.resolve({ id: "sess-1", targetCompanyId: orgA.id, reason: "investigating a bug", createdAt: "x", expiresAt: "y" });
      }
      if (p.startsWith("/platform/support-sessions/sess-1/activity")) {
        return Promise.resolve({ events: [], limit: 20, offset: 0, hasMore: false });
      }
      return Promise.reject(new Error(`unexpected: ${p} ${method}`));
    });

    fireEvent.click(screen.getByRole("button", { name: "منح الوصول" }));

    await waitFor(() => expect(capturedBody).toEqual({ targetCompanyId: orgA.id, reason: "investigating a bug" }));
    await waitFor(() => expect(screen.getByText(`سجل نشاط — ${orgA.name}`)).toBeInTheDocument());
  });
});
