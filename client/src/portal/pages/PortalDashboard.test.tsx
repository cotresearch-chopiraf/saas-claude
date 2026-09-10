import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ClientPortalAuthProvider } from "../auth/ClientPortalAuthContext";
import { PortalDashboard } from "./PortalDashboard";
import type { PortalProject } from "../api/types";

vi.mock("../api/portalClient", async () => {
  const actual = await vi.importActual<typeof import("../api/portalClient")>("../api/portalClient");
  return { ...actual, getPortalToken: () => "fake-portal-token", portalApiFetch: vi.fn() };
});

import { portalApiFetch } from "../api/portalClient";

const fixtureProject: PortalProject = {
  id: "proj-1",
  name: "مشروع الرياض",
  status: "active",
  startDate: "2026-01-15",
  clientName: "شركة العميل",
  address: "الرياض",
};

function seedStoredUser() {
  localStorage.setItem("midad_portal_user", JSON.stringify({ id: "cp1", name: "أحمد العميل", email: "client@test.com" }));
}

function renderDashboard() {
  return render(
    <MemoryRouter initialEntries={["/portal"]}>
      <ClientPortalAuthProvider>
        <Routes>
          <Route path="/portal" element={<PortalDashboard />} />
          <Route path="/portal/login" element={<div>صفحة تسجيل الدخول</div>} />
          <Route path="/portal/projects/:projectId" element={<div>صفحة تفاصيل المشروع</div>} />
        </Routes>
      </ClientPortalAuthProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
});

describe("<PortalDashboard/>", () => {
  it("shows a loading state, then the client's name and their granted projects", async () => {
    seedStoredUser();
    vi.mocked(portalApiFetch).mockResolvedValue([fixtureProject]);
    renderDashboard();

    await waitFor(() => expect(screen.getAllByText("أحمد العميل").length).toBeGreaterThan(0));
    expect(screen.getByText("مشروع الرياض")).toBeInTheDocument();
    expect(screen.getByText("قيد التنفيذ")).toBeInTheDocument();
  });

  it("shows an honest empty state when the client has no granted projects", async () => {
    seedStoredUser();
    vi.mocked(portalApiFetch).mockResolvedValue([]);
    renderDashboard();

    await waitFor(() => expect(screen.getByText(/لا توجد مشاريع متاحة حالياً/)).toBeInTheDocument());
  });

  it("shows an error state on a non-401 API failure, without logging the client out", async () => {
    seedStoredUser();
    const { ApiError } = await import("../../api/client");
    vi.mocked(portalApiFetch).mockRejectedValue(new ApiError("تعذّر الاتصال بالخادم", 500));
    renderDashboard();

    await waitFor(() => expect(screen.getByText("تعذّر الاتصال بالخادم")).toBeInTheDocument());
    expect(screen.getAllByText("أحمد العميل").length).toBeGreaterThan(0);
  });

  it("a 401 (revoked session/disabled account) redirects to the portal login screen", async () => {
    seedStoredUser();
    const { ApiError } = await import("../../api/client");
    vi.mocked(portalApiFetch).mockRejectedValue(new ApiError("جلسة غير صالحة", 401));
    renderDashboard();

    await waitFor(() => expect(screen.getByText("صفحة تسجيل الدخول")).toBeInTheDocument());
  });

  it("never renders financial or internal fields anywhere on the dashboard", async () => {
    seedStoredUser();
    vi.mocked(portalApiFetch).mockResolvedValue([fixtureProject]);
    renderDashboard();

    await waitFor(() => expect(screen.getByText("مشروع الرياض")).toBeInTheDocument());
    const bodyText = document.body.textContent ?? "";
    expect(bodyText).not.toMatch(/ميزانية|التكلفة الفعلية|الالتزامات|التوقعات المالية|التدفق النقدي|هامش الربح/);
  });

  it("a project card links to its detail page", async () => {
    seedStoredUser();
    vi.mocked(portalApiFetch).mockResolvedValue([fixtureProject]);
    renderDashboard();

    await waitFor(() => expect(screen.getByText("مشروع الرياض")).toBeInTheDocument());
    const link = screen.getByText("مشروع الرياض").closest("a");
    expect(link).toHaveAttribute("href", "/portal/projects/proj-1");
  });
});
