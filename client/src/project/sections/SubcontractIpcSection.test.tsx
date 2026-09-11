import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "../../auth/AuthContext";
import { I18nProvider } from "../../i18n/I18nProvider";
import { SubcontractIpcSection } from "./SubcontractIpcSection";
import type { CommitmentWithLines, SubcontractIpcDocument, Supplier, SubcontractIpc, SubcontractIpcWithLines } from "../../api/types";

vi.mock("../context", () => ({
  useProjectContext: () => ({ project: null, projectId: "p1" }),
}));

vi.mock("../../api/client", async () => {
  const actual = await vi.importActual<typeof import("../../api/client")>("../../api/client");
  return { ...actual, getToken: () => "fake-token", apiFetch: vi.fn() };
});

import { apiFetch } from "../../api/client";

const fixtureSupplier: Supplier = {
  id: "supplier-1",
  companyId: "co1",
  name: "مقاولات الأمانة للباطن",
  type: "subcontractor",
  taxId: null,
  email: null,
  phone: null,
  address: null,
  status: "active",
  createdBy: "u1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const fixtureCommitment: CommitmentWithLines = {
  id: "commit-1",
  companyId: "co1",
  projectId: "p1",
  contractId: null,
  supplierId: "supplier-1",
  type: "subcontract",
  status: "active",
  commitmentNumber: 7,
  description: "أعمال الطوب والتشطيبات",
  originalAmount: "50000.00",
  revisedAmount: "50000.00",
  retentionPercent: "10.00",
  currency: "SAR",
  createdBy: "u1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  submittedAt: "2026-01-02T00:00:00.000Z",
  approvedBy: "u1",
  approvedAt: "2026-01-03T00:00:00.000Z",
  cancelledAt: null,
  lines: [
    {
      id: "cl-qty-1",
      companyId: "co1",
      commitmentId: "commit-1",
      costCodeId: null,
      boqItemId: null,
      description: "طوب — القياس بالكمية",
      quantity: "500.000",
      rate: "40.00",
      amount: "20000.00",
      sortOrder: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "cl-amt-2",
      companyId: "co1",
      commitmentId: "commit-1",
      costCodeId: null,
      boqItemId: null,
      description: "تعبئة موقع — مبلغ إجمالي",
      quantity: null,
      rate: null,
      amount: "5000.00",
      sortOrder: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ],
};

// Globally unique numeric values — the list can render several IPCs
// simultaneously. total values deliberately NOT subtotal-derivable (no
// arithmetic relationship enforced) to prove verbatim display.
const fixtureIpcDraft: SubcontractIpc = {
  id: "sipc-draft-1",
  companyId: "co1",
  projectId: "p1",
  commitmentId: "commit-1",
  ipcNumber: 1,
  status: "draft",
  periodStart: "2026-02-01",
  periodEnd: "2026-02-28",
  notes: "دفعة أولى تجريبية",
  grossValue: null,
  retentionPercent: null,
  retentionAmount: null,
  advanceRecoveryAmount: null,
  otherDeductions: null,
  netCertified: null,
  currency: "SAR",
  createdBy: "u1",
  createdAt: "2026-02-01T00:00:00.000Z",
  updatedAt: "2026-02-01T00:00:00.000Z",
  submittedBy: null,
  submittedAt: null,
  approvedBy: null,
  approvedAt: null,
  certifiedBy: null,
  certifiedAt: null,
  rejectedBy: null,
  rejectedAt: null,
  rejectionReason: null,
};

const fixtureIpcDraftDetail: SubcontractIpcWithLines = { ...fixtureIpcDraft, lines: [] };
const fixtureIpcDraftWithLine: SubcontractIpcWithLines = {
  ...fixtureIpcDraft,
  lines: [
    {
      id: "sipcl-1",
      companyId: "co1",
      subcontractIpcId: "sipc-draft-1",
      commitmentLineId: "cl-amt-2",
      description: null,
      currentQuantity: null,
      rate: null,
      currentValue: "3311.09",
      previousCertifiedQuantity: null,
      cumulativeQuantity: null,
      previousCertifiedValue: null,
      cumulativeValue: null,
      sortOrder: 0,
      createdAt: "2026-02-01T00:00:00.000Z",
    },
  ],
};

const fixtureIpcSubmitted: SubcontractIpc = { ...fixtureIpcDraft, id: "sipc-sub-2", ipcNumber: 2, status: "submitted", submittedAt: "2026-02-05T00:00:00.000Z" };
const fixtureIpcSubmittedDetail: SubcontractIpcWithLines = { ...fixtureIpcSubmitted, lines: [] };
const fixtureIpcApproved: SubcontractIpc = { ...fixtureIpcDraft, id: "sipc-app-3", ipcNumber: 3, status: "approved", submittedAt: "2026-02-05T00:00:00.000Z", approvedAt: "2026-02-06T00:00:00.000Z" };
const fixtureIpcApprovedDetail: SubcontractIpcWithLines = { ...fixtureIpcApproved, lines: [] };
const fixtureIpcRejected: SubcontractIpc = { ...fixtureIpcDraft, id: "sipc-rej-4", ipcNumber: 4, status: "rejected", rejectedAt: "2026-02-07T00:00:00.000Z", rejectionReason: "الكمية غير متوافقة مع الموقع" };
const fixtureIpcRejectedDetail: SubcontractIpcWithLines = { ...fixtureIpcRejected, lines: [] };

// grossValue/retentionAmount/netCertified deliberately NOT
// gross - 10% = net (2244.71 - 224.47 = 2020.24, but netCertified is set
// to 1999.01) — proves the UI shows exactly these numbers verbatim, never
// a client-side re-derivation.
const fixtureIpcCertified: SubcontractIpcWithLines = {
  ...fixtureIpcDraft,
  id: "sipc-cert-5",
  ipcNumber: 5,
  status: "certified",
  submittedAt: "2026-02-05T00:00:00.000Z",
  approvedAt: "2026-02-06T00:00:00.000Z",
  certifiedAt: "2026-02-08T00:00:00.000Z",
  grossValue: "2244.71",
  retentionPercent: "10.00",
  retentionAmount: "224.47",
  advanceRecoveryAmount: "0.00",
  otherDeductions: "0.00",
  netCertified: "1999.01",
  lines: [
    {
      id: "sipcl-cert-1",
      companyId: "co1",
      subcontractIpcId: "sipc-cert-5",
      commitmentLineId: "cl-qty-1",
      description: null,
      currentQuantity: "50.000",
      rate: "40.00",
      currentValue: "2244.71",
      previousCertifiedQuantity: "0.000",
      cumulativeQuantity: "50.000",
      previousCertifiedValue: "0.00",
      cumulativeValue: "2244.71",
      sortOrder: 0,
      createdAt: "2026-02-01T00:00:00.000Z",
    },
  ],
};

// Globally unique fixture — the evidence list can render several documents
// simultaneously.
const fixtureEvidenceDoc: SubcontractIpcDocument = {
  id: "sipcdoc-alpha-1",
  fileName: "صورة-تنفيذ-الطوب.jpg",
  mimeType: "image/jpeg",
  size: 812_004,
  uploadedAt: "2026-02-10T00:00:00.000Z",
  uploadedByName: "أحمد المالك",
  version: 1,
  previousVersionId: null,
};

function mockApi(
  role: "owner" | "member",
  ipcs: SubcontractIpc[],
  detailByIpcId: Record<string, SubcontractIpcWithLines> = {},
  documentsByIpcId: Record<string, SubcontractIpcDocument[]> = {},
) {
  vi.mocked(apiFetch).mockImplementation((path: unknown, reqOpts?: RequestInit) => {
    const p = String(path);
    const method = reqOpts?.method ?? "GET";
    if (p === "/auth/me") {
      return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role }, company: { id: "co1", name: "Test Co" } });
    }
    if (p === "/projects/p1/commitments/commit-1" && method === "GET") {
      return Promise.resolve(fixtureCommitment);
    }
    if (p === "/suppliers" && method === "GET") {
      return Promise.resolve([fixtureSupplier]);
    }
    if (p === "/projects/p1/subcontract-ipcs" && method === "GET") {
      return Promise.resolve(ipcs);
    }
    const documentsMatch = p.match(/^\/projects\/p1\/subcontract-ipcs\/([^/]+)\/documents$/);
    if (documentsMatch && method === "GET") {
      return Promise.resolve(documentsByIpcId[documentsMatch[1]] ?? []);
    }
    const detailMatch = p.match(/^\/projects\/p1\/subcontract-ipcs\/([^/]+)$/);
    if (detailMatch && method === "GET" && detailByIpcId[detailMatch[1]]) {
      return Promise.resolve(detailByIpcId[detailMatch[1]]);
    }
    return Promise.reject(new Error(`unexpected apiFetch call in test: ${p} ${method}`));
  });
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("unexpected global fetch call in test"))),
  );
});

