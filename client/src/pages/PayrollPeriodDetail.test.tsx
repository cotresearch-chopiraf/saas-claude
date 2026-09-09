import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AuthProvider } from "../auth/AuthContext";
import { PayrollPeriodDetail } from "./PayrollPeriodDetail";
import type { Employee, PayrollPeriodWithRecords, PayrollRecord } from "../api/types";

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return { ...actual, getToken: () => "fake-token", apiFetch: vi.fn() };
});

import { apiFetch } from "../api/client";

const fixtureEmployee: Employee = {
  id: "emp-1",
  companyId: "c1",
  employeeNumber: "EMP-1",
  name: "أحمد الشمري",
  jobTitle: null,
  hireDate: null,
  status: "active",
  email: null,
  phone: null,
  createdBy: "u1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const fixtureRecord: PayrollRecord = {
  id: "record-1",
  companyId: "c1",
  payrollPeriodId: "period-1",
  employeeId: "emp-1",
  grossAmount: "5000.00",
  deductionsAmount: "200.00",
  netAmount: "4800.00",
  sourceType: "manual",
  provider: null,
  externalReference: null,
  verificationStatus: "unverified",
  importBatchId: null,
  importedAt: null,
  verifiedAt: null,
  createdBy: "u1",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  employee: { id: "emp-1", name: "أحمد الشمري", employeeNumber: "EMP-1", status: "active" },
};

function fixturePeriod(overrides: Partial<PayrollPeriodWithRecords> = {}): PayrollPeriodWithRecords {
  return {
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
    summary: { employeeCount: 1, totalGross: 5000, totalDeductions: 200, totalNet: 4800 },
    records: [fixtureRecord],
    ...overrides,
  };
}

