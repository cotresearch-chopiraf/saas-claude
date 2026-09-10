import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ClientPortalAuthProvider } from "../auth/ClientPortalAuthContext";
import { PortalProjectDetail } from "./PortalProjectDetail";
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

function renderDetail(projectId = "proj-1") {
  return render(
    <MemoryRouter initialEntries={[`/portal/projects/${projectId}`]}>
      <ClientPortalAuthProvider>
        <Routes>
          <Route path="/portal" element={<div>صفحة المشاريع</div>} />
          <Route path="/portal/login" element={<div>صفحة تسجيل الدخول</div>} />
          <Route path="/portal/projects/:projectId" element={<PortalProjectDetail />} />
        </Routes>
      </ClientPortalAuthProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
});

describe("<PortalProjectDetail/>", () => {
  it("renders only the fields the API actually returned, never a budget/forecast placeholder", async () => {
    seedStoredUser();
    vi.mocked(portalApiFetch).mockResolvedValue(fixtureProject);
    renderDetail();

    await waitFor(() => expect(screen.getByText("قيد التنفيذ")).toBeInTheDocument());
    expect(screen.getAllByText("مشروع الرياض").length).toBeGreaterThan(0);
    expect(screen.getByText("شركة العميل")).toBeInTheDocument();
    expect(screen.getByText("الرياض")).toBeInTheDocument();

    const bodyText = document.body.textContent ?? "";
    expect(bodyText).not.toMatch(/الميزانية|التكلفة الفعلية|الالتزامات|التوقعات المالية|التدفق النقدي/);
  });

  it("an unauthorized or nonexistent project (404) shows a generic not-found message, never distinguishing the two", async () => {
    seedStoredUser();
    const { ApiError } = await import("../../api/client");
    vi.mocked(portalApiFetch).mockRejectedValue(new ApiError("المشروع غير موجود", 404));
    renderDetail("proj-not-granted");

    await waitFor(() => expect(screen.getByText("المشروع غير موجود")).toBeInTheDocument());
  });

  it("a 401 (revoked session/disabled account) redirects to the portal login screen", async () => {
    seedStoredUser();
    const { ApiError } = await import("../../api/client");
    vi.mocked(portalApiFetch).mockRejectedValue(new ApiError("جلسة غير صالحة", 401));
    renderDetail();

    await waitFor(() => expect(screen.getByText("صفحة تسجيل الدخول")).toBeInTheDocument());
  });

  it("a generic server error shows a retryable error state", async () => {
    seedStoredUser();
    const { ApiError } = await import("../../api/client");
    vi.mocked(portalApiFetch).mockRejectedValue(new ApiError("تعذّر الاتصال بالخادم", 500));
    renderDetail();

    await waitFor(() => expect(screen.getByText("تعذّر الاتصال بالخادم")).toBeInTheDocument());
  });

  it("a project with no clientName/address renders gracefully without empty rows", async () => {
    seedStoredUser();
    vi.mocked(portalApiFetch).mockResolvedValue({ ...fixtureProject, clientName: null, address: null });
    renderDetail();

    await waitFor(() => expect(screen.getByText("قيد التنفيذ")).toBeInTheDocument());
    expect(screen.queryByText("العميل")).not.toBeInTheDocument();
    expect(screen.queryByText("الموقع")).not.toBeInTheDocument();
  });

  it("a link back to the project list is present", async () => {
    seedStoredUser();
    vi.mocked(portalApiFetch).mockResolvedValue(fixtureProject);
    renderDetail();

    await waitFor(() => expect(screen.getByText("العودة إلى مشاريعك")).toBeInTheDocument());
  });
});
