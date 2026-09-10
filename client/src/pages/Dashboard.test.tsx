import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../auth/AuthContext";
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

function mockApi(opts: { projects?: Project[]; customers?: Customer[] } = {}) {
  const { projects = [], customers = [fixtureCustomer] } = opts;
  vi.mocked(apiFetch).mockImplementation((path: unknown, reqOpts?: RequestInit) => {
    const p = String(path);
    const method = reqOpts?.method;
    if (p === "/auth/me") return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "c1", name: "Test Co" } });
    if (p === "/projects" && !method) return Promise.resolve(projects);
    if (p === "/customers" && !method) return Promise.resolve(customers);
    if (p.startsWith("/budget-alerts")) return Promise.resolve([]);
    return Promise.reject(new Error(`unexpected apiFetch call in test: ${p} ${method}`));
  });
}

function renderDashboard() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <Dashboard />
      </AuthProvider>
    </MemoryRouter>,
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
      return Promise.reject(new Error(`unexpected: ${p} ${method}`));
    });

    fireEvent.change(screen.getByPlaceholderText("اسم المشروع"), { target: { value: "مشروع بدون عميل" } });
    fireEvent.click(screen.getByText("حفظ المشروع"));

    await waitFor(() => expect(captured.body?.name).toBe("مشروع بدون عميل"));
    expect(captured.body?.customerId).toBeUndefined();
  });
});
