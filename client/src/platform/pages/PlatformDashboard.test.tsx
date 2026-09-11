import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { PlatformAuthProvider } from "../auth/PlatformAuthContext";
import { I18nProvider } from "../../i18n/I18nProvider";
import { PlatformDashboard } from "./PlatformDashboard";
import type { Organization, PlatformActivityEvent, SupportSessionSummary } from "../api/types";

vi.mock("../api/platformClient", async () => {
  const actual = await vi.importActual<typeof import("../api/platformClient")>("../api/platformClient");
  return { ...actual, getPlatformToken: () => null, platformApiFetch: vi.fn() };
});

import { platformApiFetch } from "../api/platformClient";

const org: Organization = { id: "org-1", name: "شركة الاختبار", createdAt: "2026-01-01T00:00:00.000Z" };
const session: SupportSessionSummary = {
  id: "sess-1",
  targetCompanyId: "org-1",
  targetCompanyName: "شركة الاختبار",
  reason: "investigating a bug",
  createdAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-01-01T00:30:00.000Z",
  revokedAt: null,
  status: "active",
};
const activityEvent: PlatformActivityEvent = {
  id: "evt-1",
  action: "supportSession.granted",
  entityType: "support_session",
  entityId: "sess-1",
  companyId: "org-1",
  companyName: "شركة الاختبار",
  reason: "investigating a bug",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function defaultRouteHandler(path: string) {
  if (path.startsWith("/health/live")) return Promise.resolve({ status: "ok" });
  if (path.startsWith("/health/ready")) return Promise.resolve({ status: "ok" });
  if (path.startsWith("/platform/organizations")) return Promise.resolve({ organizations: [org], limit: 5, offset: 0, hasMore: false });
  if (path.startsWith("/platform/support-sessions/")) return Promise.reject(new Error(`unexpected: ${path}`));
  if (path.startsWith("/platform/support-sessions")) return Promise.resolve({ sessions: [session], limit: 5, offset: 0, hasMore: false });
  if (path.startsWith("/platform/audit-events")) return Promise.resolve({ events: [activityEvent], limit: 10, offset: 0, hasMore: false });
  return Promise.reject(new Error(`unexpected: ${path}`));
}

function mockDefault(overrides: Partial<Record<string, () => Promise<unknown>>> = {}) {
  vi.mocked(platformApiFetch).mockImplementation((path: unknown) => {
    const p = String(path);
    for (const [prefix, handler] of Object.entries(overrides)) {
      if (handler && p.startsWith(prefix)) return handler();
    }
    return defaultRouteHandler(p);
  });
}

function renderDashboard() {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={["/platform"]}>
        <PlatformAuthProvider>
          <Routes>
            <Route path="/platform" element={<PlatformDashboard />} />
            <Route path="/platform/organizations" element={<div>صفحة المؤسسات</div>} />
            <Route path="/platform/support-sessions" element={<div>صفحة جلسات الدعم</div>} />
            <Route path="/platform/support-sessions/:id" element={<div>صفحة تفاصيل الجلسة</div>} />
          </Routes>
        </PlatformAuthProvider>
      </MemoryRouter>
    </I18nProvider>,
  );
}

