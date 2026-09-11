import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { AuthProvider } from "../../auth/AuthContext";
import { I18nProvider } from "../../i18n/I18nProvider";
import { ProgressSection } from "./ProgressSection";
import type { Measurement, MeasurementWithLines, Contract, BoqRevision, BoqRevisionWithItems } from "../../api/types";

vi.mock("../context", () => ({
  useProjectContext: () => ({ project: null, projectId: "p1" }),
}));

vi.mock("../../api/client", async () => {
  const actual = await vi.importActual<typeof import("../../api/client")>("../../api/client");
  return { ...actual, getToken: () => "fake-token", apiFetch: vi.fn() };
});

import { apiFetch } from "../../api/client";

const fixtureContract: Contract = {
  id: "c1",
  companyId: "co1",
  projectId: "p1",
  contractType: "main",
  parentContractId: null,
  contractNumber: "C-1",
  clientName: null,
  originalValue: "1000.00",
  revisedValue: "1000.00",
  currency: "SAR",
  advancePercent: null,
  retentionPercent: null,
  paymentTerms: null,
  status: "active",
  startDate: null,
  endDate: null,
  createdBy: "u1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const fixtureRevision: BoqRevision = {
  id: "rev1",
  companyId: "co1",
  projectId: "p1",
  contractId: "c1",
  revisionNumber: 1,
  status: "published",
  supersedesRevisionId: null,
  notes: null,
  createdBy: "u1",
  createdAt: "2026-01-01T00:00:00.000Z",
  publishedAt: "2026-01-02T00:00:00.000Z",
};

