import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, within, fireEvent } from "@testing-library/react";
import { AuthProvider } from "../../auth/AuthContext";
import { I18nProvider } from "../../i18n/I18nProvider";
import { BoqSection } from "./BoqSection";
import type { BoqRevisionWithItems, Contract } from "../../api/types";

vi.mock("../context", () => ({
  useProjectContext: () => ({ project: null, projectId: "p1" }),
}));

vi.mock("../../api/client", async () => {
  const actual = await vi.importActual<typeof import("../../api/client")>("../../api/client");
  return { ...actual, getToken: () => "fake-token", apiFetch: vi.fn() };
});

import { apiFetch } from "../../api/client";

const fixtureContract: Contract = {
  id: "contract-1",
  companyId: "c1",
  projectId: "p1",
  contractType: "main",
  parentContractId: null,
  contractNumber: "C-1001",
  clientName: "Acme Construction",
  originalValue: "500000.00",
  revisedValue: "500000.00",
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

const draftRevision: BoqRevisionWithItems = {
  id: "rev-draft",
  companyId: "c1",
  projectId: "p1",
  contractId: "contract-1",
  revisionNumber: 1,
  status: "draft",
  supersedesRevisionId: null,
  notes: null,
  createdBy: "u1",
  createdAt: "2026-01-01T00:00:00.000Z",
  publishedAt: null,
  items: [
    {
      id: "item-1",
      boqRevisionId: "rev-draft",
      parentItemId: null,
      itemType: "item",
      code: "A-01",
      description: "Excavation",
      unit: "m3",
      quantity: "100.000",
      rate: "50.00",
      amount: "5000.00",
      costCodeId: null,
      sortOrder: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ],
};

const publishedRevision: BoqRevisionWithItems = {
  ...draftRevision,
  id: "rev-pub",
  revisionNumber: 2,
  status: "published",
  publishedAt: "2026-01-05T00:00:00.000Z",
  items: [{ ...draftRevision.items[0], id: "item-2", boqRevisionId: "rev-pub" }],
};

function mockApi(role: "owner" | "member", revisions: BoqRevisionWithItems[]) {
  vi.mocked(apiFetch).mockImplementation((path: unknown, opts?: RequestInit) => {
    const p = String(path);
    if (p === "/auth/me") {
      return Promise.resolve({
        user: { id: "u1", name: "Test", email: "t@test.com", role },
        company: { id: "c1", name: "Test Co" },
      });
    }
    if (p === "/projects/p1/contracts" && (!opts || !opts.method)) {
      return Promise.resolve([fixtureContract]);
    }
    if (p === "/projects/p1/boq-revisions" && (!opts || !opts.method)) {
      return Promise.resolve(revisions.map(({ items: _items, ...rest }) => rest));
    }
    const detail = revisions.find((r) => p === `/projects/p1/boq-revisions/${r.id}`);
    if (detail && (!opts || !opts.method)) {
      return Promise.resolve(detail);
    }
    return Promise.reject(new Error(`unexpected apiFetch call in test: ${p} ${opts?.method ?? "GET"}`));
  });
}

describe("<BoqSection/>", () => {
  it("renders BOQ revisions from the backend", async () => {
    mockApi("owner", [draftRevision]);
    render(
      <I18nProvider>
        <AuthProvider>
          <BoqSection />
        </AuthProvider>
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByText("#1")).toBeInTheDocument());
    expect(screen.getByText("مسودة")).toBeInTheDocument();
  });

  it("renders items of a selected revision, showing the backend-provided amount", async () => {
    mockApi("owner", [draftRevision]);
    render(
      <I18nProvider>
        <AuthProvider>
          <BoqSection />
        </AuthProvider>
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByText("#1")).toBeInTheDocument());
    fireEvent.click(screen.getByText("عرض البنود"));
    await waitFor(() => expect(screen.getByText("Excavation")).toBeInTheDocument());
    expect(screen.getByText("A-01")).toBeInTheDocument();
    // Amount must be the raw backend value (5,000.00), never quantity*rate recomputed in React.
    expect(screen.getByText(/5,000\.00/)).toBeInTheDocument();
  });

  it("an owner sees draft mutation controls on a draft revision", async () => {
    mockApi("owner", [draftRevision]);
    render(
      <I18nProvider>
        <AuthProvider>
          <BoqSection />
        </AuthProvider>
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByText("#1")).toBeInTheDocument());
    fireEvent.click(screen.getByText("عرض البنود"));
    await waitFor(() => expect(screen.getByText("Excavation")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "+ بند" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "نشر النسخة" })).toBeInTheDocument();
    expect(screen.getByText("حذف")).toBeInTheDocument();
  });

  it("a member does not see owner-only draft mutation controls", async () => {
    mockApi("member", [draftRevision]);
    render(
      <I18nProvider>
        <AuthProvider>
          <BoqSection />
        </AuthProvider>
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByText("#1")).toBeInTheDocument());
    fireEvent.click(screen.getByText("عرض البنود"));
    await waitFor(() => expect(screen.getByText("Excavation")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "+ بند" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "نشر النسخة" })).not.toBeInTheDocument();
    expect(screen.queryByText("حذف")).not.toBeInTheDocument();
    // And the revision-list-level "new revision" control is also hidden for members.
    expect(screen.queryByText("+ نسخة جديدة")).not.toBeInTheDocument();
  });

  it("a published revision does not expose draft mutation controls, even to an owner", async () => {
    mockApi("owner", [publishedRevision]);
    render(
      <I18nProvider>
        <AuthProvider>
          <BoqSection />
        </AuthProvider>
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByText("#2")).toBeInTheDocument());
    fireEvent.click(screen.getByText("عرض البنود"));
    await waitFor(() => expect(screen.getByText("Excavation")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "+ بند" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "نشر النسخة" })).not.toBeInTheDocument();
    expect(screen.queryByText("حذف")).not.toBeInTheDocument();
  });

  it("publishing a draft revision requires confirmation before calling the API", async () => {
    mockApi("owner", [draftRevision]);
    render(
      <I18nProvider>
        <AuthProvider>
          <BoqSection />
        </AuthProvider>
      </I18nProvider>,
    );
    await waitFor(() => expect(screen.getByText("#1")).toBeInTheDocument());
    fireEvent.click(screen.getByText("عرض البنود"));
    await waitFor(() => expect(screen.getByRole("button", { name: "نشر النسخة" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "نشر النسخة" }));

    const dialog = await screen.findByText("نشر نسخة جدول الكميات");
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText(/بعد النشر لا يمكن تعديل أو حذف بنود هذه النسخة/)).toBeInTheDocument();

    // No publish call has been made yet — only opening the confirmation
    // dialog, never publishing eagerly on click.
    expect(apiFetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/publish"),
      expect.anything(),
    );

    const confirmButton = within(dialog.closest("[role='dialog']") ?? document.body).queryAllByText("نشر")[0];
    expect(confirmButton).toBeTruthy();
  });
});