function mockApi(role: "owner" | "member", period: PayrollPeriodWithRecords, employees: Employee[] = [fixtureEmployee]) {
  vi.mocked(apiFetch).mockImplementation((path: unknown, opts?: RequestInit) => {
    const p = String(path);
    const method = opts?.method;
    if (p === "/auth/me") {
      return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role }, company: { id: "c1", name: "Test Co" } });
    }
    if (p === "/payroll-periods/period-1" && (!method || method === "GET")) return Promise.resolve(period);
    if (p === "/employees" && (!method || method === "GET")) return Promise.resolve(employees);
    return Promise.reject(new Error(`unexpected apiFetch call in test: ${p} ${method ?? "GET"}`));
  });
}

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={["/payroll/period-1"]}>
      <AuthProvider>
        <Routes>
          <Route path="/payroll/:id" element={<PayrollPeriodDetail />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("<PayrollPeriodDetail/>", () => {
  it("renders period summary and records using backend-provided data, never fabricated", async () => {
    mockApi("owner", fixturePeriod());
    renderDetail();
    await waitFor(() => expect(screen.getByText("أحمد الشمري")).toBeInTheDocument());
    expect(screen.getByText("مسودة")).toBeInTheDocument();
    expect(screen.getByText("EMP-1")).toBeInTheDocument();
  });

  it("shows an honest empty state when a period has no records yet", async () => {
    mockApi("owner", fixturePeriod({ records: [], summary: { employeeCount: 0, totalGross: 0, totalDeductions: 0, totalNet: 0 } }));
    renderDetail();
    await waitFor(() => expect(screen.getByText("لا توجد سجلات رواتب في هذه الفترة بعد")).toBeInTheDocument());
  });

  it("shows an honest error state on API failure", async () => {
    vi.mocked(apiFetch).mockImplementation((path: unknown) => {
      const p = String(path);
      if (p === "/auth/me") return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "c1", name: "Test Co" } });
      if (p === "/payroll-periods/period-1") return Promise.reject(new Error("تعذّر الاتصال بالخادم"));
      if (p === "/employees") return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected: ${p}`));
    });
    renderDetail();
    await waitFor(() => expect(screen.getByText("تعذّر الاتصال بالخادم")).toBeInTheDocument());
  });

  it("a draft period shows add/edit controls to an owner; a member sees neither", async () => {
    mockApi("owner", fixturePeriod());
    renderDetail();
    await waitFor(() => expect(screen.getByText("+ إضافة سجل راتب")).toBeInTheDocument());
    expect(screen.getByText("تعديل")).toBeInTheDocument();
    expect(screen.getByText("إرسال للاعتماد")).toBeInTheDocument();
  });

  it("a member never sees mutation controls on a draft period", async () => {
    mockApi("member", fixturePeriod());
    renderDetail();
    await waitFor(() => expect(screen.getByText("أحمد الشمري")).toBeInTheDocument());
    expect(screen.queryByText("+ إضافة سجل راتب")).not.toBeInTheDocument();
    expect(screen.queryByText("تعديل")).not.toBeInTheDocument();
    expect(screen.queryByText("إرسال للاعتماد")).not.toBeInTheDocument();
  });

  it("a submitted period shows a locked banner and no add/edit controls, even for an owner", async () => {
    mockApi("owner", fixturePeriod({ status: "submitted", submittedAt: "2026-09-05T00:00:00.000Z" }));
    renderDetail();
    await waitFor(() => expect(screen.getByText("بانتظار الاعتماد")).toBeInTheDocument());
    expect(screen.getByText("لا يمكن تعديل سجلات هذه الفترة — تم إرسالها أو اعتمادها بالفعل.")).toBeInTheDocument();
    expect(screen.queryByText("+ إضافة سجل راتب")).not.toBeInTheDocument();
    expect(screen.queryByText("تعديل")).not.toBeInTheDocument();
  });

  it("a submitted period shows approve/reject to an owner instead of submit", async () => {
    mockApi("owner", fixturePeriod({ status: "submitted" }));
    renderDetail();
    await waitFor(() => expect(screen.getByText("اعتماد")).toBeInTheDocument());
    expect(screen.getByText("رفض")).toBeInTheDocument();
    expect(screen.queryByText("إرسال للاعتماد")).not.toBeInTheDocument();
  });

  it("a rejected period shows the rejection reason", async () => {
    mockApi("owner", fixturePeriod({ status: "rejected", rejectionReason: "بيانات ناقصة" }));
    renderDetail();
    await waitFor(() => expect(screen.getByText(/سبب الرفض: بيانات ناقصة/)).toBeInTheDocument());
  });

  it("submitting the add-record form sends the entered amounts to POST /payroll-records", async () => {
    mockApi("owner", fixturePeriod({ records: [], summary: { employeeCount: 0, totalGross: 0, totalDeductions: 0, totalNet: 0 } }));
    renderDetail();
    await waitFor(() => expect(screen.getByText("+ إضافة سجل راتب")).toBeInTheDocument());
    fireEvent.click(screen.getByText("+ إضافة سجل راتب"));

    let capturedBody: unknown = null;
    vi.mocked(apiFetch).mockImplementation((path: unknown, opts?: RequestInit) => {
      const p = String(path);
      const method = opts?.method;
      if (p === "/auth/me") return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "c1", name: "Test Co" } });
      if (p === "/payroll-records" && method === "POST") {
        capturedBody = JSON.parse(opts!.body as string);
        return Promise.resolve(fixtureRecord);
      }
      if (p === "/payroll-periods/period-1") return Promise.resolve(fixturePeriod());
      if (p === "/employees") return Promise.resolve([fixtureEmployee]);
      return Promise.reject(new Error(`unexpected: ${p} ${method}`));
    });

    fireEvent.change(screen.getByPlaceholderText("الأساسي"), { target: { value: "3000" } });
    fireEvent.click(screen.getByRole("button", { name: "حفظ السجل" }));

    await waitFor(() =>
      expect(capturedBody).toEqual({ payrollPeriodId: "period-1", employeeId: "emp-1", grossAmount: 3000 }),
    );
  });
});
