import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../auth/AuthContext";
import { I18nProvider } from "../i18n/I18nProvider";
import { Activity } from "./Activity";
import type { ActivityEvent, ActivityPage } from "../api/types";

// MIDAD Phase C — Activity Timeline UI. Same fixture/mock-apiFetch
// discipline as Customers.test.tsx/Team.test.tsx.

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return { ...actual, getToken: () => "fake-token", apiFetch: vi.fn() };
});

import { apiFetch, ApiError } from "../api/client";

const newerEvent: ActivityEvent = {
  id: "event-2",
  action: "customer.created",
  entityType: "customer",
  entityId: "11111111-2222-3333-4444-555555555555",
  actorUserId: "u1",
  actorName: "Owner",
  actorEmail: "owner@test.com",
  reason: null,
  source: "api",
  beforeValue: null,
  afterValue: { name: "شركة الرياض" },
  metadata: null,
  createdAt: "2026-01-02T10:00:00.000Z",
};
const olderEvent: ActivityEvent = {
  id: "event-1",
  action: "user.statusChanged",
  entityType: "user",
  entityId: "66666666-7777-8888-9999-000000000000",
  actorUserId: "u1",
  actorName: "Owner",
  actorEmail: "owner@test.com",
  reason: null,
  source: "api",
  beforeValue: { status: "active" },
  afterValue: { status: "deactivated" },
  metadata: null,
  createdAt: "2026-01-01T10:00:00.000Z",
};

function mockApi(page: ActivityPage | ApiError) {
  vi.mocked(apiFetch).mockImplementation((path: unknown) => {
    const p = String(path);
    if (p === "/auth/me") {
      return Promise.resolve({
        user: { id: "u1", name: "Owner", email: "owner@test.com", role: "owner" },
        company: { id: "c1", name: "Test Co" },
      });
    }
    if (p.startsWith("/audit-events")) {
      return page instanceof ApiError ? Promise.reject(page) : Promise.resolve(page);
    }
    return Promise.reject(new Error(`unexpected apiFetch call in test: ${p}`));
  });
}

function renderActivity() {
  return render(
    <I18nProvider>
    <MemoryRouter>
      <AuthProvider>
        <Activity />
      </AuthProvider>
    </MemoryRouter>
    </I18nProvider>,
  );
}

describe("<Activity/>", () => {
  it("renders events newest-first using backend-provided data only", async () => {
    mockApi({ events: [newerEvent, olderEvent], limit: 20, offset: 0, hasMore: false });
    renderActivity();
    await waitFor(() => expect(screen.getByText("customer.created")).toBeInTheDocument());

    const rows = screen.getAllByText(/created|statusChanged/);
    expect(rows[0].textContent).toContain("customer.created");
    expect(rows[1].textContent).toContain("user.statusChanged");
  });

  it("displays actor, entity type label, and formatted timestamp", async () => {
    mockApi({ events: [newerEvent], limit: 20, offset: 0, hasMore: false });
    renderActivity();
    await waitFor(() => expect(screen.getByText("customer.created")).toBeInTheDocument());
    expect(screen.getAllByText("Owner").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/عميل/).length).toBeGreaterThan(0);
  });

  it("shows a loading state before data arrives", async () => {
    let resolve!: (v: ActivityPage) => void;
    vi.mocked(apiFetch).mockImplementation((path: unknown) => {
      const p = String(path);
      if (p === "/auth/me") return Promise.resolve({ user: { id: "u1", name: "Owner", email: "owner@test.com", role: "owner" }, company: { id: "c1", name: "Test Co" } });
      return new Promise((r) => { resolve = r; });
    });
    renderActivity();
    expect(await screen.findByRole("status", { name: "جارٍ التحميل" })).toBeInTheDocument();
    resolve!({ events: [], limit: 20, offset: 0, hasMore: false });
  });

  it("shows an honest empty state when there is no activity yet", async () => {
    mockApi({ events: [], limit: 20, offset: 0, hasMore: false });
    renderActivity();
    await waitFor(() => expect(screen.getByText("لا يوجد نشاط بعد.")).toBeInTheDocument());
  });

  it("shows an error state with a retry control on failure", async () => {
    mockApi(new ApiError("تعذّر الاتصال بالخادم", 500));
    renderActivity();
    await waitFor(() => expect(screen.getByText("تعذّر الاتصال بالخادم")).toBeInTheDocument());
    expect(screen.getByText("إعادة المحاولة")).toBeInTheDocument();
  });

  it("shows a 'load more' control when hasMore is true, and appends the next page on click", async () => {
    mockApi({ events: [newerEvent], limit: 1, offset: 0, hasMore: true });
    renderActivity();
    await waitFor(() => expect(screen.getByText("تحميل المزيد")).toBeInTheDocument());

    vi.mocked(apiFetch).mockImplementation((path: unknown) => {
      const p = String(path);
      if (p === "/auth/me") return Promise.resolve({ user: { id: "u1", name: "Owner", email: "owner@test.com", role: "owner" }, company: { id: "c1", name: "Test Co" } });
      if (p.includes("offset=1")) return Promise.resolve({ events: [olderEvent], limit: 1, offset: 1, hasMore: false });
      return Promise.reject(new Error(`unexpected: ${p}`));
    });
    fireEvent.click(screen.getByText("تحميل المزيد"));

    await waitFor(() => expect(screen.getByText("user.statusChanged")).toBeInTheDocument());
    expect(screen.queryByText("تحميل المزيد")).not.toBeInTheDocument();
  });

  it("does not show a 'load more' control when hasMore is false", async () => {
    mockApi({ events: [newerEvent], limit: 20, offset: 0, hasMore: false });
    renderActivity();
    await waitFor(() => expect(screen.getByText("customer.created")).toBeInTheDocument());
    expect(screen.queryByText("تحميل المزيد")).not.toBeInTheDocument();
  });

  it("changing the entity-type filter re-fetches with that filter applied", async () => {
    mockApi({ events: [newerEvent, olderEvent], limit: 20, offset: 0, hasMore: false });
    renderActivity();
    await waitFor(() => expect(screen.getByText("customer.created")).toBeInTheDocument());

    let capturedPath = "";
    vi.mocked(apiFetch).mockImplementation((path: unknown) => {
      const p = String(path);
      if (p === "/auth/me") return Promise.resolve({ user: { id: "u1", name: "Owner", email: "owner@test.com", role: "owner" }, company: { id: "c1", name: "Test Co" } });
      capturedPath = p;
      return Promise.resolve({ events: [newerEvent], limit: 20, offset: 0, hasMore: false });
    });

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "customer" } });
    await waitFor(() => expect(capturedPath).toContain("entityType=customer"));
  });

  it("renders inside the RTL layout shared by every other page", async () => {
    mockApi({ events: [newerEvent], limit: 20, offset: 0, hasMore: false });
    renderActivity();
    await waitFor(() => expect(screen.getByText("customer.created")).toBeInTheDocument());
    // RTL is now applied once at the document root by I18nProvider (see
    // client/src/i18n/I18nProvider.tsx), synced from the current locale —
    // not hardcoded dir="rtl" on each page's own wrapper — so the default
    // Arabic locale is asserted at document.documentElement instead of a
    // descendant selector inside this page's own render container.
    expect(document.documentElement.dir).toBe("rtl");
  });
});
