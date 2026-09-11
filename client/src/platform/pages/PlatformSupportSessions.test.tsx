import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { PlatformAuthProvider } from "../auth/PlatformAuthContext";
import { I18nProvider } from "../../i18n/I18nProvider";
import { PlatformSupportSessions } from "./PlatformSupportSessions";
import type { SupportSessionListPage, SupportSessionSummary } from "../api/types";

vi.mock("../api/platformClient", async () => {
  const actual = await vi.importActual<typeof import("../api/platformClient")>("../api/platformClient");
  return { ...actual, getPlatformToken: () => null, platformApiFetch: vi.fn() };
});

import { platformApiFetch } from "../api/platformClient";

const activeSession: SupportSessionSummary = {
  id: "sess-active",
  targetCompanyId: "org-1",
  targetCompanyName: "شركة الاختبار",
  reason: "investigating a bug",
  createdAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-01-01T00:30:00.000Z",
  revokedAt: null,
  status: "active",
};

const expiredSession: SupportSessionSummary = {
  ...activeSession,
  id: "sess-expired",
  targetCompanyId: "org-2",
  targetCompanyName: "شركة منتهية",
  status: "expired",
};

const revokedSession: SupportSessionSummary = {
  ...activeSession,
  id: "sess-revoked",
  targetCompanyId: "org-3",
  targetCompanyName: "شركة ملغاة",
  revokedAt: "2026-01-01T00:10:00.000Z",
  status: "revoked",
};

function mockList(page: SupportSessionListPage) {
  vi.mocked(platformApiFetch).mockImplementation((path: unknown) => {
    const p = String(path);
    if (p.startsWith("/platform/support-sessions")) return Promise.resolve(page);
    return Promise.reject(new Error(`unexpected: ${p}`));
  });
}

function renderPage() {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={["/platform/support-sessions"]}>
        <PlatformAuthProvider>
          <Routes>
            <Route path="/platform/support-sessions" element={<PlatformSupportSessions />} />
            <Route path="/platform/support-sessions/:id" element={<div>صفحة تفاصيل الجلسة</div>} />
          </Routes>
        </PlatformAuthProvider>
      </MemoryRouter>
    </I18nProvider>,
  );
}

describe("<PlatformSupportSessions/>", () => {
  it("shows a loading state before data arrives", () => {
    vi.mocked(platformApiFetch).mockImplementation(() => new Promise(() => {}));
    const { container } = renderPage();
    expect(container.querySelector(".animate-pulse")).toBeTruthy();
  });

  it("renders an active session with its status badge and organization name", async () => {
    mockList({ sessions: [activeSession], limit: 20, offset: 0, hasMore: false });
    renderPage();
    await waitFor(() => expect(screen.getByText("شركة الاختبار")).toBeInTheDocument());
    expect(screen.getByText("نشطة")).toBeInTheDocument();
    expect(screen.getByText("investigating a bug")).toBeInTheDocument();
  });

  it("renders an expired session with its status badge", async () => {
    mockList({ sessions: [expiredSession], limit: 20, offset: 0, hasMore: false });
    renderPage();
    await waitFor(() => expect(screen.getByText("شركة منتهية")).toBeInTheDocument());
    expect(screen.getByText("منتهية")).toBeInTheDocument();
  });

  it("renders a revoked session with its status badge", async () => {
    mockList({ sessions: [revokedSession], limit: 20, offset: 0, hasMore: false });
    renderPage();
    await waitFor(() => expect(screen.getByText("شركة ملغاة")).toBeInTheDocument());
    expect(screen.getByText("ملغاة")).toBeInTheDocument();
  });

  it("shows an honest empty state when the operator has no sessions", async () => {
    mockList({ sessions: [], limit: 20, offset: 0, hasMore: false });
    renderPage();
    await waitFor(() => expect(screen.getByText("لا توجد لديك جلسات دعم حتى الآن.")).toBeInTheDocument());
  });

  it("shows an error state with retry on failure", async () => {
    const { ApiError } = await import("../../api/client");
    vi.mocked(platformApiFetch).mockRejectedValue(new ApiError("تعذّر الاتصال", 500));
    renderPage();
    await waitFor(() => expect(screen.getByText("تعذّر الاتصال")).toBeInTheDocument());
    expect(screen.getByText("إعادة المحاولة")).toBeInTheDocument();
  });

  it("shows load-more when hasMore is true and appends the next page", async () => {
    mockList({ sessions: [activeSession], limit: 1, offset: 0, hasMore: true });
    renderPage();
    await waitFor(() => expect(screen.getByText("تحميل المزيد")).toBeInTheDocument());

    vi.mocked(platformApiFetch).mockImplementation((path: unknown) => {
      const p = String(path);
      if (p.includes("offset=1")) return Promise.resolve({ sessions: [expiredSession], limit: 1, offset: 1, hasMore: false });
      return Promise.reject(new Error(`unexpected: ${p}`));
    });
    fireEvent.click(screen.getByText("تحميل المزيد"));

    await waitFor(() => expect(screen.getByText("شركة منتهية")).toBeInTheDocument());
    expect(screen.queryByText("تحميل المزيد")).not.toBeInTheDocument();
  });

  it("clicking a session's open link navigates to the existing session detail page", async () => {
    mockList({ sessions: [activeSession], limit: 20, offset: 0, hasMore: false });
    renderPage();
    await waitFor(() => expect(screen.getByText("شركة الاختبار")).toBeInTheDocument());

    fireEvent.click(screen.getByText("فتح"));

    await waitFor(() => expect(screen.getByText("صفحة تفاصيل الجلسة")).toBeInTheDocument());
  });

  it("renders inside the RTL platform layout", async () => {
    mockList({ sessions: [activeSession], limit: 20, offset: 0, hasMore: false });
    const { container } = renderPage();
    await waitFor(() => expect(screen.getByText("شركة الاختبار")).toBeInTheDocument());
    expect(container.querySelector('[dir="rtl"]')).toBeTruthy();
  });

  it("falls back to a neutral label when a session has no organization name", async () => {
    mockList({ sessions: [{ ...activeSession, targetCompanyName: null }], limit: 20, offset: 0, hasMore: false });
    renderPage();
    await waitFor(() => expect(screen.getByText("شركة غير معروفة")).toBeInTheDocument());
  });

  it("never triggers any tenant-auth API call", async () => {
    mockList({ sessions: [activeSession], limit: 20, offset: 0, hasMore: false });
    renderPage();
    await waitFor(() => expect(screen.getByText("شركة الاختبار")).toBeInTheDocument());
    expect(vi.mocked(platformApiFetch).mock.calls.every(([path]) => String(path).startsWith("/platform/support-sessions"))).toBe(true);
  });

  it("requests only the authenticated operator's sessions, never a client-supplied scope filter", async () => {
    let capturedPath = "";
    vi.mocked(platformApiFetch).mockImplementation((path: unknown) => {
      capturedPath = String(path);
      return Promise.resolve({ sessions: [], limit: 20, offset: 0, hasMore: false });
    });
    renderPage();
    await waitFor(() => expect(capturedPath).toContain("/platform/support-sessions"));
    expect(capturedPath).not.toMatch(/platformOperatorId|operatorId|companyId/);
  });
});
