import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../auth/AuthContext";
import { I18nProvider } from "../i18n/I18nProvider";
import { Dashboard } from "./Dashboard";
import type { Customer, Project } from "../api/types";

// MIDAD Phase A' — this file only covers the new optional customer-link
// control added to the project creation form; Dashboard.tsx's own
// pre-existing behavior (project list rendering, etc.) predates this
// slice and is intentionally not backfilled here.

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return { ...actual, getToken: () => "fake-token", apiFetch: vi.fn() };
});

import { apiFetch } from "../api/client";

const fixtureCustomer: Customer = {
  id: "customer-1",
  companyId: "c1",
  name: "شركة الرياض للمقاولات",
  contactName: null,
  taxId: null,
  email: null,
  phone: null,
  address: null,
  notes: null,
  status: "active",
  createdBy: "u1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const fixtureProjectA: Project = {
  id: "p1",
  companyId: "c1",
  name: "برج الرياض السكني",
  clientName: "مجموعة الرياض العقارية",
  customerId: null,
  address: null,
  status: "active",
  budgetTotal: "0.00",
  startDate: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};
const fixtureProjectB: Project = {
  id: "p2",
  companyId: "c1",
  name: "مجمع جدة التجاري",
  clientName: "شركة جدة للتطوير",
  customerId: null,
  address: null,
  status: "on_hold",
  budgetTotal: "0.00",
  startDate: null,
  createdAt: "2026-02-01T00:00:00.000Z",
};

function mockApi(
  opts: {
    projects?: Project[];
    customers?: Customer[];
    exceptions?: { open: number; highOrCritical: number };
  } = {},
) {
  const { projects = [], customers = [fixtureCustomer] } = opts;
  const exceptions = opts.exceptions ?? { open: 0, highOrCritical: 0 };
  vi.mocked(apiFetch).mockImplementation((path: unknown, reqOpts?: RequestInit) => {
    const p = String(path);
    const method = reqOpts?.method;
    if (p === "/auth/me") return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "c1", name: "Test Co" } });
    if (p === "/projects" && !method) return Promise.resolve(projects);
    if (p === "/customers" && !method) return Promise.resolve(customers);
    if (p.startsWith("/budget-alerts")) return Promise.resolve([]);
    if (p === "/workforce-compliance") return Promise.resolve({ nitaqat: null, gosi: null, exceptions });
    return Promise.reject(new Error(`unexpected apiFetch call in test: ${p} ${method}`));
  });
}

function renderDashboard() {
  return render(
    <I18nProvider>
    <MemoryRouter>
      <AuthProvider>
        <Dashboard />
      </AuthProvider>
    </MemoryRouter>
    </I18nProvider>,
  );
}

describe("<Dashboard/> — project creation customer link (Phase A')", () => {
  it("the create form's customer select lists the company's real customers", async () => {
    mockApi();
    renderDashboard();
    fireEvent.click(await screen.findByText("+ مشروع جديد"));
    await waitFor(() => expect(screen.getByText("شركة الرياض للمقاولات")).toBeInTheDocument());
  });

  it("selecting a customer sends its id as customerId on project creation", async () => {
    mockApi();
    renderDashboard();
    fireEvent.click(await screen.findByText("+ مشروع جديد"));
    await waitFor(() => expect(screen.getByText("شركة الرياض للمقاولات")).toBeInTheDocument());

    let capturedBody: { customerId?: string } | null = null;
    vi.mocked(apiFetch).mockImplementation((path: unknown, reqOpts?: RequestInit) => {
      const p = String(path);
      const method = reqOpts?.method;
      if (p === "/auth/me") return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "c1", name: "Test Co" } });
      if (p === "/customers" && !method) return Promise.resolve([fixtureCustomer]);
      if (p === "/projects" && method === "POST") {
        capturedBody = JSON.parse(reqOpts!.body as string);
        return Promise.resolve({});
      }
      if (p === "/projects" && !method) return Promise.resolve([]);
      if (p.startsWith("/budget-alerts")) return Promise.resolve([]);
      if (p === "/workforce-compliance") return Promise.resolve({ nitaqat: null, gosi: null, exceptions: { open: 0, highOrCritical: 0 } });
      return Promise.reject(new Error(`unexpected: ${p} ${method}`));
    });

    fireEvent.change(screen.getByPlaceholderText("اسم المشروع"), { target: { value: "مشروع جديد" } });
    fireEvent.change(screen.getByDisplayValue("ربط بعميل (اختياري)"), { target: { value: "customer-1" } });
    fireEvent.click(screen.getByText("حفظ المشروع"));

    await waitFor(() => expect(capturedBody?.customerId).toBe("customer-1"));
  });

  it("leaving the customer select unset omits customerId entirely (never an empty string)", async () => {
    mockApi();
    renderDashboard();
    fireEvent.click(await screen.findByText("+ مشروع جديد"));
    await waitFor(() => expect(screen.getByText("شركة الرياض للمقاولات")).toBeInTheDocument());

    const captured: { body: { name?: string; customerId?: string } | null } = { body: null };
    vi.mocked(apiFetch).mockImplementation((path: unknown, reqOpts?: RequestInit) => {
      const p = String(path);
      const method = reqOpts?.method;
      if (p === "/auth/me") return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "c1", name: "Test Co" } });
      if (p === "/customers" && !method) return Promise.resolve([fixtureCustomer]);
      if (p === "/projects" && method === "POST") {
        captured.body = JSON.parse(reqOpts!.body as string);
        return Promise.resolve({});
      }
      if (p === "/projects" && !method) return Promise.resolve([]);
      if (p.startsWith("/budget-alerts")) return Promise.resolve([]);
      if (p === "/workforce-compliance") return Promise.resolve({ nitaqat: null, gosi: null, exceptions: { open: 0, highOrCritical: 0 } });
      return Promise.reject(new Error(`unexpected: ${p} ${method}`));
    });

    fireEvent.change(screen.getByPlaceholderText("اسم المشروع"), { target: { value: "مشروع بدون عميل" } });
    fireEvent.click(screen.getByText("حفظ المشروع"));

    await waitFor(() => expect(captured.body?.name).toBe("مشروع بدون عميل"));
    expect(captured.body?.customerId).toBeUndefined();
  });
});