const fixtureRevisionWithItems: BoqRevisionWithItems = {
  ...fixtureRevision,
  items: [
    {
      id: "bi-1",
      boqRevisionId: "rev1",
      parentItemId: null,
      itemType: "item",
      code: "1.1",
      description: "حفر أساسات",
      unit: "م3",
      quantity: "100.000",
      rate: "10.00",
      amount: "1000.00",
      costCodeId: null,
      sortOrder: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ],
};

const fixtureMeasurementDraft: Measurement = {
  id: "m1",
  companyId: "co1",
  projectId: "p1",
  contractId: "c1",
  boqRevisionId: "rev1",
  status: "draft",
  measurementDate: "2026-01-10",
  description: "قياس تجريبي",
  createdBy: "u1",
  createdAt: "2026-01-10T00:00:00.000Z",
  updatedAt: "2026-01-10T00:00:00.000Z",
  submittedBy: null,
  submittedAt: null,
  approvedBy: null,
  approvedAt: null,
  rejectedBy: null,
  rejectedAt: null,
  rejectionReason: null,
};

// line.value (999.00) is deliberately NOT measuredQuantity * boqItem.rate
// (20 * 10 = 200.00) — set to a different value on purpose, so asserting
// the UI shows 999.00 proves the displayed value comes from the backend's
// own frozen `value`, never a client-side re-computation.
const fixtureMeasurementDetail: MeasurementWithLines = {
  ...fixtureMeasurementDraft,
  lines: [
    {
      id: "ml-1",
      companyId: "co1",
      measurementId: "m1",
      boqItemId: "bi-1",
      measuredQuantity: "20.000",
      value: "999.00",
      notes: null,
      createdAt: "2026-01-10T00:00:00.000Z",
    },
  ],
};

const fixtureMeasurementSubmitted: MeasurementWithLines = {
  ...fixtureMeasurementDetail,
  status: "submitted",
  submittedBy: "u1",
  submittedAt: "2026-01-11T00:00:00.000Z",
};

function mockApi(role: "owner" | "member", measurementDetail: MeasurementWithLines = fixtureMeasurementDetail) {
  vi.mocked(apiFetch).mockImplementation((path: unknown, reqOpts?: RequestInit) => {
    const p = String(path);
    const method = reqOpts?.method ?? "GET";
    if (p === "/auth/me") {
      return Promise.resolve({
        user: { id: "u1", name: "Test", email: "t@test.com", role },
        company: { id: "co1", name: "Test Co" },
      });
    }
    if (p === "/projects/p1/measurements" && method === "GET") {
      return Promise.resolve([fixtureMeasurementDraft]);
    }
    if (p === "/projects/p1/contracts" && method === "GET") {
      return Promise.resolve([fixtureContract]);
    }
    if (p === "/projects/p1/boq-revisions" && method === "GET") {
      return Promise.resolve([fixtureRevision]);
    }
    if (p === "/projects/p1/measurements/m1" && method === "GET") {
      return Promise.resolve(measurementDetail);
    }
    if (p === "/projects/p1/boq-revisions/rev1" && method === "GET") {
      return Promise.resolve(fixtureRevisionWithItems);
    }
    return Promise.reject(new Error(`unexpected apiFetch call in test: ${p} ${method}`));
  });
}

function renderSection() {
  return render(
    <I18nProvider>
      <AuthProvider>
        <ProgressSection />
      </AuthProvider>
    </I18nProvider>,
  );
}

describe("<ProgressSection/>", () => {
  it("renders the measurement list from backend data", async () => {
    mockApi("owner");
    renderSection();
    await waitFor(() => expect(screen.getByText("قياس تجريبي")).toBeInTheDocument());
    expect(screen.getByText("C-1")).toBeInTheDocument();
    expect(screen.getByText("مسودة")).toBeInTheDocument();
  });

  it("shows an honest empty state when there are no measurements yet", async () => {
    vi.mocked(apiFetch).mockImplementation((path: unknown) => {
      const p = String(path);
      if (p === "/auth/me") {
        return Promise.resolve({
          user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" },
          company: { id: "co1", name: "Test Co" },
        });
      }
      if (p === "/projects/p1/measurements") return Promise.resolve([]);
      if (p === "/projects/p1/contracts") return Promise.resolve([fixtureContract]);
      if (p === "/projects/p1/boq-revisions") return Promise.resolve([fixtureRevision]);
      return Promise.reject(new Error(`unexpected apiFetch call in test: ${p}`));
    });
    renderSection();
    await waitFor(() => expect(screen.getByText("لا توجد قياسات بعد")).toBeInTheDocument());
  });

  it("a member ALSO sees the ungated create-measurement control (backend has no RBAC gate on create)", async () => {
    mockApi("member");
    renderSection();
    await waitFor(() => expect(screen.getByText("قياس تجريبي")).toBeInTheDocument());
    expect(screen.getByText("+ قياس جديد")).toBeInTheDocument();
  });

  it("a member ALSO sees the add-line control on a draft (editable) measurement", async () => {
    mockApi("member");
    renderSection();
    await waitFor(() => expect(screen.getByText("قياس تجريبي")).toBeInTheDocument());
    fireEvent.click(screen.getByText("عرض"));
    await waitFor(() => expect(screen.getByRole("button", { name: "+ بند" })).toBeInTheDocument());
  });

  it("shows the backend's frozen line value, never a client-side recomputation of quantity * rate", async () => {
    mockApi("owner");
    renderSection();
    await waitFor(() => expect(screen.getByText("قياس تجريبي")).toBeInTheDocument());
    fireEvent.click(screen.getByText("عرض"));
    await waitFor(() => expect(screen.getByText(/حفر أساسات/)).toBeInTheDocument());
    // 999.00 is the backend's own frozen value; 200.00 would be a client
    // recompute of measuredQuantity (20) * boqItem.rate (10).
    expect(screen.getByText(/999\.00/)).toBeInTheDocument();
    expect(screen.queryByText(/200\.00/)).not.toBeInTheDocument();
  });

  it("RBAC: a member does NOT see approve/reject controls on a submitted measurement", async () => {
    mockApi("member", fixtureMeasurementSubmitted);
    renderSection();
    await waitFor(() => expect(screen.getByText("قياس تجريبي")).toBeInTheDocument());
    fireEvent.click(screen.getByText("عرض"));
    await waitFor(() => expect(screen.getByText("بانتظار الاعتماد")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "اعتماد" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "رفض" })).not.toBeInTheDocument();
    // A submitted measurement is no longer editable — the add-line control
    // must also be gone, independent of role.
    expect(screen.queryByRole("button", { name: "+ بند" })).not.toBeInTheDocument();
  });

  it("RBAC: an owner sees approve/reject controls on a submitted measurement", async () => {
    mockApi("owner", fixtureMeasurementSubmitted);
    renderSection();
    await waitFor(() => expect(screen.getByText("قياس تجريبي")).toBeInTheDocument());
    fireEvent.click(screen.getByText("عرض"));
    await waitFor(() => expect(screen.getByText("بانتظار الاعتماد")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "اعتماد" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "رفض" })).toBeInTheDocument();
  });

  it("shows an honest error state on API failure, not a fabricated empty list", async () => {
    vi.mocked(apiFetch).mockImplementation((path: unknown) => {
      const p = String(path);
      if (p === "/auth/me") {
        return Promise.resolve({
          user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" },
          company: { id: "co1", name: "Test Co" },
        });
      }
      if (p === "/projects/p1/measurements") return Promise.reject(new Error("تعذّر الاتصال بالخادم"));
      return Promise.reject(new Error(`unexpected apiFetch call in test: ${p}`));
    });
    renderSection();
    await waitFor(() => expect(screen.getByText("تعذّر الاتصال بالخادم")).toBeInTheDocument());
  });
});
