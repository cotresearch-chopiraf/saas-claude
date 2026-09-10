import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AuthProvider } from "../auth/AuthContext";
import { LaborAllocation } from "./LaborAllocation";
import type { LaborAllocation as LaborAllocationType, PayrollPeriodWithRecords, PayrollRecord, Project, CostCode } from "../api/types";

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return { ...actual, getToken: () => "fake-token", apiFetch: vi.fn() };
});

import { apiFetch } from "../api/client";

const fixturePeriod: PayrollPeriodWithRecords = {
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
  summary: { employeeCount: 1, totalGross: 10000, totalDeductions: 0, totalNet: 10000 },
  records: [],
};

const fixtureRecord: PayrollRecord = {
  id: "record-1",
  companyId: "c1",
  payrollPeriodId: "period-1",
  employeeId: "emp-1",
  grossAmount: "10000.00",
  deductionsAmount: "0.00",
  netAmount: "10000.00",
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

const fixtureProject: Project = {
  id: "proj-1",
  companyId: "c1",
  name: "برج الرياض",
  clientName: null,
  customerId: null,
  address: null,
  status: "active",
  budgetTotal: "0.00",
  startDate: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const fixtureCostCode: CostCode = {
  id: "cc-1",
  companyId: "c1",
  projectId: null,
  code: "01-LABOR",
  name: "عمالة عامة",
  category: "labor",
  parentCostCodeId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const fixtureAllocation: LaborAllocationType = {
  id: "alloc-1",
  companyId: "c1",
  payrollRecordId: "record-1",
  projectId: "proj-1",
  costCodeId: "cc-1",
  percentage: "60.00",
  amount: "6000.00",
  notes: null,
  createdBy: "u1",
  createdAt: "2026-09-01T00:00:00.000Z",
  project: { id: "proj-1", name: "برج الرياض" },
  costCode: { id: "cc-1", code: "01-LABOR", name: "عمالة عامة" },
};

function mockApi(
  role: "owner" | "member",
  opts: { period?: PayrollPeriodWithRecords; allocations?: LaborAllocationType[] } = {},
) {
  const period = opts.period ?? fixturePeriod;
  const allocations = opts.allocations ?? [];
  vi.mocked(apiFetch).mockImplementation((path: unknown, reqOpts?: RequestInit) => {
    const p = String(path);
    const method = reqOpts?.method;
    if (p === "/auth/me") {
      return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role }, company: { id: "c1", name: "Test Co" } });
    }
    if (p === "/payroll-periods/period-1" && (!method || method === "GET")) return Promise.resolve(period);
    if (p === "/payroll-records/record-1") return Promise.resolve(fixtureRecord);
    if (p.startsWith("/labor-allocations?payrollRecordId=record-1") && (!method || method === "GET")) return Promise.resolve(allocations);
    if (p === "/projects") return Promise.resolve([fixtureProject]);
    if (p.startsWith("/cost-codes")) return Promise.resolve([fixtureCostCode]);
    return Promise.reject(new Error(`unexpected apiFetch call in test: ${p} ${method ?? "GET"}`));
  });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/payroll/period-1/records/record-1/allocate"]}>
      <AuthProvider>
        <Routes>
          <Route path="/payroll/:periodId/records/:recordId/allocate" element={<LaborAllocation />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("<LaborAllocation/>", () => {
  it("renders payroll/allocated/remaining summary and the employee's identity, using backend-provided data only", async () => {
    mockApi("owner", { allocations: [fixtureAllocation] });
    renderPage();
    await waitFor(() => expect(screen.getByText("توزيع تكلفة أحمد الشمري")).toBeInTheDocument());
    expect(screen.getByText("رقم الموظف: EMP-1")).toBeInTheDocument();
    expect(screen.getByText("برج الرياض")).toBeInTheDocument();
    expect(screen.getByText("01-LABOR — عمالة عامة")).toBeInTheDocument();
    expect(screen.getByText("60%")).toBeInTheDocument();
  });

  it("shows an honest empty state when the payroll record has no allocations yet", async () => {
    mockApi("owner", { allocations: [] });
    renderPage();
    await waitFor(() => expect(screen.getByText("لم يُوزَّع هذا الراتب على أي مشروع بعد")).toBeInTheDocument());
  });

  it("a draft period shows the add-allocation control to an owner; a member sees neither add nor edit", async () => {
    mockApi("owner", { allocations: [fixtureAllocation] });
    renderPage();
    await waitFor(() => expect(screen.getByText("+ توزيع جديد")).toBeInTheDocument());
    expect(screen.getByText("تعديل")).toBeInTheDocument();
    expect(screen.getByText("حذف")).toBeInTheDocument();
  });

  it("a member never sees allocation mutation controls", async () => {
    mockApi("member", { allocations: [fixtureAllocation] });
    renderPage();
    await waitFor(() => expect(screen.getByText("برج الرياض")).toBeInTheDocument());
    expect(screen.queryByText("+ توزيع جديد")).not.toBeInTheDocument();
    expect(screen.queryByText("تعديل")).not.toBeInTheDocument();
    expect(screen.queryByText("حذف")).not.toBeInTheDocument();
  });

  it("a locked (submitted) period shows a banner and hides add/edit/delete controls entirely, even for an owner", async () => {
    mockApi("owner", { period: { ...fixturePeriod, status: "submitted" }, allocations: [fixtureAllocation] });
    renderPage();
    await waitFor(() => expect(screen.getByText("الفترة مغلقة")).toBeInTheDocument());
    expect(screen.getByText("لا يمكن تعديل توزيع هذا الراتب — تم إرسال فترة الرواتب أو اعتمادها بالفعل.")).toBeInTheDocument();
    expect(screen.queryByText("+ توزيع جديد")).not.toBeInTheDocument();
    expect(screen.queryByText("تعديل")).not.toBeInTheDocument();
    expect(screen.queryByText("حذف")).not.toBeInTheDocument();
  });

  it("shows an honest error state on API failure", async () => {
    vi.mocked(apiFetch).mockImplementation((path: unknown) => {
      const p = String(path);
      if (p === "/auth/me") return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "c1", name: "Test Co" } });
      if (p === "/payroll-periods/period-1") return Promise.reject(new Error("تعذّر الاتصال بالخادم"));
      if (p === "/projects") return Promise.resolve([]);
      return Promise.reject(new Error(`unexpected: ${p}`));
    });
    renderPage();
    await waitFor(() => expect(screen.getByText("تعذّر الاتصال بالخادم")).toBeInTheDocument());
  });

  it("submitting the add-allocation form sends project/costCode/percentage to POST /labor-allocations", async () => {
    mockApi("owner", { allocations: [] });
    renderPage();
    await waitFor(() => expect(screen.getByText("+ توزيع جديد")).toBeInTheDocument());
    fireEvent.click(screen.getByText("+ توزيع جديد"));
    await waitFor(() => expect(screen.getByText("01-LABOR — عمالة عامة")).toBeInTheDocument());

    let capturedBody: unknown = null;
    vi.mocked(apiFetch).mockImplementation((path: unknown, opts?: RequestInit) => {
      const p = String(path);
      const method = opts?.method;
      if (p === "/auth/me") return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "c1", name: "Test Co" } });
      if (p === "/labor-allocations" && method === "POST") {
        capturedBody = JSON.parse(opts!.body as string);
        return Promise.resolve(fixtureAllocation);
      }
      if (p === "/payroll-periods/period-1") return Promise.resolve(fixturePeriod);
      if (p === "/payroll-records/record-1") return Promise.resolve(fixtureRecord);
      if (p.startsWith("/labor-allocations?payrollRecordId=record-1")) return Promise.resolve([fixtureAllocation]);
      if (p === "/projects") return Promise.resolve([fixtureProject]);
      if (p.startsWith("/cost-codes")) return Promise.resolve([fixtureCostCode]);
      return Promise.reject(new Error(`unexpected: ${p} ${method}`));
    });

    fireEvent.change(screen.getByPlaceholderText(/النسبة %/), { target: { value: "60" } });
    fireEvent.click(screen.getByRole("button", { name: "حفظ التوزيع" }));

    await waitFor(() =>
      expect(capturedBody).toEqual({ payrollRecordId: "record-1", projectId: "proj-1", costCodeId: undefined, percentage: 60 }),
    );
  });
});