function renderSection() {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={["/projects/p1/subcontract-ipcs/commit-1"]}>
        <AuthProvider>
          <Routes>
            <Route path="/projects/:id/subcontract-ipcs/:commitmentId" element={<SubcontractIpcSection />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    </I18nProvider>,
  );
}

describe("<SubcontractIpcSection/>", () => {
  it("renders the commitment's IPC list from backend data", async () => {
    mockApi("owner", [fixtureIpcDraft]);
    renderSection();
    await waitFor(() => expect(screen.getByText("#1")).toBeInTheDocument());
    expect(screen.getByText("مسودة")).toBeInTheDocument();
    expect(screen.getByText(/عقد الباطن #7/)).toBeInTheDocument();
    expect(screen.getByText(/مقاولات الأمانة للباطن/)).toBeInTheDocument();
  });

  it("renders multiple IPCs with distinct statuses simultaneously", async () => {
    mockApi("owner", [fixtureIpcDraft, fixtureIpcSubmitted, fixtureIpcApproved, fixtureIpcRejected]);
    renderSection();
    await waitFor(() => expect(screen.getByText("#1")).toBeInTheDocument());
    expect(screen.getByText("#2")).toBeInTheDocument();
    expect(screen.getByText("#3")).toBeInTheDocument();
    expect(screen.getByText("#4")).toBeInTheDocument();
  });

  it("shows an honest empty state when there are no IPCs yet for this commitment", async () => {
    mockApi("owner", []);
    renderSection();
    await waitFor(() => expect(screen.getByText("لا توجد شهادات دفع لهذا العقد بعد")).toBeInTheDocument());
  });

  it("RBAC: a member does NOT see the create-IPC control", async () => {
    mockApi("member", [fixtureIpcDraft]);
    renderSection();
    await waitFor(() => expect(screen.getByText("#1")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "+ شهادة جديدة" })).not.toBeInTheDocument();
  });

  it("RBAC: an owner sees the create-IPC control", async () => {
    mockApi("owner", [fixtureIpcDraft]);
    renderSection();
    await waitFor(() => expect(screen.getByText("#1")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "+ شهادة جديدة" })).toBeInTheDocument();
  });

  it("RBAC: a member sees a draft IPC's detail read-only — no add-line or submit controls", async () => {
    mockApi("member", [fixtureIpcDraft], { "sipc-draft-1": fixtureIpcDraftDetail });
    renderSection();
    await waitFor(() => expect(screen.getByText("#1")).toBeInTheDocument());
    fireEvent.click(screen.getByText("عرض"));
    await waitFor(() => expect(screen.getByText("دفعة أولى تجريبية")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "+ بند" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "إرسال للاعتماد" })).not.toBeInTheDocument();
  });

  it("Lifecycle: an owner sees add-line and submit controls on a draft IPC", async () => {
    mockApi("owner", [fixtureIpcDraft], { "sipc-draft-1": fixtureIpcDraftDetail });
    renderSection();
    await waitFor(() => expect(screen.getByText("#1")).toBeInTheDocument());
    fireEvent.click(screen.getByText("عرض"));
    await waitFor(() => expect(screen.getByRole("button", { name: "+ بند" })).toBeInTheDocument());
    // Submit is disabled with zero lines.
    expect(screen.getByRole("button", { name: "إرسال للاعتماد" })).toBeDisabled();
  });

  it("Lifecycle: the line picker shows quantity/rate fields for a quantity-typed commitment line and amount fields for an amount-only line", async () => {
    mockApi("owner", [fixtureIpcDraft], { "sipc-draft-1": fixtureIpcDraftDetail });
    renderSection();
    await waitFor(() => expect(screen.getByText("#1")).toBeInTheDocument());
    fireEvent.click(screen.getByText("عرض"));
    await waitFor(() => expect(screen.getByRole("button", { name: "+ بند" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "+ بند" }));

    const select = screen.getByRole("combobox");
    // Default selection is the first commitment line (quantity/rate).
    expect(within(select).getByText("طوب — القياس بالكمية")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("الكمية الحالية")).toBeInTheDocument();

    fireEvent.change(select, { target: { value: "cl-amt-2" } });
    expect(screen.getByPlaceholderText("قيمة التصديق الحالية")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("الكمية الحالية")).not.toBeInTheDocument();
  });

  it("Lifecycle: an owner sees approve/reject controls on a submitted IPC", async () => {
    mockApi("owner", [fixtureIpcSubmitted], { "sipc-sub-2": fixtureIpcSubmittedDetail });
    renderSection();
    await waitFor(() => expect(screen.getByText("#2")).toBeInTheDocument());
    fireEvent.click(screen.getByText("عرض"));
    await waitFor(() => expect(screen.getByRole("button", { name: "اعتماد" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "رفض" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+ بند" })).not.toBeInTheDocument();
  });

  it("Lifecycle: an owner sees the certify control on an approved IPC", async () => {
    mockApi("owner", [fixtureIpcApproved], { "sipc-app-3": fixtureIpcApprovedDetail });
    renderSection();
    await waitFor(() => expect(screen.getByText("#3")).toBeInTheDocument());
    fireEvent.click(screen.getByText("عرض"));
    await waitFor(() => expect(screen.getByRole("button", { name: "تصديق" })).toBeInTheDocument());
  });

  it("Lifecycle: a certified IPC has no mutation controls for the owner either", async () => {
    mockApi("owner", [fixtureIpcCertified], { "sipc-cert-5": fixtureIpcCertified });
    renderSection();
    await waitFor(() => expect(screen.getByText("#5")).toBeInTheDocument());
    fireEvent.click(screen.getByText("عرض"));
    await waitFor(() => expect(screen.getByText("مصدَّقة")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "+ بند" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "تصديق" })).not.toBeInTheDocument();
  });

  it("Rejection: shows the rejection reason on a rejected IPC, which rejoins the editable pool", async () => {
    mockApi("owner", [fixtureIpcRejected], { "sipc-rej-4": fixtureIpcRejectedDetail });
    renderSection();
    await waitFor(() => expect(screen.getByText("#4")).toBeInTheDocument());
    fireEvent.click(screen.getByText("عرض"));
    await waitFor(() => expect(screen.getByText("مرفوضة")).toBeInTheDocument());
    expect(screen.getByText("الكمية غير متوافقة مع الموقع")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ بند" })).toBeInTheDocument();
  });

  it("Financial truth: a certified IPC's line and header totals are displayed verbatim, never recomputed", async () => {
    mockApi("owner", [fixtureIpcCertified], { "sipc-cert-5": fixtureIpcCertified });
    renderSection();
    await waitFor(() => expect(screen.getByText("#5")).toBeInTheDocument());
    fireEvent.click(screen.getByText("عرض"));
    await waitFor(() => expect(screen.getByText(/طوب — القياس بالكمية/)).toBeInTheDocument());

    // gross = 2244.71, retention = 224.47, net = 1999.01 — displayed as-is.
    expect(screen.getAllByText(/2,244\.71/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/224\.47/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/1,999\.01/).length).toBeGreaterThan(0);
    // A client-side gross-retention recomputation would show 2020.24 — must never appear.
    expect(screen.queryByText(/2,020\.24/)).not.toBeInTheDocument();
  });

  it("shows an honest, retryable error state on API failure, not a fabricated empty list", async () => {
    vi.mocked(apiFetch).mockImplementation((path: unknown) => {
      const p = String(path);
      if (p === "/auth/me") return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "co1", name: "Test Co" } });
      if (p === "/projects/p1/subcontract-ipcs") return Promise.reject(new Error("تعذّر الاتصال بالخادم"));
      if (p === "/projects/p1/commitments/commit-1") return Promise.resolve(fixtureCommitment);
      if (p === "/suppliers") return Promise.resolve([fixtureSupplier]);
      return Promise.reject(new Error(`unexpected apiFetch call in test: ${p}`));
    });
    renderSection();
    await waitFor(() => expect(screen.getByText("تعذّر الاتصال بالخادم")).toBeInTheDocument());
  });

  it("Mutation refresh: after submit, the UI reflects the backend's returned status, not a locally-guessed one", async () => {
    mockApi("owner", [fixtureIpcDraft], { "sipc-draft-1": fixtureIpcDraftWithLine });
    renderSection();
    await waitFor(() => expect(screen.getByText("#1")).toBeInTheDocument());
    fireEvent.click(screen.getByText("عرض"));
    await waitFor(() => expect(screen.getByRole("button", { name: "إرسال للاعتماد" })).toBeEnabled());

    vi.mocked(apiFetch).mockImplementation((path: unknown, reqOpts?: RequestInit) => {
      const p = String(path);
      const method = reqOpts?.method ?? "GET";
      if (p === "/auth/me") return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "co1", name: "Test Co" } });
      if (p === "/projects/p1/commitments/commit-1") return Promise.resolve(fixtureCommitment);
      if (p === "/suppliers") return Promise.resolve([fixtureSupplier]);
      if (p === "/projects/p1/subcontract-ipcs" && method === "GET") return Promise.resolve([fixtureIpcDraft]);
      if (p === "/projects/p1/subcontract-ipcs/sipc-draft-1/submit" && method === "POST") return Promise.resolve({ ...fixtureIpcDraft, status: "submitted" });
      if (p === "/projects/p1/subcontract-ipcs/sipc-draft-1" && method === "GET") return Promise.resolve(fixtureIpcSubmittedDetail);
      return Promise.reject(new Error(`unexpected apiFetch call in test: ${p} ${method}`));
    });

    fireEvent.click(screen.getByRole("button", { name: "إرسال للاعتماد" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "إرسال" }));
    await waitFor(() => expect(screen.getByText("بانتظار الاعتماد")).toBeInTheDocument());
  });

  it("prevents duplicate mutation submission from a rapid double-click", async () => {
    mockApi("owner", [fixtureIpcApproved], { "sipc-app-3": fixtureIpcApprovedDetail });
    renderSection();
    await waitFor(() => expect(screen.getByText("#3")).toBeInTheDocument());
    fireEvent.click(screen.getByText("عرض"));
    await waitFor(() => expect(screen.getByRole("button", { name: "تصديق" })).toBeInTheDocument());

    let resolveCertify!: (v: unknown) => void;
    const pending = new Promise((resolve) => {
      resolveCertify = resolve;
    });
    let certifyCallCount = 0;
    vi.mocked(apiFetch).mockImplementation((path: unknown, reqOpts?: RequestInit) => {
      const p = String(path);
      const method = reqOpts?.method ?? "GET";
      if (p === "/auth/me") return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "co1", name: "Test Co" } });
      if (p === "/projects/p1/commitments/commit-1") return Promise.resolve(fixtureCommitment);
      if (p === "/suppliers") return Promise.resolve([fixtureSupplier]);
      if (p === "/projects/p1/subcontract-ipcs" && method === "GET") return Promise.resolve([fixtureIpcApproved]);
      if (p === "/projects/p1/subcontract-ipcs/sipc-app-3/certify" && method === "POST") {
        certifyCallCount += 1;
        return pending;
      }
      if (p === "/projects/p1/subcontract-ipcs/sipc-app-3" && method === "GET") return Promise.resolve(fixtureIpcCertified);
      return Promise.reject(new Error(`unexpected apiFetch call in test: ${p} ${method}`));
    });

    fireEvent.click(screen.getByRole("button", { name: "تصديق" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    const confirmBtn = within(screen.getByRole("dialog")).getByRole("button", { name: "تصديق" });
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(within(screen.getByRole("dialog")).getByText("جارٍ التنفيذ...")).toBeInTheDocument());
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "جارٍ التنفيذ..." }));

    expect(certifyCallCount).toBe(1);
    resolveCertify(fixtureIpcCertified);
    await waitFor(() => expect(screen.getByText("مصدَّقة")).toBeInTheDocument());
  });
});

