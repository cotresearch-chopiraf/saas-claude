import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../auth/AuthContext";
import { Customers } from "./Customers";
import type { Customer } from "../api/types";

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return { ...actual, getToken: () => "fake-token", apiFetch: vi.fn() };
});

import { apiFetch } from "../api/client";

const fixtureCustomer: Customer = {
  id: "customer-1",
  companyId: "c1",
  name: "شركة الرياض للمقاولات",
  contactName: "خالد العتيبي",
  taxId: "300123456700003",
  email: "info@example.com",
  phone: "0500000000",
  address: null,
  notes: null,
  status: "active",
  createdBy: "u1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function mockApi(role: "owner" | "member", customers: Customer[]) {
  vi.mocked(apiFetch).mockImplementation((path: unknown, opts?: RequestInit) => {
    const p = String(path);
    if (p === "/auth/me") {
      return Promise.resolve({
        user: { id: "u1", name: "Test", email: "t@test.com", role },
        company: { id: "c1", name: "Test Co" },
      });
    }
    if (p === "/customers" && (!opts || !opts.method)) {
      return Promise.resolve(customers);
    }
    return Promise.reject(new Error(`unexpected apiFetch call in test: ${p} ${opts?.method ?? "GET"}`));
  });
}

function renderCustomers() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <Customers />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("<Customers/>", () => {
  it("renders the customer list using backend-provided data, never fabricated", async () => {
    mockApi("owner", [fixtureCustomer]);
    renderCustomers();
    await waitFor(() => expect(screen.getByText("شركة الرياض للمقاولات")).toBeInTheDocument());
    expect(screen.getByText("خالد العتيبي")).toBeInTheDocument();
    expect(screen.getByText("300123456700003")).toBeInTheDocument();
    expect(screen.getByText("نشط")).toBeInTheDocument();
  });

  it("shows an honest empty state when there are no customers yet", async () => {
    mockApi("owner", []);
    renderCustomers();
    await waitFor(() => expect(screen.getByText("لا يوجد عملاء بعد")).toBeInTheDocument());
  });

  it("an owner sees the create-customer control", async () => {
    mockApi("owner", [fixtureCustomer]);
    renderCustomers();
    await waitFor(() => expect(screen.getByText("+ عميل جديد")).toBeInTheDocument());
  });

  it("a member does not see the create-customer control (backend requires customer.manage)", async () => {
    mockApi("member", [fixtureCustomer]);
    renderCustomers();
    await waitFor(() => expect(screen.getByText("شركة الرياض للمقاولات")).toBeInTheDocument());
    expect(screen.queryByText("+ عميل جديد")).not.toBeInTheDocument();
  });

  it("an owner sees edit/status-toggle row controls; a member does not", async () => {
    mockApi("owner", [fixtureCustomer]);
    renderCustomers();
    await waitFor(() => expect(screen.getByText("تعديل")).toBeInTheDocument());
    expect(screen.getByText("إلغاء التنشيط")).toBeInTheDocument();
  });

  it("a member never sees mutation controls, only the read-only view link", async () => {
    mockApi("member", [fixtureCustomer]);
    renderCustomers();
    await waitFor(() => expect(screen.getByText("عرض")).toBeInTheDocument());
    expect(screen.queryByText("تعديل")).not.toBeInTheDocument();
    expect(screen.queryByText("إلغاء التنشيط")).not.toBeInTheDocument();
  });

  it("every customer row links to its detail page", async () => {
    mockApi("owner", [fixtureCustomer]);
    renderCustomers();
    await waitFor(() => expect(screen.getByText("عرض")).toBeInTheDocument());
    expect(screen.getByText("عرض").closest("a")).toHaveAttribute("href", "/customers/customer-1");
  });

  it("submitting the create form sends the entered fields to POST /customers", async () => {
    mockApi("owner", []);
    renderCustomers();
    await waitFor(() => expect(screen.getByText("+ عميل جديد")).toBeInTheDocument());
    fireEvent.click(screen.getByText("+ عميل جديد"));

    let capturedBody: unknown = null;
    vi.mocked(apiFetch).mockImplementation((path: unknown, opts?: RequestInit) => {
      const p = String(path);
      const method = opts?.method;
      if (p === "/auth/me") return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "c1", name: "Test Co" } });
      if (p === "/customers" && method === "POST") {
        capturedBody = JSON.parse(opts!.body as string);
        return Promise.resolve({ ...fixtureCustomer, id: "customer-new" });
      }
      if (p === "/customers" && !method) return Promise.resolve([{ ...fixtureCustomer, id: "customer-new" }]);
      return Promise.reject(new Error(`unexpected: ${p} ${method}`));
    });

    fireEvent.change(screen.getByPlaceholderText("اسم العميل"), { target: { value: "عميل جديد" } });
    fireEvent.click(screen.getByRole("button", { name: "حفظ العميل" }));

    await waitFor(() => expect(capturedBody).toEqual({ name: "عميل جديد" }));
  });
});
