import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../auth/AuthContext";
import { Payroll } from "./Payroll";
import type { PayrollPeriod } from "../api/types";

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return { ...actual, getToken: () => "fake-token", apiFetch: vi.fn() };
});

import { apiFetch } from "../api/client";

const fixturePeriod: PayrollPeriod = {
  id: "period-1",
  companyId: "c1",
  periodStart: "2026-09-01",
  periodEnd: "2026-09-30",
  payrollDate: null,
  status: "draft",
  notes: null,
  createdBy: "u1",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  submittedBy: null,
  submittedAt: null,
  approvedBy: null,
  approvedAt: null,
  postedBy: null,
  postedAt: null,
  rejectedBy: null,
  rejectedAt: null,
  rejectionReason: null,
  summary: { employeeCount: 34, totalGross: 420000, totalDeductions: 0, totalNet: 420000 },
};

function mockApi(role: "owner" | "member", periods: PayrollPeriod[]) {
  vi.mocked(apiFetch).mockImplementation((path: unknown, opts?: RequestInit) => {
    const p = String(path);
    if (p === "/auth/me") {
      return Promise.resolve({
        user: { id: "u1", name: "Test", email: "t@test.com", role },
        company: { id: "c1", name: "Test Co" },
      });
    }
    if (p === "/payroll-periods" && (!opts || !opts.method)) {
      return Promise.resolve(periods);
    }
    return Promise.reject(new Error(`unexpected apiFetch call in test: ${p} ${opts?.method ?? "GET"}`));
  });
}

function renderPayroll() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <Payroll />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("<Payroll/>", () => {
  it("renders the period list with its backend-provided summary, never fabricated", async () => {
    mockApi("owner", [fixturePeriod]);
    renderPayroll();
    await waitFor(() => expect(screen.getByText("34")).toBeInTheDocument());
    expect(screen.getByText("مسودة")).toBeInTheDocument();
  });

  it("an owner sees the create-period control", async () => {
    mockApi("owner", [fixturePeriod]);
    renderPayroll();
    await waitFor(() => expect(screen.getByText("+ فترة رواتب جديدة")).toBeInTheDocument());
  });

  it("a member does not see the create-period control (backend requires payroll.manage)", async () => {
    mockApi("member", [fixturePeriod]);
    renderPayroll();
    await waitFor(() => expect(screen.getByText("34")).toBeInTheDocument());
    expect(screen.queryByText("+ فترة رواتب جديدة")).not.toBeInTheDocument();
  });

  it("a member can still open a period (read is member-open)", async () => {
    mockApi("member", [fixturePeriod]);
    renderPayroll();
    await waitFor(() => expect(screen.getByText("فتح الفترة")).toBeInTheDocument());
  });

  it("shows an honest empty state when there are no periods yet", async () => {
    mockApi("owner", []);
    renderPayroll();
    await waitFor(() => expect(screen.getByText("لا توجد فترات رواتب بعد")).toBeInTheDocument());
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
      if (p === "/payroll-periods") return Promise.reject(new Error("تعذّر الاتصال بالخادم"));
      return Promise.reject(new Error(`unexpected apiFetch call in test: ${p}`));
    });
    renderPayroll();
    await waitFor(() => expect(screen.getByText("تعذّر الاتصال بالخادم")).toBeInTheDocument());
  });

  it("submitting the create form sends the entered dates to POST /payroll-periods", async () => {
    mockApi("owner", []);
    renderPayroll();
    await waitFor(() => expect(screen.getByText("+ فترة رواتب جديدة")).toBeInTheDocument());
    fireEvent.click(screen.getByText("+ فترة رواتب جديدة"));

    let capturedBody: unknown = null;
    vi.mocked(apiFetch).mockImplementation((path: unknown, opts?: RequestInit) => {
      const p = String(path);
      const method = opts?.method;
      if (p === "/auth/me") return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "c1", name: "Test Co" } });
      if (p === "/payroll-periods" && method === "POST") {
        capturedBody = JSON.parse(opts!.body as string);
        return Promise.resolve({ ...fixturePeriod, id: "period-new" });
      }
      if (p === "/payroll-periods" && !method) return Promise.resolve([{ ...fixturePeriod, id: "period-new" }]);
      return Promise.reject(new Error(`unexpected: ${p} ${method}`));
    });

    const dateInputs = screen.getAllByDisplayValue("");
    fireEvent.change(dateInputs[0], { target: { value: "2026-10-01" } });
    fireEvent.change(dateInputs[1], { target: { value: "2026-10-31" } });
    fireEvent.click(screen.getByRole("button", { name: "إنشاء الفترة" }));

    await waitFor(() => expect(capturedBody).toEqual({ periodStart: "2026-10-01", periodEnd: "2026-10-31" }));
  });
});
