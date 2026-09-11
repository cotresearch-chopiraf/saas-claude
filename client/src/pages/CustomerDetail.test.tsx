import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "../auth/AuthContext";
import { I18nProvider } from "../i18n/I18nProvider";
import { CustomerDetail } from "./CustomerDetail";
import type { CustomerWithProjects } from "../api/types";

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return { ...actual, getToken: () => "fake-token", apiFetch: vi.fn() };
});

import { apiFetch } from "../api/client";

const fixtureCustomerNoProjects: CustomerWithProjects = {
  id: "customer-1",
  companyId: "c1",
  name: "شركة الرياض للمقاولات",
  contactName: "خالد العتيبي",
  taxId: "300123456700003",
  email: "info@example.com",
  phone: "0500000000",
  address: "الرياض",
  notes: "عميل استراتيجي",
  status: "active",
  createdBy: "u1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  projects: [],
};

const fixtureCustomerWithProjects: CustomerWithProjects = {
  ...fixtureCustomerNoProjects,
  id: "customer-2",
  projects: [
    { id: "project-1", name: "مشروع البرج", status: "active" },
    { id: "project-2", name: "مشروع الفيلا", status: "completed" },
  ],
};

function mockApi(customer: CustomerWithProjects) {
  vi.mocked(apiFetch).mockImplementation((path: unknown) => {
    const p = String(path);
    if (p === "/auth/me") {
      return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "c1", name: "Test Co" } });
    }
    if (p === `/customers/${customer.id}`) return Promise.resolve(customer);
    return Promise.reject(new Error(`unexpected apiFetch call in test: ${p}`));
  });
}

function renderDetail(id: string) {
  return render(
    <I18nProvider>
    <MemoryRouter initialEntries={[`/customers/${id}`]}>
      <AuthProvider>
        <Routes>
          <Route path="/customers/:id" element={<CustomerDetail />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>
    </I18nProvider>,
  );
}

describe("<CustomerDetail/>", () => {
  it("renders the customer's unified profile fields verbatim", async () => {
    mockApi(fixtureCustomerNoProjects);
    renderDetail("customer-1");
    await waitFor(() => expect(screen.getByText("شركة الرياض للمقاولات")).toBeInTheDocument());
    expect(screen.getByText("300123456700003")).toBeInTheDocument();
    expect(screen.getByText("info@example.com")).toBeInTheDocument();
    expect(screen.getByText("عميل استراتيجي")).toBeInTheDocument();
    expect(screen.getByText("نشط")).toBeInTheDocument();
  });

  it("shows an honest empty state when no projects are linked", async () => {
    mockApi(fixtureCustomerNoProjects);
    renderDetail("customer-1");
    await waitFor(() => expect(screen.getByText("لا توجد مشاريع مرتبطة بهذا العميل بعد.")).toBeInTheDocument());
  });

  it("renders every linked project verbatim, with a real link to its own workspace", async () => {
    mockApi(fixtureCustomerWithProjects);
    renderDetail("customer-2");
    await waitFor(() => expect(screen.getByText("مشروع البرج")).toBeInTheDocument());
    expect(screen.getByText("مشروع الفيلا")).toBeInTheDocument();
    expect(screen.getByText("مشروع البرج").closest("a")).toHaveAttribute("href", "/projects/project-1");
  });

  it("shows an honest, retryable error state on API failure, not a fabricated profile", async () => {
    vi.mocked(apiFetch).mockImplementation((path: unknown) => {
      const p = String(path);
      if (p === "/auth/me") return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "c1", name: "Test Co" } });
      if (p === "/customers/customer-1") return Promise.reject(new Error("تعذّر الاتصال بالخادم"));
      return Promise.reject(new Error(`unexpected: ${p}`));
    });
    renderDetail("customer-1");
    await waitFor(() => expect(screen.getByText("تعذّر الاتصال بالخادم")).toBeInTheDocument());
  });
});
