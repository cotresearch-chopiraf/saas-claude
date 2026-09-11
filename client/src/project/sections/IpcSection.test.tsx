import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { AuthProvider } from "../../auth/AuthContext";
import { I18nProvider } from "../../i18n/I18nProvider";
import { IpcSection } from "./IpcSection";
import type { Ipc, IpcWithLines, Contract, BoqRevision, BoqRevisionWithItems } from "../../api/types";

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
  retentionPercent: "5.00",
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
      rate: "50.00",
      amount: "5000.00",
      costCodeId: null,
      sortOrder: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ],
};

const fixtureIpcDraft: Ipc = {
  id: "ipc1",
  companyId: "co1",
  projectId: "p1",
  contractId: "c1",
  boqRevisionId: "rev1",
  ipcNumber: 1,
  status: "draft",
  periodStart: "2026-08-01",
  periodEnd: "2026-08-31",
  notes: "شهادة تجريبية",
  grossValue: null,
  retentionAmount: null,
  advanceRecoveryAmount: null,
  otherDeductions: null,
  netCertified: null,
  currency: "SAR",
  createdBy: "u1",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
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

// currentValue (733.19) is deliberately NOT currentQuantity (10) * rate
// (50) = 500.00; previousCertifiedQuantity/cumulativeQuantity are set so
// cumulative is NOT simply previous + current (3 + 10 = 13, but set to
// 20); grossValue/retentionAmount/netCertified are deliberately NOT
// gross - retention - advance - other (733.19 - 88.88 = 644.31, but
// netCertified is set to 611.11) — all set on purpose so asserting the UI
// shows exactly these numbers proves they come verbatim from the
// backend's own certification, never a client-side re-derivation.
const fixtureIpcCertified: IpcWithLines = {
  ...fixtureIpcDraft,
  status: "certified",
  submittedAt: "2026-08-02T00:00:00.000Z",
  approvedAt: "2026-08-03T00:00:00.000Z",
  certifiedAt: "2026-08-04T00:00:00.000Z",
  grossValue: "733.19",
  retentionAmount: "88.88",
  advanceRecoveryAmount: "0.00",
  otherDeductions: "0.00",
  netCertified: "611.11",
  lines: [
    {
      id: "line1",
      companyId: "co1",
      ipcId: "ipc1",
      boqItemId: "bi-1",
      description: null,
      currentQuantity: "10.000",
      rate: "50.00",
      currentValue: "733.19",
      previousCertifiedQuantity: "3.000",
      previousCertifiedValue: "150.00",
      cumulativeQuantity: "20.000",
      sortOrder: 0,
      createdAt: "2026-08-01T00:00:00.000Z",
    },
  ],
};

const fixtureIpcSubmitted: IpcWithLines = { ...fixtureIpcDraft, status: "submitted", submittedAt: "2026-08-02T00:00:00.000Z", lines: [] };
const fixtureIpcApproved: IpcWithLines = { ...fixtureIpcDraft, status: "approved", submittedAt: "2026-08-02T00:00:00.000Z", approvedAt: "2026-08-03T00:00:00.000Z", lines: [] };
const fixtureIpcRejected: IpcWithLines = {
  ...fixtureIpcDraft,
  status: "rejected",
  rejectedAt: "2026-08-03T00:00:00.000Z",
  rejectionReason: "الكميات غير مطابقة للموقع",
  lines: [],
};
const fixtureIpcDraftDetail: IpcWithLines = { ...fixtureIpcDraft, lines: [] };
// A draft with a line — submit is only enabled once at least one line
// exists (matches the backend's own "no lines" rejection).
const fixtureIpcDraftWithLine: IpcWithLines = { ...fixtureIpcDraft, lines: [fixtureIpcCertified.lines[0]] };

function mockApi(role: "owner" | "member", ipcDetail: IpcWithLines = fixtureIpcDraftDetail) {
  vi.mocked(apiFetch).mockImplementation((path: unknown, reqOpts?: RequestInit) => {
    const p = String(path);
    const method = reqOpts?.method ?? "GET";
    if (p === "/auth/me") {
      return Promise.resolve({
        user: { id: "u1", name: "Test", email: "t@test.com", role },
        company: { id: "co1", name: "Test Co" },
      });
    }
    if (p === "/projects/p1/ipcs" && method === "GET") {
      return Promise.resolve([fixtureIpcDraft]);
    }
    if (p === "/projects/p1/contracts" && method === "GET") {
      return Promise.resolve([fixtureContract]);
    }
    if (p === "/projects/p1/boq-revisions" && method === "GET") {
      return Promise.resolve([fixtureRevision]);
    }
    if (p === "/projects/p1/ipcs/ipc1" && method === "GET") {
      return Promise.resolve(ipcDetail);
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
        <IpcSection />
      </AuthProvider>
    </I18nProvider>,
  );
}

describe("<IpcSection/>", () => {
  it("renders the IPC list from backend data", async () => {
    mockApi("owner");
    renderSection();
    await waitFor(() => expect(screen.getByText("C-1")).toBeInTheDocument());
    expect(screen.getByText("C-1")).toBeInTheDocument();
    expect(screen.getByText("مسودة")).toBeInTheDocument();
  });

  it("shows an honest empty state when there are no IPCs yet", async () => {
    vi.mocked(apiFetch).mockImplementation((path: unknown) => {
      const p = String(path);
      if (p === "/auth/me") return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "co1", name: "Test Co" } });
      if (p === "/projects/p1/ipcs") return Promise.resolve([]);
      if (p === "/projects/p1/contracts") return Promise.resolve([fixtureContract]);
      if (p === "/projects/p1/boq-revisions") return Promise.resolve([fixtureRevision]);
      return Promise.reject(new Error(`unexpected apiFetch call in test: ${p}`));
    });
    renderSection();
    await waitFor(() => expect(screen.getByText("لا توجد شهادات دفع بعد")).toBeInTheDocument());
  });

  it("RBAC: a member does NOT see the create-IPC control", async () => {
    mockApi("member");
    renderSection();
    await waitFor(() => expect(screen.getByText("C-1")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "+ شهادة جديدة" })).not.toBeInTheDocument();
  });

  it("RBAC: an owner sees the create-IPC control", async () => {
    mockApi("owner");
    renderSection();
    await waitFor(() => expect(screen.getByText("C-1")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "+ شهادة جديدة" })).toBeInTheDocument();
  });

  it("RBAC: a member sees a draft IPC's detail read-only — no add-line or submit controls", async () => {
    mockApi("member");
    renderSection();
    await waitFor(() => expect(screen.getByText("C-1")).toBeInTheDocument());
    fireEvent.click(screen.getByText("عرض"));
    // The list row and the detail header would both show "مسودة"
    // simultaneously here (the list mock always returns a draft-status
    // row) — wait for the notes field instead, which only the detail view
    // renders, to know detail has actually finished loading.
    await waitFor(() => expect(screen.getByText("شهادة تجريبية")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "+ بند" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "إرسال للاعتماد" })).not.toBeInTheDocument();
  });

  it("RBAC: a member sees a submitted IPC's detail read-only — no approve or reject controls", async () => {
    mockApi("member", fixtureIpcSubmitted);
    renderSection();
    await waitFor(() => expect(screen.getByText("C-1")).toBeInTheDocument());
    fireEvent.click(screen.getByText("عرض"));
    await waitFor(() => expect(screen.getByText("بانتظار الاعتماد")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "اعتماد" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "رفض" })).not.toBeInTheDocument();
  });

  it("RBAC: a member sees an approved IPC's detail read-only — no certify control", async () => {
    mockApi("member", fixtureIpcApproved);
    renderSection();
    await waitFor(() => expect(screen.getByText("C-1")).toBeInTheDocument());
    fireEvent.click(screen.getByText("عرض"));
    await waitFor(() => expect(screen.getByText("معتمدة (بانتظار التصديق)")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "تصديق" })).not.toBeInTheDocument();
  });

  it("Lifecycle: an owner sees add-line and submit controls on a draft IPC", async () => {
    mockApi("owner");
    renderSection();
    await waitFor(() => expect(screen.getByText("C-1")).toBeInTheDocument());
    fireEvent.click(screen.getByText("عرض"));
    await waitFor(() => expect(screen.getByRole("button", { name: "+ بند" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "إرسال للاعتماد" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "اعتماد" })).not.toBeInTheDocument();
  });

  it("Lifecycle: an owner sees approve and reject controls on a submitted IPC", async () => {
    mockApi("owner", fixtureIpcSubmitted);
    renderSection();
    await waitFor(() => expect(screen.getByText("C-1")).toBeInTheDocument());
    fireEvent.click(screen.getByText("عرض"));
    await waitFor(() => expect(screen.getByRole("button", { name: "اعتماد" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "رفض" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+ بند" })).not.toBeInTheDocument();
  });

  it("Lifecycle: an owner sees the certify control on an approved IPC", async () => {
    mockApi("owner", fixtureIpcApproved);
    renderSection();
    await waitFor(() => expect(screen.getByText("C-1")).toBeInTheDocument());
    fireEvent.click(screen.getByText("عرض"));
    await waitFor(() => expect(screen.getByRole("button", { name: "تصديق" })).toBeInTheDocument());
  });

  it("Lifecycle: a certified IPC has no mutation controls for the owner either", async () => {
    mockApi("owner", fixtureIpcCertified);
    renderSection();
    await waitFor(() => expect(screen.getByText("C-1")).toBeInTheDocument());
    fireEvent.click(screen.getByText("عرض"));
    await waitFor(() => expect(screen.getByText("مصدَّقة")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "+ بند" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "تصديق" })).not.toBeInTheDocument();
  });

  it("Rejection: shows the rejection reason on a rejected IPC", async () => {
    mockApi("owner", fixtureIpcRejected);
    renderSection();
    await waitFor(() => expect(screen.getByText("C-1")).toBeInTheDocument());
    fireEvent.click(screen.getByText("عرض"));
    await waitFor(() => expect(screen.getByText("مرفوضة")).toBeInTheDocument());
    expect(screen.getByText("الكميات غير مطابقة للموقع")).toBeInTheDocument();
    // Rejected rejoins the editable/draft-equivalent flow.
    expect(screen.getByRole("button", { name: "+ بند" })).toBeInTheDocument();
  });

  it("Financial truth: a certified IPC's line and totals are displayed verbatim, never recomputed", async () => {
    mockApi("owner", fixtureIpcCertified);
    renderSection();
    await waitFor(() => expect(screen.getByText("C-1")).toBeInTheDocument());
    fireEvent.click(screen.getByText("عرض"));
    await waitFor(() => expect(screen.getByText(/حفر أساسات/)).toBeInTheDocument());

    // Line: currentValue = 733.19, NOT quantity(10) * rate(50) = 500.00.
    expect(screen.getAllByText(/733\.19/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/^500\.00$/)).not.toBeInTheDocument();
    // Cumulative = 20 (fixture), NOT previous(3) + current(10) = 13 — the
    // value a client-side addition would produce.
    expect(screen.getAllByText("20").length).toBeGreaterThan(0);
    expect(screen.queryByText("13")).not.toBeInTheDocument();
    // Gross/retention/net shown verbatim.
    expect(screen.getAllByText(/88\.88/).length).toBeGreaterThan(0);
    // net = 611.11, NOT gross(733.19) - retention(88.88) = 644.31.
    expect(screen.getAllByText(/611\.11/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/644\.31/)).not.toBeInTheDocument();
  });

  it("shows an honest, retryable error state on API failure, not a fabricated empty list", async () => {
    vi.mocked(apiFetch).mockImplementation((path: unknown) => {
      const p = String(path);
      if (p === "/auth/me") return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "co1", name: "Test Co" } });
      if (p === "/projects/p1/ipcs") return Promise.reject(new Error("تعذّر الاتصال بالخادم"));
      return Promise.reject(new Error(`unexpected apiFetch call in test: ${p}`));
    });
    renderSection();
    await waitFor(() => expect(screen.getByText("تعذّر الاتصال بالخادم")).toBeInTheDocument());
  });

  it("Mutation refresh: after submit, the UI reflects the backend's returned status, not a locally-guessed one", async () => {
    mockApi("owner", fixtureIpcDraftWithLine);
    renderSection();
    await waitFor(() => expect(screen.getByText("C-1")).toBeInTheDocument());
    fireEvent.click(screen.getByText("عرض"));
    await waitFor(() => expect(screen.getByRole("button", { name: "إرسال للاعتماد" })).toBeInTheDocument());

    // By this point the initial detail load (draft) has already happened
    // under the previous mock — the only remaining getIpc call is the
    // reload submit() itself triggers, which must return the backend's
    // actual post-submit state, not a second draft read.
    vi.mocked(apiFetch).mockImplementation((path: unknown, reqOpts?: RequestInit) => {
      const p = String(path);
      const method = reqOpts?.method ?? "GET";
      if (p === "/auth/me") return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "co1", name: "Test Co" } });
      if (p === "/projects/p1/ipcs" && method === "GET") return Promise.resolve([fixtureIpcDraft]);
      if (p === "/projects/p1/contracts") return Promise.resolve([fixtureContract]);
      if (p === "/projects/p1/boq-revisions" && method === "GET") return Promise.resolve([fixtureRevision]);
      if (p === "/projects/p1/boq-revisions/rev1") return Promise.resolve(fixtureRevisionWithItems);
      if (p === "/projects/p1/ipcs/ipc1/submit" && method === "POST") return Promise.resolve({ ...fixtureIpcDraft, status: "submitted" });
      if (p === "/projects/p1/ipcs/ipc1" && method === "GET") return Promise.resolve(fixtureIpcSubmitted);
      return Promise.reject(new Error(`unexpected apiFetch call in test: ${p} ${method}`));
    });

    fireEvent.click(screen.getByRole("button", { name: "إرسال للاعتماد" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "إرسال" }));
    await waitFor(() => expect(screen.getByText("بانتظار الاعتماد")).toBeInTheDocument());
  });
});