describe("<PlatformDashboard/>", () => {
  it("shows a loading state before data arrives", () => {
    vi.mocked(platformApiFetch).mockImplementation(() => new Promise(() => {}));
    const { container } = renderDashboard();
    expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
  });

  it("renders real health status as healthy when both checks succeed", async () => {
    mockDefault();
    renderDashboard();
    await waitFor(() => expect(screen.getByText("يعمل")).toBeInTheDocument());
    expect(screen.getByText("جاهزة")).toBeInTheDocument();
    expect(screen.getByText("سليمة")).toBeInTheDocument();
  });

  it("renders real health status as unavailable when the readiness check fails, without faking healthy", async () => {
    const { ApiError } = await import("../../api/client");
    mockDefault({ "/health/ready": () => Promise.reject(new ApiError("الخدمة غير جاهزة حالياً", 503)) });
    renderDashboard();
    await waitFor(() => expect(screen.getByText("غير جاهزة")).toBeInTheDocument());
    expect(screen.getByText("تحتاج انتباه")).toBeInTheDocument();
  });

  it("renders real organization data and a working link to the full organizations page", async () => {
    mockDefault();
    renderDashboard();
    await waitFor(() => expect(screen.getAllByText("شركة الاختبار").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText("عرض كل المؤسسات"));
    await waitFor(() => expect(screen.getByText("صفحة المؤسسات")).toBeInTheDocument());
  });

  it("shows an honest empty state for organizations when there are none", async () => {
    mockDefault({ "/platform/organizations": () => Promise.resolve({ organizations: [], limit: 5, offset: 0, hasMore: false }) });
    renderDashboard();
    await waitFor(() => expect(screen.getByText("لا توجد مؤسسات بعد")).toBeInTheDocument());
  });

  it("renders real support session data with active count and navigates to session detail", async () => {
    mockDefault();
    renderDashboard();
    await waitFor(() => expect(screen.getByText(/جلسات الدعم النشطة \(1\)/)).toBeInTheDocument());
    fireEvent.click(screen.getByText("شركة الاختبار", { selector: "p" }));
    await waitFor(() => expect(screen.getByText("صفحة تفاصيل الجلسة")).toBeInTheDocument());
  });

  it("shows an honest empty state for support sessions when there are none", async () => {
    mockDefault({ "/platform/support-sessions": () => Promise.resolve({ sessions: [], limit: 5, offset: 0, hasMore: false }) });
    renderDashboard();
    await waitFor(() => expect(screen.getByText("لا توجد لديك جلسات دعم حتى الآن.")).toBeInTheDocument());
  });

  it("renders real platform activity with company context", async () => {
    mockDefault();
    renderDashboard();
    await waitFor(() => expect(screen.getByText(/منح وصول دعم/)).toBeInTheDocument());
    expect(screen.getByText(/منح وصول دعم/).textContent).toContain("شركة الاختبار");
  });

  it("shows an honest empty state for activity when there is none", async () => {
    mockDefault({ "/platform/audit-events": () => Promise.resolve({ events: [], limit: 10, offset: 0, hasMore: false }) });
    renderDashboard();
    await waitFor(() => expect(screen.getByText("لا يوجد نشاط إداري مسجّل لك بعد.")).toBeInTheDocument());
  });

  it("shows an error state with retry for a failed section independently of the others", async () => {
    const { ApiError } = await import("../../api/client");
    mockDefault({ "/platform/audit-events": () => Promise.reject(new ApiError("تعذّر الاتصال بالخادم", 500)) });
    renderDashboard();
    await waitFor(() => expect(screen.getByText("تعذّر الاتصال بالخادم")).toBeInTheDocument());
    // organizations section still rendered successfully despite the activity failure
    await waitFor(() => expect(screen.getAllByText("شركة الاختبار").length).toBeGreaterThan(0));
  });

  it("never fabricates a fixed 'healthy' status while health checks are still loading", () => {
    vi.mocked(platformApiFetch).mockImplementation(() => new Promise(() => {}));
    renderDashboard();
    expect(screen.queryByText("سليمة")).not.toBeInTheDocument();
    expect(screen.getAllByText("جارٍ الفحص...").length).toBeGreaterThan(0);
  });

  it("renders inside the RTL platform layout", async () => {
    mockDefault();
    const { container } = renderDashboard();
    await waitFor(() => expect(screen.getAllByText("شركة الاختبار").length).toBeGreaterThan(0));
    expect(container.querySelector('[dir="rtl"]')).toBeTruthy();
  });

  it("never triggers any tenant-auth API call", async () => {
    mockDefault();
    renderDashboard();
    await waitFor(() => expect(screen.getAllByText("شركة الاختبار").length).toBeGreaterThan(0));
    const calls = vi.mocked(platformApiFetch).mock.calls.map(([p]) => String(p));
    expect(calls.every((p) => p.startsWith("/health") || p.startsWith("/platform"))).toBe(true);
  });
});
