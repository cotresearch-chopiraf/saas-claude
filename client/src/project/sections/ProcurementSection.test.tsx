import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { AuthProvider } from "../../auth/AuthContext";
import { ProcurementSection } from "./ProcurementSection";
import type { Commitment, CommitmentWithLines, Supplier } from "../../api/types";

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
  companyId: "c1",
  name: "شركة الرشيد للمواد",
  type: "supplier",
  taxId: null,
  email: null,
  phone: null,
  address: null,
  status: "active",
  createdBy: "u1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function makeCommitment(overrides: Partial<Commitment>): Commitment {
  return {
    id: "c-1",
    companyId: "c1",
    projectId: "p1",
    contractId: null,
    supplierId: "supplier-1",
    type: "purchase_order",
    status: "draft",
    commitmentNumber: 1,
    description: "توريد حديد التسليح",
    originalAmount: null,
    revisedAmount: null,
    retentionPercent: null,
    currency: "SAR",
    createdBy: "u1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    submittedAt: null,
    approvedBy: null,
    approvedAt: null,
    cancelledAt: null,
    ...overrides,
  };
}

// The line's amount is deliberately NOT quantity(10) * rate(5) = 50 — it is
// set to a different backend value (999.00) on purpose, so asserting the
// UI shows 999.00 (not 50.00) proves the amount is displayed from the API
// response, never recomputed client-side.
function withLines(commitment: Commitment): CommitmentWithLines {
  return {
    ...commitment,
    lines: [
      {
        id: "line-1",
        companyId: "c1",
        commitmentId: commitment.id,
        costCodeId: null,
        boqItemId: null,
        description: "حديد تسليح 12مم",
        quantity: "10.000",
        rate: "5.00",
        amount: "999.00",
        sortOrder: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
}

function mockApi(role: "owner" | "member", commitments: Commitment[]) {
  vi.mocked(apiFetch).mockImplementation((path: unknown, opts?: RequestInit) => {
    const p = String(path);
    if (p === "/auth/me") {
      return Promise.resolve({
        user: { id: "u1", name: "Test", email: "t@test.com", role },
        company: { id: "c1", name: "Test Co" },
      });
    }
    if (p === "/projects/p1/commitments" && (!opts || !opts.method)) {
      return Promise.resolve(commitments);
    }
    if (p === "/suppliers") {
      return Promise.resolve([fixtureSupplier]);
    }
    if (p === "/projects/p1/contracts") {
      return Promise.resolve([]);
    }
    if (p === "/cost-codes?projectId=p1") {
      return Promise.resolve([]);
    }
    if (p === "/projects/p1/boq-revisions") {
      return Promise.resolve([]);
    }
    const detail = commitments.find((c) => p === `/projects/p1/commitments/${c.id}`);
    if (detail && (!opts || !opts.method)) {
      return Promise.resolve(withLines(detail));
    }
    return Promise.reject(new Error(`unexpected apiFetch call in test: ${p} ${opts?.method ?? "GET"}`));
  });
}

function renderSection() {
  return render(
    <AuthProvider>
      <ProcurementSection />
    </AuthProvider>,
  );
}

describe("<ProcurementSection/>", () => {
  it("renders the commitment list from backend data", async () => {
    mockApi("owner", [makeCommitment({ commitmentNumber: 7 })]);
    renderSection();
    await waitFor(() => expect(screen.getByText("#7")).toBeInTheDocument());
    expect(screen.getByText("شركة الرشيد للمواد")).toBeInTheDocument();
    expect(screen.getByText("توريد حديد التسليح")).toBeInTheDocument();
  });

  it("shows an honest empty state when there are no commitments yet", async () => {
    mockApi("owner", []);
    renderSection();
    await waitFor(() => expect(screen.getByText("لا توجد التزامات (مشتريات) بعد")).toBeInTheDocument());
  });

  it("an owner sees the create-commitment control", async () => {
    mockApi("owner", []);
    renderSection();
    await waitFor(() => expect(screen.getByText("+ التزام جديد")).toBeInTheDocument());
  });

  it("a member does not see the create-commitment control", async () => {
    mockApi("member", []);
    renderSection();
    await waitFor(() => expect(screen.getByText("لا توجد التزامات (مشتريات) بعد")).toBeInTheDocument());
    expect(screen.queryByText("+ التزام جديد")).not.toBeInTheDocument();
  });

  it("renders commitment detail with backend-provided fields", async () => {
    mockApi("owner", [makeCommitment({ id: "c-detail", commitmentNumber: 3 })]);
    renderSection();
    await waitFor(() => expect(screen.getByText("#3")).toBeInTheDocument());
    fireEvent.click(screen.getByText("عرض"));
    await waitFor(() => expect(screen.getByText("التزام #3")).toBeInTheDocument());
    expect(screen.getByText("حديد تسليح 12مم")).toBeInTheDocument();
  });

  it("financial values (line amount) are rendered from the API response, never recomputed from quantity*rate", async () => {
    mockApi("owner", [makeCommitment({ id: "c-money", commitmentNumber: 4 })]);
    renderSection();
    await waitFor(() => expect(screen.getByText("#4")).toBeInTheDocument());
    fireEvent.click(screen.getByText("عرض"));
    await waitFor(() => expect(screen.getByText("حديد تسليح 12مم")).toBeInTheDocument());
    // Backend amount (999.00), not a locally recomputed 10*5=50.00.
    expect(screen.getByText(/999\.00/)).toBeInTheDocument();
    expect(screen.queryByText(/^50\.00/)).not.toBeInTheDocument();
  });

  it("a draft commitment's owner sees line mutation controls (add/submit/cancel)", async () => {
    mockApi("owner", [makeCommitment({ id: "c-draft", commitmentNumber: 5, status: "draft" })]);
    renderSection();
    await waitFor(() => expect(screen.getByText("#5")).toBeInTheDocument());
    fireEvent.click(screen.getByText("عرض"));
    await waitFor(() => expect(screen.getByText("التزام #5")).toBeInTheDocument());
    expect(screen.getByText("+ بند")).toBeInTheDocument();
    expect(screen.getByText("إرسال للاعتماد")).toBeInTheDocument();
    expect(screen.getByText("إلغاء الالتزام")).toBeInTheDocument();
    expect(screen.getByText("حذف")).toBeInTheDocument();
  });

  it("a member does not see any mutation controls on a draft commitment", async () => {
    mockApi("member", [makeCommitment({ id: "c-draft-m", commitmentNumber: 6, status: "draft" })]);
    renderSection();
    await waitFor(() => expect(screen.getByText("#6")).toBeInTheDocument());
    fireEvent.click(screen.getByText("عرض"));
    await waitFor(() => expect(screen.getByText("التزام #6")).toBeInTheDocument());
    expect(screen.queryByText("+ بند")).not.toBeInTheDocument();
    expect(screen.queryByText("إرسال للاعتماد")).not.toBeInTheDocument();
    expect(screen.queryByText("إلغاء الالتزام")).not.toBeInTheDocument();
    expect(screen.queryByText("حذف")).not.toBeInTheDocument();
  });

  it("a pending_approval (non-draft) commitment hides draft-editing controls, even for the owner", async () => {
    mockApi("owner", [makeCommitment({ id: "c-pending", commitmentNumber: 8, status: "pending_approval" })]);
    renderSection();
    await waitFor(() => expect(screen.getByText("#8")).toBeInTheDocument());
    fireEvent.click(screen.getByText("عرض"));
    await waitFor(() => expect(screen.getByText("التزام #8")).toBeInTheDocument());
    expect(screen.queryByText("+ بند")).not.toBeInTheDocument();
    expect(screen.queryByText("إرسال للاعتماد")).not.toBeInTheDocument();
    expect(screen.getByText("اعتماد")).toBeInTheDocument();
    expect(screen.getByText("إلغاء الالتزام")).toBeInTheDocument();
    expect(screen.queryByText("حذف")).not.toBeInTheDocument();
  });

  it("an active commitment exposes the amendment control to the owner", async () => {
    mockApi("owner", [makeCommitment({ id: "c-active", commitmentNumber: 9, status: "active", originalAmount: "1000.00", revisedAmount: "1000.00" })]);
    renderSection();
    await waitFor(() => expect(screen.getByText("#9")).toBeInTheDocument());
    fireEvent.click(screen.getByText("عرض"));
    await waitFor(() => expect(screen.getByText("التزام #9")).toBeInTheDocument());
    expect(screen.getByText("+ تعديل (أمر تغيير)")).toBeInTheDocument();
    expect(screen.queryByText("+ بند")).not.toBeInTheDocument();
    expect(screen.queryByText("إلغاء الالتزام")).not.toBeInTheDocument();
  });

  it("a partially_fulfilled commitment also exposes the amendment control", async () => {
    mockApi("owner", [makeCommitment({ id: "c-partial", commitmentNumber: 10, status: "partially_fulfilled" })]);
    renderSection();
    await waitFor(() => expect(screen.getByText("#10")).toBeInTheDocument());
    fireEvent.click(screen.getByText("عرض"));
    await waitFor(() => expect(screen.getByText("التزام #10")).toBeInTheDocument());
    expect(screen.getByText("+ تعديل (أمر تغيير)")).toBeInTheDocument();
  });

  it("closed and cancelled commitments expose no mutation controls at all", async () => {
    mockApi("owner", [
      makeCommitment({ id: "c-closed", commitmentNumber: 11, status: "closed" }),
      makeCommitment({ id: "c-cancelled", commitmentNumber: 12, status: "cancelled" }),
    ]);
    renderSection();
    await waitFor(() => expect(screen.getByText("#11")).toBeInTheDocument());

    fireEvent.click(screen.getAllByText("عرض")[0]);
    await waitFor(() => expect(screen.getByText("التزام #11")).toBeInTheDocument());
    expect(screen.queryByText("+ بند")).not.toBeInTheDocument();
    expect(screen.queryByText("إرسال للاعتماد")).not.toBeInTheDocument();
    expect(screen.queryByText("اعتماد")).not.toBeInTheDocument();
    expect(screen.queryByText("إلغاء الالتزام")).not.toBeInTheDocument();
    expect(screen.queryByText("+ تعديل (أمر تغيير)")).not.toBeInTheDocument();

    fireEvent.click(screen.getAllByText("عرض")[1]);
    await waitFor(() => expect(screen.getByText("التزام #12")).toBeInTheDocument());
    expect(screen.queryByText("+ بند")).not.toBeInTheDocument();
    expect(screen.queryByText("إرسال للاعتماد")).not.toBeInTheDocument();
    expect(screen.queryByText("اعتماد")).not.toBeInTheDocument();
    expect(screen.queryByText("إلغاء الالتزام")).not.toBeInTheDocument();
    expect(screen.queryByText("+ تعديل (أمر تغيير)")).not.toBeInTheDocument();
  });

  it("submitting a draft commitment requires confirmation before calling the API", async () => {
    mockApi("owner", [makeCommitment({ id: "c-confirm", commitmentNumber: 13, status: "draft" })]);
    renderSection();
    await waitFor(() => expect(screen.getByText("#13")).toBeInTheDocument());
    fireEvent.click(screen.getByText("عرض"));
    await waitFor(() => expect(screen.getByText("إرسال للاعتماد")).toBeInTheDocument());

    fireEvent.click(screen.getByText("إرسال للاعتماد"));

    const dialogTitle = await screen.findByText("إرسال الالتزام للاعتماد");
    expect(dialogTitle).toBeInTheDocument();
    expect(screen.getByText(/بعد الإرسال لن يمكن إضافة أو حذف بنود/)).toBeInTheDocument();

    // No submit call has actually been made yet — only the confirmation
    // dialog opened, never an eager call on click.
    expect(apiFetch).not.toHaveBeenCalledWith(expect.stringContaining("/submit"), expect.anything());
  });
});
