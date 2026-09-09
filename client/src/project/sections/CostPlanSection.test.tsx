import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { AuthProvider } from "../../auth/AuthContext";
import { CostPlanSection } from "./CostPlanSection";
import type { BudgetItem, BudgetRevision, BudgetSummary } from "../../api/types";

vi.mock("../context", () => ({
  useProjectContext: () => ({ project: null, projectId: "p1" }),
}));

vi.mock("../../api/client", async () => {
  const actual = await vi.importActual<typeof import("../../api/client")>("../../api/client");
  return { ...actual, getToken: () => "fake-token", apiFetch: vi.fn() };
});

import { apiFetch } from "../../api/client";

const fixtureItem: BudgetItem = {
  id: "item-1",
  projectId: "p1",
  category: "مواد البناء",
  plannedAmount: "1000.00",
  spent: 400,
  createdAt: "2026-01-01T00:00:00.000Z",
  costCodeId: null,
  boqItemId: null,
  budgetRevisionId: null,
};

// remaining is deliberately NOT planned - spent (1000 - 400 = 600) — it is
// set to a different value on purpose, so a passing "renders the backend's
// remaining" assertion proves the UI displays the backend figure rather
// than silently recomputing "planned - spent" itself.
const fixtureSummary: BudgetSummary = {
  items: [fixtureItem],
  expenses: [],
  totals: { planned: 1000, spent: 400, remaining: 550 },
};

const draftBudgetRevision: BudgetRevision = {
  id: "rev-1",
  companyId: "c1",
  projectId: "p1",
  revisionNumber: 1,
  status: "draft",
  reason: "مراجعة تجريبية",
  createdBy: "u1",
  createdAt: "2026-01-01T00:00:00.000Z",
  approvedBy: null,
  approvedAt: null,
};

function mockApi(role: "owner" | "member") {
  vi.mocked(apiFetch).mockImplementation((path: unknown, opts?: RequestInit) => {
    const p = String(path);
    if (p === "/auth/me") {
      return Promise.resolve({
        user: { id: "u1", name: "Test", email: "t@test.com", role },
        company: { id: "c1", name: "Test Co" },
      });
    }
    if (p === "/projects/p1/budget" && (!opts || !opts.method)) {
      return Promise.resolve(fixtureSummary);
    }
    if (p === "/cost-codes?projectId=p1") {
      return Promise.resolve([]);
    }
    if (p === "/projects/p1/budget-revisions" && (!opts || !opts.method)) {
      return Promise.resolve([draftBudgetRevision]);
    }
    return Promise.reject(new Error(`unexpected apiFetch call in test: ${p} ${opts?.method ?? "GET"}`));
  });
}

describe("<CostPlanSection/>", () => {
  it("renders the backend's authoritative planned/spent/remaining totals, never a client recomputation", async () => {
    mockApi("owner");
    render(
      <AuthProvider>
        <CostPlanSection />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText("مواد البناء")).toBeInTheDocument());
    expect(screen.getAllByText(/1,000\.00/).length).toBeGreaterThan(0); // planned
    expect(screen.getAllByText(/400\.00/).length).toBeGreaterThan(0); // spent
    // The backend's remaining (550), not a locally recomputed 600.
    expect(screen.getByText(/550\.00/)).toBeInTheDocument();
    expect(screen.queryByText(/600\.00/)).not.toBeInTheDocument();
  });

  // Final Pre-Launch Audit — POST/PATCH/DELETE /budget/items are now
  // owner-gated server-side (budget.manage), so a member must no longer
  // see the controls the backend would now reject.
  it("budget item CRUD controls are hidden from a member, matching the new backend RBAC gate", async () => {
    mockApi("member");
    render(
      <AuthProvider>
        <CostPlanSection />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText("مواد البناء")).toBeInTheDocument());
    expect(screen.queryByText("+ إضافة بند")).not.toBeInTheDocument();
    expect(screen.queryByText("تعديل")).not.toBeInTheDocument();
    expect(screen.queryByText("حذف")).not.toBeInTheDocument();
  });

  it("budget item CRUD controls are shown to an owner", async () => {
    mockApi("owner");
    render(
      <AuthProvider>
        <CostPlanSection />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText("مواد البناء")).toBeInTheDocument());
    expect(screen.getByText("+ إضافة بند")).toBeInTheDocument();
    expect(screen.getByText("تعديل")).toBeInTheDocument();
    expect(screen.getByText("حذف")).toBeInTheDocument();
  });

  it("renders the revisions tab from backend data", async () => {
    mockApi("owner");
    render(
      <AuthProvider>
        <CostPlanSection />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText("مواد البناء")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("tab", { name: "المراجعات" }));
    await waitFor(() => expect(screen.getByText("#1")).toBeInTheDocument());
    expect(screen.getByText("مسودة")).toBeInTheDocument();
  });

  it("hides owner-only revision actions (create/approve) from a member", async () => {
    mockApi("member");
    render(
      <AuthProvider>
        <CostPlanSection />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText("مواد البناء")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("tab", { name: "المراجعات" }));
    await waitFor(() => expect(screen.getByText("#1")).toBeInTheDocument());
    expect(screen.queryByText("+ مراجعة جديدة")).not.toBeInTheDocument();
  });

  it("shows owner-only revision actions (create) to an owner", async () => {
    mockApi("owner");
    render(
      <AuthProvider>
        <CostPlanSection />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText("مواد البناء")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("tab", { name: "المراجعات" }));
    await waitFor(() => expect(screen.getByText("#1")).toBeInTheDocument());
    expect(screen.getByText("+ مراجعة جديدة")).toBeInTheDocument();
  });
});
