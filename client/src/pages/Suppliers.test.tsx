import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../auth/AuthContext";
import { I18nProvider } from "../i18n/I18nProvider";
import { Suppliers } from "./Suppliers";
import type { Supplier } from "../api/types";

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return { ...actual, getToken: () => "fake-token", apiFetch: vi.fn() };
});

import { apiFetch } from "../api/client";

const fixtureSupplier: Supplier = {
  id: "supplier-1",
  companyId: "c1",
  name: "شركة الرشيد للمواد",
  type: "supplier",
  taxId: "300123456700003",
  email: "info@example.com",
  phone: "0500000000",
  address: null,
  status: "active",
  createdBy: "u1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function mockApi(role: "owner" | "member", suppliers: Supplier[]) {
  vi.mocked(apiFetch).mockImplementation((path: unknown, opts?: RequestInit) => {
    const p = String(path);
    if (p === "/auth/me") {
      return Promise.resolve({
        user: { id: "u1", name: "Test", email: "t@test.com", role },
        company: { id: "c1", name: "Test Co" },
      });
    }
    if (p === "/suppliers" && (!opts || !opts.method)) {
      return Promise.resolve(suppliers);
    }
    return Promise.reject(new Error(`unexpected apiFetch call in test: ${p} ${opts?.method ?? "GET"}`));
  });
}

function renderSuppliers() {
  return render(
    <I18nProvider>
    <MemoryRouter>
      <AuthProvider>
        <Suppliers />
      </AuthProvider>
    </MemoryRouter>
    </I18nProvider>,
  );
}

describe("<Suppliers/>", () => {
  it("renders the supplier list using backend-provided data, never fabricated", async () => {
    mockApi("owner", [fixtureSupplier]);
    renderSuppliers();
    await waitFor(() => expect(screen.getByText("شركة الرشيد للمواد")).toBeInTheDocument());
    expect(screen.getByText("300123456700003")).toBeInTheDocument();
    expect(screen.getByText("info@example.com")).toBeInTheDocument();
    expect(screen.getByText("نشط")).toBeInTheDocument();
  });

  it("an owner sees the create-supplier control", async () => {
    mockApi("owner", [fixtureSupplier]);
    renderSuppliers();
    await waitFor(() => expect(screen.getByText("+ مورد جديد")).toBeInTheDocument());
  });

  it("a member does not see the create-supplier control (backend requires supplier.manage)", async () => {
    mockApi("member", [fixtureSupplier]);
    renderSuppliers();
    await waitFor(() => expect(screen.getByText("شركة الرشيد للمواد")).toBeInTheDocument());
    expect(screen.queryByText("+ مورد جديد")).not.toBeInTheDocument();
  });

  it("an owner sees edit/deactivate row controls", async () => {
    mockApi("owner", [fixtureSupplier]);
    renderSuppliers();
    await waitFor(() => expect(screen.getByText("شركة الرشيد للمواد")).toBeInTheDocument());
    expect(screen.getByText("تعديل")).toBeInTheDocument();
    expect(screen.getByText("إلغاء التنشيط")).toBeInTheDocument();
  });

  it("a member does not see edit/deactivate row controls (backend requires supplier.manage)", async () => {
    mockApi("member", [fixtureSupplier]);
    renderSuppliers();
    await waitFor(() => expect(screen.getByText("شركة الرشيد للمواد")).toBeInTheDocument());
    expect(screen.queryByText("تعديل")).not.toBeInTheDocument();
    expect(screen.queryByText("إلغاء التنشيط")).not.toBeInTheDocument();
  });

  it("shows an honest empty state when there are no suppliers yet", async () => {
    mockApi("owner", []);
    renderSuppliers();
    await waitFor(() => expect(screen.getByText("لا يوجد موردون بعد")).toBeInTheDocument());
  });

  it("shows an honest error state on API failure, not a fabricated empty list", async () => {
    vi.mocked(apiFetch).mockImplementation((path: unknown) => {
      const p = String(path);
      if (p === "/auth/me") {
        return Promise.resolve({
          user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" },
          company: { id: "c1", name: "Test Co" },
        });
      }
      if (p === "/suppliers") {
        return Promise.reject(new Error("تعذّر الاتصال بالخادم"));
      }
      return Promise.reject(new Error(`unexpected apiFetch call in test: ${p}`));
    });
    renderSuppliers();
    await waitFor(() => expect(screen.getByText("تعذّر الاتصال بالخادم")).toBeInTheDocument());
  });
});
