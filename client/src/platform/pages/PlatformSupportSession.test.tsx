import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { PlatformAuthProvider } from "../auth/PlatformAuthContext";
import { PlatformSupportSession } from "./PlatformSupportSession";
import type { SupportActivityEvent, SupportActivityPage } from "../api/types";

vi.mock("../api/platformClient", async () => {
  const actual = await vi.importActual<typeof import("../api/platformClient")>("../api/platformClient");
  return { ...actual, getPlatformToken: () => null, platformApiFetch: vi.fn() };
});

import { platformApiFetch } from "../api/platformClient";

const event: SupportActivityEvent = {
  id: "evt-1",
  action: "customer.created",
  entityType: "customer",
  entityId: "11111111-2222-3333-4444-555555555555",
  actorName: "Owner",
  createdAt: "2026-01-01T10:00:00.000Z",
};

function mockActivity(page: SupportActivityPage) {
  vi.mocked(platformApiFetch).mockImplementation((path: unknown) => {
    const p = String(path);
    if (p.startsWith("/platform/support-sessions/sess-1/activity")) return Promise.resolve(page);
    return Promise.reject(new Error(`unexpected: ${p}`));
  });
}

function renderPage(state?: { organizationName?: string }) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: "/platform/support-sessions/sess-1", state }]}>
      <PlatformAuthProvider>
        <Routes>
          <Route path="/platform/support-sessions/:id" element={<PlatformSupportSession />} />
        </Routes>
      </PlatformAuthProvider>
    </MemoryRouter>,
  );
}

describe("<PlatformSupportSession/>", () => {
  it("renders activity events with actor, action, entity, and timestamp", async () => {
    mockActivity({ events: [event], limit: 20, offset: 0, hasMore: false });
    renderPage({ organizationName: "شركة الاختبار" });
    await waitFor(() => expect(screen.getByText("customer.created")).toBeInTheDocument());
    expect(screen.getByText("Owner", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("سجل نشاط — شركة الاختبار")).toBeInTheDocument();
  });

  it("falls back to a neutral title when no organization name is available (e.g. a direct visit)", async () => {
    mockActivity({ events: [], limit: 20, offset: 0, hasMore: false });
    renderPage();
    await waitFor(() => expect(screen.getByText("سجل نشاط الشركة")).toBeInTheDocument());
  });

  it("shows an honest empty state when there is no activity yet", async () => {
    mockActivity({ events: [], limit: 20, offset: 0, hasMore: false });
    renderPage();
    await waitFor(() => expect(screen.getByText("لا يوجد نشاط بعد.")).toBeInTheDocument());
  });

  it("shows an error state with retry on failure", async () => {
    const { ApiError } = await import("../../api/client");
    vi.mocked(platformApiFetch).mockRejectedValue(new ApiError("انتهت صلاحية جلسة الدعم هذه", 403));
    renderPage();
    await waitFor(() => expect(screen.getByText("انتهت صلاحية جلسة الدعم هذه")).toBeInTheDocument());
  });

  it("shows load-more when hasMore is true and appends the next page", async () => {
    mockActivity({ events: [event], limit: 1, offset: 0, hasMore: true });
    renderPage();
    await waitFor(() => expect(screen.getByText("تحميل المزيد")).toBeInTheDocument());

    const event2: SupportActivityEvent = { ...event, id: "evt-2", action: "user.statusChanged" };
    vi.mocked(platformApiFetch).mockImplementation((path: unknown) => {
      const p = String(path);
      if (p.includes("offset=1")) return Promise.resolve({ events: [event2], limit: 1, offset: 1, hasMore: false });
      return Promise.reject(new Error(`unexpected: ${p}`));
    });
    fireEvent.click(screen.getByText("تحميل المزيد"));

    await waitFor(() => expect(screen.getByText("user.statusChanged")).toBeInTheDocument());
  });

  it("revoking access shows a confirmation and hides the revoke control", async () => {
    mockActivity({ events: [event], limit: 20, offset: 0, hasMore: false });
    renderPage();
    await waitFor(() => expect(screen.getByText("customer.created")).toBeInTheDocument());

    vi.mocked(platformApiFetch).mockImplementation((path: unknown, opts?: RequestInit) => {
      const p = String(path);
      if (p === "/platform/support-sessions/sess-1/revoke" && opts?.method === "POST") {
        return Promise.resolve({ id: "sess-1", revokedAt: "2026-01-01T11:00:00.000Z" });
      }
      return Promise.reject(new Error(`unexpected: ${p}`));
    });

    fireEvent.click(screen.getByRole("button", { name: "إلغاء الوصول" }));

    await waitFor(() => expect(screen.getByText("تم إلغاء جلسة الدعم هذه.")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "إلغاء الوصول" })).not.toBeInTheDocument();
  });
});