describe("<Dashboard/> — Executive Command Center (Phase F/F.1)", () => {
  it("MIDAD Phase F.1: an open compliance exception appears in Needs Attention, sourced from the existing company-wide dashboard endpoint", async () => {
    mockApi({ projects: [fixtureProjectA], exceptions: { open: 2, highOrCritical: 1 } });
    renderDashboard();
    await waitFor(() => expect(screen.getByText("استثناءات امتثال العمالة")).toBeInTheDocument());
    expect(screen.getByText(/2 استثناء مفتوح، منها 1 عالية الأولوية/)).toBeInTheDocument();
  });

  it("MIDAD Phase F.1: searching the project table filters by name/client, client-side, over already-loaded data only", async () => {
    mockApi({ projects: [fixtureProjectA, fixtureProjectB] });
    renderDashboard();
    await waitFor(() => expect(screen.getByText("برج الرياض السكني")).toBeInTheDocument());
    expect(screen.getByText("مجمع جدة التجاري")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("البحث بالاسم أو العميل"), { target: { value: "جدة" } });
    await waitFor(() => expect(screen.queryByText("برج الرياض السكني")).not.toBeInTheDocument());
    expect(screen.getByText("مجمع جدة التجاري")).toBeInTheDocument();
  });

  it("MIDAD Phase F.1: the status filter narrows the project table to the selected status only", async () => {
    mockApi({ projects: [fixtureProjectA, fixtureProjectB] });
    renderDashboard();
    await waitFor(() => expect(screen.getByText("برج الرياض السكني")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "متوقف مؤقتاً" }));
    await waitFor(() => expect(screen.queryByText("برج الرياض السكني")).not.toBeInTheDocument());
    expect(screen.getByText("مجمع جدة التجاري")).toBeInTheDocument();
  });

  it("MIDAD Phase F.1: clicking a sortable column header reorders the already-loaded project rows, client-side", async () => {
    mockApi({ projects: [fixtureProjectA, fixtureProjectB] });
    renderDashboard();
    await waitFor(() => expect(screen.getByText("برج الرياض السكني")).toBeInTheDocument());

    const rowsInOrder = () => screen.getAllByRole("row").slice(1).map((r) => r.textContent ?? "");
    // Default sort is createdAt desc: project B (2026-02-01) before project A (2026-01-01).
    expect(rowsInOrder()[0]).toContain("مجمع جدة التجاري");

    fireEvent.click(screen.getByRole("button", { name: /المشروع/ }));
    await waitFor(() => expect(rowsInOrder()[0]).toContain("برج الرياض السكني"));

    fireEvent.click(screen.getByRole("button", { name: /المشروع/ }));
    await waitFor(() => expect(rowsInOrder()[0]).toContain("مجمع جدة التجاري"));
  });

  it("no compliance exception item appears when there are none open — never a fabricated risk", async () => {
    mockApi({ projects: [fixtureProjectA], exceptions: { open: 0, highOrCritical: 0 } });
    renderDashboard();
    await waitFor(() => expect(screen.getByText("برج الرياض السكني")).toBeInTheDocument());
    expect(screen.queryByText("استثناءات امتثال العمالة")).not.toBeInTheDocument();
  });
});
