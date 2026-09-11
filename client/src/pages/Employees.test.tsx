import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../auth/AuthContext";
import { I18nProvider } from "../i18n/I18nProvider";
import { Employees } from "./Employees";
import type { Employee } from "../api/types";

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return { ...actual, getToken: () => "fake-token", apiFetch: vi.fn() };
});

import { apiFetch } from "../api/client";

const fixtureEmployee: Employee = {
  id: "employee-1",
  companyId: "c1",
  employeeNumber: "EMP-1",
  name: "أحمد الشمري",
  jobTitle: "مهندس موقع",
  hireDate: "2026-01-15",
  status: "active",
  email: "worker@example.com",
  phone: "0501234567",
  createdBy: "u1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const fixtureInactive: Employee = {
  ...fixtureEmployee,
  id: "employee-2",
  employeeNumber: "EMP-2",
  name: "سالم القحطاني",
  jobTitle: "عامل",
  status: "inactive",
};

function mockApi(role: "owner" | "member", employees: Employee[]) {
  vi.mocked(apiFetch).mockImplementation((path: unknown, opts?: RequestInit) => {
    const p = String(path);
    if (p === "/auth/me") {
      return Promise.resolve({
        user: { id: "u1", name: "Test", email: "t@test.com", role },
        company: { id: "c1", name: "Test Co" },
      });
    }
    if (p === "/employees" && (!opts || !opts.method)) {
      return Promise.resolve(employees);
    }
    return Promise.reject(new Error(`unexpected apiFetch call in test: ${p} ${opts?.method ?? "GET"}`));
  });
}

function renderEmployees() {
  return render(
    <I18nProvider>
    <MemoryRouter>
      <AuthProvider>
        <Employees />
      </AuthProvider>
    </MemoryRouter>
    </I18nProvider>,
  );
}

describe("<Employees/>", () => {
  it("renders the employee list using backend-provided data, never fabricated", async () => {
    mockApi("owner", [fixtureEmployee]);
    renderEmployees();
    await waitFor(() => expect(screen.getByText("أحمد الشمري")).toBeInTheDocument());
    expect(screen.getByText("EMP-1")).toBeInTheDocument();
    expect(screen.getByText("مهندس موقع")).toBeInTheDocument();
    expect(screen.getAllByText("نشط").length).toBeGreaterThan(0);
  });

  it("shows accurate total/active/inactive summary counts", async () => {
    mockApi("owner", [fixtureEmployee, fixtureInactive]);
    renderEmployees();
    await waitFor(() => expect(screen.getByText("أحمد الشمري")).toBeInTheDocument());
    expect(screen.getByText("إجمالي الموظفين")).toBeInTheDocument();
    const totalCard = screen.getByText("إجمالي الموظفين").closest("div")!;
    expect(totalCard.textContent).toContain("2");
  });

  it("search filters by name or employee number", async () => {
    mockApi("owner", [fixtureEmployee, fixtureInactive]);
    renderEmployees();
    await waitFor(() => expect(screen.getByText("أحمد الشمري")).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText("البحث بالاسم أو رقم الموظف"), { target: { value: "EMP-2" } });
    expect(screen.queryByText("أحمد الشمري")).not.toBeInTheDocument();
    expect(screen.getByText("سالم القحطاني")).toBeInTheDocument();
  });

  it("status filter narrows the list to active or inactive employees", async () => {
    mockApi("owner", [fixtureEmployee, fixtureInactive]);
    renderEmployees();
    await waitFor(() => expect(screen.getByText("أحمد الشمري")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "غير نشط" }));
    expect(screen.queryByText("أحمد الشمري")).not.toBeInTheDocument();
    expect(screen.getByText("سالم القحطاني")).toBeInTheDocument();
  });

  it("an owner sees the create-employee control", async () => {
    mockApi("owner", [fixtureEmployee]);
    renderEmployees();
    await waitFor(() => expect(screen.getByText("+ إضافة موظف")).toBeInTheDocument());
  });

  it("a member does not see the create-employee control (backend requires workforce.manage)", async () => {
    mockApi("member", [fixtureEmployee]);
    renderEmployees();
    await waitFor(() => expect(screen.getByText("أحمد الشمري")).toBeInTheDocument());
    expect(screen.queryByText("+ إضافة موظف")).not.toBeInTheDocument();
  });

  it("an owner sees edit/deactivate row controls; a member does not", async () => {
    mockApi("owner", [fixtureEmployee]);
    renderEmployees();
    await waitFor(() => expect(screen.getByText("تعديل")).toBeInTheDocument());
    expect(screen.getByText("إلغاء التنشيط")).toBeInTheDocument();
  });

  it("a member never sees mutation controls on any row", async () => {
    mockApi("member", [fixtureEmployee]);
    renderEmployees();
    await waitFor(() => expect(screen.getByText("أحمد الشمري")).toBeInTheDocument());
    expect(screen.queryByText("تعديل")).not.toBeInTheDocument();
    expect(screen.queryByText("إلغاء التنشيط")).not.toBeInTheDocument();
  });

  it("shows an honest empty state when there are no employees yet", async () => {
    mockApi("owner", []);
    renderEmployees();
    await waitFor(() => expect(screen.getByText("لا يوجد موظفون بعد")).toBeInTheDocument());
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
      if (p === "/employees") {
        return Promise.reject(new Error("تعذّر الاتصال بالخادم"));
      }
      return Promise.reject(new Error(`unexpected apiFetch call in test: ${p}`));
    });
    renderEmployees();
    await waitFor(() => expect(screen.getByText("تعذّر الاتصال بالخادم")).toBeInTheDocument());
  });

  it("submitting the create form sends the entered fields to POST /employees", async () => {
    mockApi("owner", []);
    renderEmployees();
    await waitFor(() => expect(screen.getByText("+ إضافة موظف")).toBeInTheDocument());
    fireEvent.click(screen.getByText("+ إضافة موظف"));

    let capturedBody: unknown = null;
    vi.mocked(apiFetch).mockImplementation((path: unknown, opts?: RequestInit) => {
      const p = String(path);
      const method = opts?.method;
      if (p === "/auth/me") {
        return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "c1", name: "Test Co" } });
      }
      if (p === "/employees" && method === "POST") {
        capturedBody = JSON.parse(opts!.body as string);
        return Promise.resolve({ ...fixtureEmployee, id: "employee-new" });
      }
      if (p === "/employees" && !method) return Promise.resolve([{ ...fixtureEmployee, id: "employee-new" }]);
      return Promise.reject(new Error(`unexpected: ${p} ${method}`));
    });

    fireEvent.change(screen.getByPlaceholderText("الاسم الكامل"), { target: { value: "موظف جديد" } });
    fireEvent.change(screen.getByPlaceholderText("رقم الموظف"), { target: { value: "EMP-99" } });
    fireEvent.click(screen.getByRole("button", { name: "حفظ الموظف" }));

    await waitFor(() =>
      expect(capturedBody).toEqual({
        name: "موظف جديد",
        employeeNumber: "EMP-99",
      }),
    );
  });
});