function evidenceFile(name = "site-photo.jpg", size = 1024, type = "image/jpeg"): File {
  return new File([new Uint8Array(size)], name, { type });
}

// MIDAD Phase 3 — Subcontractor IPC Evidence. The evidence block is
// purely additive to the detail view already exercised above — these
// tests exist only to prove its own list/upload/download/RBAC behavior,
// never re-testing the IPC lifecycle itself.
describe("<SubcontractIpcSection/> — Evidence (Phase 3)", () => {
  it("owner sees the evidence upload control on an IPC's detail", async () => {
    mockApi("owner", [fixtureIpcDraft], { "sipc-draft-1": fixtureIpcDraftDetail }, {});
    renderSection();
    await waitFor(() => expect(screen.getByText("#1")).toBeInTheDocument());
    fireEvent.click(screen.getByText("عرض"));
    await waitFor(() => expect(screen.getByText("مرفقات الشهادة")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "رفع مرفق" })).toBeInTheDocument();
  });

  it("RBAC: a member does NOT see the upload control, but can see the evidence list (read is member-open)", async () => {
    mockApi("member", [fixtureIpcDraft], { "sipc-draft-1": fixtureIpcDraftDetail }, { "sipc-draft-1": [fixtureEvidenceDoc] });
    renderSection();
    await waitFor(() => expect(screen.getByText("#1")).toBeInTheDocument());
    fireEvent.click(screen.getByText("عرض"));
    await waitFor(() => expect(screen.getByText(fixtureEvidenceDoc.fileName)).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "رفع مرفق" })).not.toBeInTheDocument();
  });

  it("renders evidence documents returned by the backend for this IPC", async () => {
    mockApi("owner", [fixtureIpcDraft], { "sipc-draft-1": fixtureIpcDraftDetail }, { "sipc-draft-1": [fixtureEvidenceDoc] });
    renderSection();
    await waitFor(() => expect(screen.getByText("#1")).toBeInTheDocument());
    fireEvent.click(screen.getByText("عرض"));
    await waitFor(() => expect(screen.getByText(fixtureEvidenceDoc.fileName)).toBeInTheDocument());
    expect(screen.getByText("أحمد المالك")).toBeInTheDocument();
  });

  it("shows an honest empty state when this IPC has no evidence yet", async () => {
    mockApi("owner", [fixtureIpcDraft], { "sipc-draft-1": fixtureIpcDraftDetail }, {});
    renderSection();
    await waitFor(() => expect(screen.getByText("#1")).toBeInTheDocument());
    fireEvent.click(screen.getByText("عرض"));
    await waitFor(() => expect(screen.getByText("لا توجد مرفقات لهذه الشهادة بعد")).toBeInTheDocument());
  });

  it("rejects an unsupported file type client-side, before any request is sent", async () => {
    mockApi("owner", [fixtureIpcDraft], { "sipc-draft-1": fixtureIpcDraftDetail }, {});
    renderSection();
    await waitFor(() => expect(screen.getByText("#1")).toBeInTheDocument());
    fireEvent.click(screen.getByText("عرض"));
    await waitFor(() => expect(screen.getByText("مرفقات الشهادة")).toBeInTheDocument());

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const badFile = new File(["exe content"], "installer.exe", { type: "application/x-msdownload" });
    fireEvent.change(input, { target: { files: [badFile] } });

    expect(screen.getByText(/نوع الملف غير مسموح به/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "رفع مرفق" })).toBeDisabled();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("a successful upload refreshes the evidence list with the backend's own response", async () => {
    mockApi("owner", [fixtureIpcDraft], { "sipc-draft-1": fixtureIpcDraftDetail }, {});
    renderSection();
    await waitFor(() => expect(screen.getByText("#1")).toBeInTheDocument());
    fireEvent.click(screen.getByText("عرض"));
    await waitFor(() => expect(screen.getByText("لا توجد مرفقات لهذه الشهادة بعد")).toBeInTheDocument());

    const uploaded: SubcontractIpcDocument = { ...fixtureEvidenceDoc, id: "sipcdoc-new-9" };
    vi.mocked(fetch).mockImplementation((url: unknown) => {
      const u = String(url);
      if (u === "/api/projects/p1/subcontract-ipcs/sipc-draft-1/documents") {
        return Promise.resolve(new Response(JSON.stringify(uploaded), { status: 201 })) as unknown as Promise<Response>;
      }
      return Promise.reject(new Error(`unexpected fetch: ${u}`));
    });
    mockApi("owner", [fixtureIpcDraft], { "sipc-draft-1": fixtureIpcDraftDetail }, { "sipc-draft-1": [uploaded] });

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [evidenceFile()] } });
    fireEvent.click(screen.getByRole("button", { name: "رفع مرفق" }));

    await waitFor(() => expect(screen.getByText(uploaded.fileName)).toBeInTheDocument());
  });

  it("the download action fetches the authenticated binary route with the current project/ipc/document id", async () => {
    mockApi("owner", [fixtureIpcDraft], { "sipc-draft-1": fixtureIpcDraftDetail }, { "sipc-draft-1": [fixtureEvidenceDoc] });
    renderSection();
    await waitFor(() => expect(screen.getByText("#1")).toBeInTheDocument());
    fireEvent.click(screen.getByText("عرض"));
    await waitFor(() => expect(screen.getByText(fixtureEvidenceDoc.fileName)).toBeInTheDocument());

    vi.mocked(fetch).mockResolvedValue(new Response(new Blob(["jpg-bytes"]), { status: 200 }));
    fireEvent.click(screen.getByRole("button", { name: "تنزيل" }));

    await waitFor(() =>
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        `/api/projects/p1/subcontract-ipcs/sipc-draft-1/documents/${fixtureEvidenceDoc.id}`,
        expect.objectContaining({ headers: { Authorization: "Bearer fake-token" } }),
      ),
    );
  });
});
