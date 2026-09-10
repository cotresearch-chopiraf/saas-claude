import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ClientPortalAuthProvider } from "../auth/ClientPortalAuthContext";
import { PortalProjectDetail } from "./PortalProjectDetail";
import type { PortalProject, PortalDocument } from "../api/types";

// MIDAD Phase B3 — the client-facing Documents section on the project
// detail page. A separate file from PortalProjectDetail.test.tsx (B2's own
// suite) because it needs path-routed portalApiFetch responses — the
// project fetch and the documents fetch must resolve to genuinely
// different shapes, unlike B2's single mockResolvedValue convention.

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

const fixtureDocuments: PortalDocument[] = [
  { id: "doc-1", fileName: "مخطط المشروع.pdf", mimeType: "application/pdf", size: 204_800, uploadedAt: "2026-09-10T00:00:00.000Z" },
  { id: "doc-2", fileName: "العقد.pdf", mimeType: "application/pdf", size: 102_400, uploadedAt: "2026-09-08T00:00:00.000Z" },
];

function seedStoredUser() {
  localStorage.setItem("midad_portal_user", JSON.stringify({ id: "cp1", name: "أحمد العميل", email: "client@test.com" }));
}

function mockApi(opts: { documents?: PortalDocument[] | "error"; project?: PortalProject | "error" } = {}) {
  const documents = opts.documents ?? fixtureDocuments;
  const project = opts.project ?? fixtureProject;
  vi.mocked(portalApiFetch).mockImplementation(async (path: unknown) => {
    const p = String(path);
    if (p === "/portal/projects/proj-1") {
      if (project === "error") throw new (await import("../../api/client")).ApiError("تعذّر تحميل المشروع", 500);
      return project;
    }
    if (p === "/portal/projects/proj-1/documents") {
      if (documents === "error") throw new (await import("../../api/client")).ApiError("تعذّر تحميل المستندات", 500);
      return documents;
    }
    throw new Error(`unexpected portalApiFetch call in test: ${p}`);
  });
}

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={["/portal/projects/proj-1"]}>
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
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("unexpected global fetch call in test"))),
  );
});

describe("<PortalProjectDetail/> — Documents section (Phase B3)", () => {
  it("renders only explicitly visible documents with their name and date", async () => {
    seedStoredUser();
    mockApi();
    renderDetail();

    await waitFor(() => expect(screen.getByText("مخطط المشروع.pdf")).toBeInTheDocument());
    expect(screen.getByText("العقد.pdf")).toBeInTheDocument();
    expect(screen.getAllByText("عرض/تحميل")).toHaveLength(2);
  });

  it("shows an honest empty state when no documents are visible", async () => {
    seedStoredUser();
    mockApi({ documents: [] });
    renderDetail();

    await waitFor(() => expect(screen.getByText("لا توجد مستندات متاحة لهذا المشروع حالياً")).toBeInTheDocument());
  });

  it("shows a retryable error state on a documents-list failure, independent of the project info above it", async () => {
    seedStoredUser();
    mockApi({ documents: "error" });
    renderDetail();

    await waitFor(() => expect(screen.getAllByText("مشروع الرياض").length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getByText("تعذّر تحميل المستندات")).toBeInTheDocument());

    mockApi({ documents: fixtureDocuments });
    fireEvent.click(screen.getByRole("button", { name: "إعادة المحاولة" }));
    await waitFor(() => expect(screen.getByText("مخطط المشروع.pdf")).toBeInTheDocument());
  });

  it("a download failure shows an inline error without clearing the document list", async () => {
    seedStoredUser();
    mockApi();
    renderDetail();

    await waitFor(() => expect(screen.getByText("مخطط المشروع.pdf")).toBeInTheDocument());

    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 404 }));
    fireEvent.click(screen.getAllByText("عرض/تحميل")[0]);

    await waitFor(() => expect(screen.getByText("تعذّر تنزيل الملف")).toBeInTheDocument());
    expect(screen.getByText("مخطط المشروع.pdf")).toBeInTheDocument();
  });

  it("a successful download requests the authenticated portal document route with the portal token", async () => {
    seedStoredUser();
    mockApi();
    renderDetail();

    await waitFor(() => expect(screen.getByText("مخطط المشروع.pdf")).toBeInTheDocument());

    vi.mocked(fetch).mockResolvedValue(new Response(new Blob(["pdf-bytes"]), { status: 200 }));
    fireEvent.click(screen.getAllByText("عرض/تحميل")[0]);

    await waitFor(() =>
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        "/api/portal/projects/proj-1/documents/doc-1",
        expect.objectContaining({ headers: { Authorization: "Bearer fake-portal-token" } }),
      ),
    );
  });
});
