import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AuthProvider } from "../../auth/AuthContext";
import { ActualCostSection } from "./ActualCostSection";
import type { BudgetSummary } from "../../api/types";

vi.mock("../context", () => ({
  useProjectContext: () => ({ project: null, projectId: "p1" }),
}));

vi.mock("../../api/client", async () => {
  const actual = await vi.importActual<typeof import("../../api/client")>("../../api/client");
  return { ...actual, getToken: () => "fake-token", apiFetch: vi.fn() };
});

import { apiFetch } from "../../api/client";

// totals.spent (777.00) is deliberately NOT the sum of the expenses below
// (500.00) — set to a different value on purpose, so asserting the UI
// shows 777.00 proves the displayed total comes from the backend's own
// totals.spent, never a client-side re-sum of the expenses array.
const fixtureSummary: BudgetSummary = {
  items: [
    { id: "item-1", projectId: "p1", category: "مواد بناء", plannedAmount: "2000.00", spent: 500, createdAt: "2026-01-01T00:00:00.000Z", costCodeId: null, boqItemId: null, budgetRevisionId: null },
  ],
  expenses: [
    { id: "exp-1", projectId: "p1", budgetItemId: "item-1", description: "شراء إسمنت", amount: "500.00", expenseDate: "2026-01-05", createdAt: "2026-01-05T00:00:00.000Z" },
  ],
  totals: { planned: 2000, spent: 777, remaining: 1223 },
};

function mockApi(role: "owner" | "member", summary: BudgetSummary) {
  vi.mocked(apiFetch).mockImplementation((path: unknown, opts?: RequestInit) => {
    const p = String(path);
    if (p === "/auth/me") {
      return Promise.resolve({
        user: { id: "u1", name: "Test", email: "t@test.com", role },
        company: { id: "c1", name: "Test Co" },
      });
    }
    if (p === "/projects/p1/budget" && (!opts || !opts.method)) {
      return Promise.resolve(summary);
    }
    return Promise.reject(new Error(`unexpected apiFetch call in test: ${p} ${opts?.method ?? "GET"}`));
  });
}

function renderSection() {
  return render(
    <AuthProvider>
      <ActualCostSection />
    </AuthProvider>,
  );
}

describe("<ActualCostSection/>", () => {
  it("renders the expense list from backend data", async () => {
    mockApi("owner", fixtureSummary);
    renderSection();
    await waitFor(() => expect(screen.getByText("شراء إسمنت")).toBeInTheDocument());
    // "مواد بناء" appears both as the budget-item link column and as an
    // <option> in the (also ungated) expense form's picker — assert at
    // least one occurrence rather than assuming a single match.
    expect(screen.getAllByText("مواد بناء").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/500\.00/).length).toBeGreaterThan(0);
  });

  it("shows the backend's totals.spent, never a client-side re-sum of expenses", async () => {
    mockApi("owner", fixtureSummary);
    renderSection();
    await waitFor(() => expect(screen.getByText("شراء إسمنت")).toBeInTheDocument());
    // Backend total (777.00), not a locally recomputed sum of expenses (500.00).
    expect(screen.getByText(/777\.00/)).toBeInTheDocument();
  });

  it("shows an honest empty state when there are no expenses yet", async () => {
    mockApi("owner", { items: [], expenses: [], totals: { planned: 0, spent: 0, remaining: 0 } });
    renderSection();
    await waitFor(() => expect(screen.getByText("لا توجد مصروفات فعلية بعد")).toBeInTheDocument());
  });

  it("an owner sees the create-expense form", async () => {
    mockApi("owner", fixtureSummary);
    renderSection();
    await waitFor(() => expect(screen.getByText("شراء إسمنت")).toBeInTheDocument());
    expect(screen.getByPlaceholderText("وصف المصروف")).toBeInTheDocument();
    expect(screen.getByText("+ تسجيل مصروف")).toBeInTheDocument();
  });

  // Final Pre-Launch Audit — POST/DELETE /budget/expenses are now
  // owner-gated server-side (budget.manage), so a member must no longer
  // see the controls the backend would now reject.
  it("a member does NOT see the create-expense form, matching the new backend RBAC gate", async () => {
    mockApi("member", fixtureSummary);
    renderSection();
    await waitFor(() => expect(screen.getByText("شراء إسمنت")).toBeInTheDocument());
    expect(screen.queryByPlaceholderText("وصف المصروف")).not.toBeInTheDocument();
    expect(screen.queryByText("+ تسجيل مصروف")).not.toBeInTheDocument();
  });

  it("a member does NOT see the delete control on an expense row", async () => {
    mockApi("member", fixtureSummary);
    renderSection();
    await waitFor(() => expect(screen.getByText("شراء إسمنت")).toBeInTheDocument());
    expect(screen.queryByText("حذف")).not.toBeInTheDocument();
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
      if (p === "/projects/p1/budget") {
        return Promise.reject(new Error("تعذّر الاتصال بالخادم"));
      }
      return Promise.reject(new Error(`unexpected apiFetch call in test: ${p}`));
    });
    renderSection();
    await waitFor(() => expect(screen.getByText("تعذّر الاتصال بالخادم")).toBeInTheDocument());
  });
});
