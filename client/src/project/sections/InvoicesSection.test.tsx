import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { AuthProvider } from "../../auth/AuthContext";
import { InvoicesSection } from "./InvoicesSection";
import type { Contract, Invoice } from "../../api/types";

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
  contractNumber: "C-INV-77",
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

// Every numeric value below is globally unique across the whole file (the
// list can render several invoices simultaneously, unlike a
// single-selection detail view) — this avoids getByText collisions.
// total is deliberately NOT subtotal + taxAmount for the draft/sent
// fixtures (4321.55 + 648.23 = 4969.78, not 5500.01) — proving the UI
// displays the backend's own total verbatim rather than recomputing it.
const fixtureInvoiceDraft: Invoice = {
  id: "inv-draft-1",
  companyId: "co1",
  quoteId: null,
  projectId: "p1",
  contractId: null,
  invoiceNumber: "INV-2001",
  clientName: "شركة الاختبار الأولى",
  clientAddress: null,
  clientTaxId: null,
  taxRatePercent: "15.00",
  language: "ar",
  status: "draft",
  publicToken: "tok-1",
  issueDate: "2026-01-05",
  dueDate: "2026-02-05",
  paidAt: null,
  createdAt: "2026-01-05T00:00:00.000Z",
  subtotal: 4321.55,
  taxAmount: 648.23,
  total: 5500.01,
};

const fixtureInvoiceSent: Invoice = {
  ...fixtureInvoiceDraft,
  id: "inv-sent-2",
  contractId: "c1",
  invoiceNumber: "INV-3092",
  status: "sent",
  issueDate: "2026-01-10",
  dueDate: "2026-02-10",
  subtotal: 7654.11,
  taxAmount: 1148.12,
  total: 8888.33,
};

const fixtureInvoicePaid: Invoice = {
  ...fixtureInvoiceDraft,
  id: "inv-paid-3",
  invoiceNumber: "INV-4183",
  status: "paid",
  paidAt: "2026-01-20T00:00:00.000Z",
  subtotal: 2222.22,
  taxAmount: 333.33,
  total: 2666.66,
};

function mockApi(role: "owner" | "member", invoices: Invoice[] = [fixtureInvoiceDraft]) {
  vi.mocked(apiFetch).mockImplementation((path: unknown, reqOpts?: RequestInit) => {
    const p = String(path);
    const method = reqOpts?.method ?? "GET";
    if (p === "/auth/me") {
      return Promise.resolve({
        user: { id: "u1", name: "Test", email: "t@test.com", role },
        company: { id: "co1", name: "Test Co" },
      });
    }
    if (p === "/projects/p1/invoices" && method === "GET") {
      return Promise.resolve(invoices);
    }
    if (p === "/projects/p1/contracts" && method === "GET") {
      return Promise.resolve([fixtureContract]);
    }
    return Promise.reject(new Error(`unexpected apiFetch call in test: ${p} ${method}`));
  });
}

function renderSection() {
  return render(
    <AuthProvider>
      <InvoicesSection />
    </AuthProvider>,
  );
}

describe("<InvoicesSection/>", () => {
  it("renders the project's invoices from the backend", async () => {
    mockApi("owner");
    renderSection();
    await waitFor(() => expect(screen.getByText("INV-2001")).toBeInTheDocument());
    expect(screen.getByText("مسودة")).toBeInTheDocument();
  });

  it("renders multiple invoices with distinct statuses simultaneously", async () => {
    mockApi("owner", [fixtureInvoiceDraft, fixtureInvoiceSent, fixtureInvoicePaid]);
    renderSection();
    await waitFor(() => expect(screen.getByText("INV-2001")).toBeInTheDocument());
    expect(screen.getByText("INV-3092")).toBeInTheDocument();
    expect(screen.getByText("INV-4183")).toBeInTheDocument();
    expect(screen.getByText("مسودة")).toBeInTheDocument();
    expect(screen.getByText("مرسلة")).toBeInTheDocument();
    expect(screen.getByText("مدفوعة")).toBeInTheDocument();
  });

  it("financial truth: subtotal/taxAmount/total render verbatim, never recomputed", async () => {
    mockApi("owner", [fixtureInvoiceDraft]);
    renderSection();
    await waitFor(() => expect(screen.getByText("INV-2001")).toBeInTheDocument());

    // Backend-returned figures, exactly.
    expect(screen.getByText(/4,321\.55/)).toBeInTheDocument();
    expect(screen.getByText(/648\.23/)).toBeInTheDocument();
    expect(screen.getByText(/5,500\.01/)).toBeInTheDocument();
    // A client-side subtotal+tax recomputation would show 4969.78 — must never appear.
    expect(screen.queryByText(/4,969\.78/)).not.toBeInTheDocument();
  });

  it("shows the contract number when linked, and — when unallocated to a contract", async () => {
    mockApi("owner", [fixtureInvoiceDraft, fixtureInvoiceSent]);
    renderSection();
    await waitFor(() => expect(screen.getByText("INV-3092")).toBeInTheDocument());
    expect(screen.getByText("C-INV-77")).toBeInTheDocument();
  });

  it("shows an honest empty state when the project has no invoices yet", async () => {
    mockApi("owner", []);
    renderSection();
    await waitFor(() => expect(screen.getByText("لا توجد فواتير لهذا المشروع بعد")).toBeInTheDocument());
  });

  it("shows an honest, retryable error state on API failure, not a fabricated empty list", async () => {
    vi.mocked(apiFetch).mockImplementation((path: unknown) => {
      const p = String(path);
      if (p === "/auth/me") return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "co1", name: "Test Co" } });
      if (p === "/projects/p1/invoices") return Promise.reject(new Error("تعذّر الاتصال بالخادم"));
      if (p === "/projects/p1/contracts") return Promise.resolve([fixtureContract]);
      return Promise.reject(new Error(`unexpected apiFetch call in test: ${p}`));
    });
    renderSection();
    await waitFor(() => expect(screen.getByText("تعذّر الاتصال بالخادم")).toBeInTheDocument());
  });

  it("project scoping: fetches the current project's invoices path, never the company-wide list", async () => {
    mockApi("owner", [fixtureInvoiceDraft]);
    renderSection();
    await waitFor(() => expect(screen.getByText("INV-2001")).toBeInTheDocument());
    // The mock rejects any call to "/invoices" (company-wide) as unexpected —
    // reaching this point without a rejection proves only the project-scoped
    // path was ever called, with the current project's own id (p1).
    expect(vi.mocked(apiFetch)).toHaveBeenCalledWith("/projects/p1/invoices");
    expect(vi.mocked(apiFetch)).not.toHaveBeenCalledWith("/invoices");
  });

  it("RBAC: a member sees the create-invoice control (creation has no owner gate on the backend)", async () => {
    mockApi("member");
    renderSection();
    await waitFor(() => expect(screen.getByText("INV-2001")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "+ فاتورة جديدة" })).toBeInTheDocument();
  });

  it("RBAC: a member does NOT see send/mark-paid controls", async () => {
    mockApi("member", [fixtureInvoiceDraft, fixtureInvoiceSent]);
    renderSection();
    await waitFor(() => expect(screen.getByText("INV-2001")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "إرسال" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "تحديد كمدفوعة" })).not.toBeInTheDocument();
  });

  it("RBAC: an owner sees send control on a draft invoice and mark-paid on a sent invoice", async () => {
    mockApi("owner", [fixtureInvoiceDraft, fixtureInvoiceSent]);
    renderSection();
    await waitFor(() => expect(screen.getByText("INV-2001")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "إرسال" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "تحديد كمدفوعة" })).toBeInTheDocument();
  });

  it("a paid invoice has no mutation controls for anyone", async () => {
    mockApi("owner", [fixtureInvoicePaid]);
    renderSection();
    await waitFor(() => expect(screen.getByText("INV-4183")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "إرسال" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "تحديد كمدفوعة" })).not.toBeInTheDocument();
  });

  it("Mutation refresh: after send, the list reflects the backend's returned state, not a locally-guessed one", async () => {
    mockApi("owner", [fixtureInvoiceDraft]);
    renderSection();
    await waitFor(() => expect(screen.getByRole("button", { name: "إرسال" })).toBeInTheDocument());

    vi.mocked(apiFetch).mockImplementation((path: unknown, reqOpts?: RequestInit) => {
      const p = String(path);
      const method = reqOpts?.method ?? "GET";
      if (p === "/auth/me") return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "co1", name: "Test Co" } });
      if (p === "/invoices/inv-draft-1/send" && method === "PATCH") return Promise.resolve({ ...fixtureInvoiceDraft, status: "sent" });
      if (p === "/projects/p1/invoices" && method === "GET") return Promise.resolve([{ ...fixtureInvoiceDraft, status: "sent" }]);
      if (p === "/projects/p1/contracts" && method === "GET") return Promise.resolve([fixtureContract]);
      return Promise.reject(new Error(`unexpected apiFetch call in test: ${p} ${method}`));
    });

    fireEvent.click(screen.getByRole("button", { name: "إرسال" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "إرسال" }));
    await waitFor(() => expect(screen.getByText("مرسلة")).toBeInTheDocument());
  });

  it("prevents duplicate mutation submission while the action is in progress", async () => {
    mockApi("owner", [fixtureInvoiceDraft]);
    renderSection();
    await waitFor(() => expect(screen.getByRole("button", { name: "إرسال" })).toBeInTheDocument());

    let resolveSend!: (value: Invoice) => void;
    const sendPromise = new Promise<Invoice>((resolve) => {
      resolveSend = resolve;
    });
    vi.mocked(apiFetch).mockImplementation((path: unknown, reqOpts?: RequestInit) => {
      const p = String(path);
      const method = reqOpts?.method ?? "GET";
      if (p === "/auth/me") return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "co1", name: "Test Co" } });
      if (p === "/invoices/inv-draft-1/send" && method === "PATCH") return sendPromise;
      if (p === "/projects/p1/invoices" && method === "GET") return Promise.resolve([{ ...fixtureInvoiceDraft, status: "sent" }]);
      if (p === "/projects/p1/contracts" && method === "GET") return Promise.resolve([fixtureContract]);
      return Promise.reject(new Error(`unexpected apiFetch call in test: ${p} ${method}`));
    });

    fireEvent.click(screen.getByRole("button", { name: "إرسال" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    const confirmButton = within(screen.getByRole("dialog")).getByRole("button", { name: "إرسال" });
    fireEvent.click(confirmButton);

    // While the mutation is still pending, the confirm button shows a busy
    // label — clicking it again must not fire a second request.
    await waitFor(() => expect(within(screen.getByRole("dialog")).getByText("جارٍ التنفيذ...")).toBeInTheDocument());
    const sendCallsBeforeSecondClick = vi.mocked(apiFetch).mock.calls.filter((c) => c[0] === "/invoices/inv-draft-1/send").length;
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "جارٍ التنفيذ..." }));
    const sendCallsAfterSecondClick = vi.mocked(apiFetch).mock.calls.filter((c) => c[0] === "/invoices/inv-draft-1/send").length;
    expect(sendCallsAfterSecondClick).toBe(sendCallsBeforeSecondClick);

    resolveSend({ ...fixtureInvoiceDraft, status: "sent" });
    await waitFor(() => expect(screen.getByText("مرسلة")).toBeInTheDocument());
  });
});
