import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { AuthProvider } from "../../auth/AuthContext";
import { I18nProvider } from "../../i18n/I18nProvider";
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
    <I18nProvider>
      <AuthProvider>
        <ActualCostSection />
      </AuthProvider>
    </I18nProvider>,
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

// E1 pre-launch hardening — createExpense() had no Idempotency-Key wiring
// at all before this: the server-side protection (Wave 1F) existed but was
// never reachable from the actual UI, so a double-click or a network retry
// of "Add Expense" still created a duplicate expense in the deployed
// product. This matches project/sections/InvoicesSection.test.tsx's own
// "create-invoice Idempotency-Key wiring" describe block, adapted for one
// real difference: ExpenseForm is permanently mounted (it clears its own
// fields on success rather than unmounting/remounting), so "a genuinely
// new expense" here means "after a successful prior submission", not
// "form closed and reopened".
describe("<ActualCostSection/> — create-expense Idempotency-Key wiring", () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockClear();
  });

  const newExpenseFixture = {
    id: "exp-new",
    projectId: "p1",
    budgetItemId: null,
    description: "مصروف جديد",
    amount: "100.00",
    expenseDate: "2026-01-10",
    createdAt: "2026-01-10T00:00:00.000Z",
  };

  function postExpenseCalls() {
    return vi
      .mocked(apiFetch)
      .mock.calls.filter((c) => c[0] === "/projects/p1/budget/expenses" && (c[1] as RequestInit | undefined)?.method === "POST");
  }

  function fillForm(container: HTMLElement) {
    fireEvent.change(screen.getByPlaceholderText("وصف المصروف"), { target: { value: "مصروف جديد" } });
    fireEvent.change(screen.getByPlaceholderText("المبلغ"), { target: { value: "100" } });
    const dateInput = container.querySelector('input[type="date"]');
    if (dateInput) fireEvent.change(dateInput, { target: { value: "2026-01-10" } });
  }

  function submit() {
    fireEvent.click(screen.getByText("+ تسجيل مصروف"));
  }

  it("sends a real Idempotency-Key header on a normal expense creation", async () => {
    vi.mocked(apiFetch).mockImplementation((path: unknown, reqOpts?: RequestInit) => {
      const p = String(path);
      const method = reqOpts?.method ?? "GET";
      if (p === "/auth/me") {
        return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "c1", name: "Test Co" } });
      }
      if (p === "/projects/p1/budget" && method === "GET") return Promise.resolve(fixtureSummary);
      if (p === "/projects/p1/budget/expenses" && method === "POST") return Promise.resolve(newExpenseFixture);
      return Promise.reject(new Error(`unexpected apiFetch call in test: ${p} ${method}`));
    });
    const { container } = renderSection();
    await waitFor(() => expect(screen.getByText("+ تسجيل مصروف")).toBeInTheDocument());

    fillForm(container);
    submit();
    await waitFor(() => expect(postExpenseCalls()).toHaveLength(1));

    const headers = (postExpenseCalls()[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBeTruthy();
    expect(headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("a retry after a failed submission (fields unchanged) reuses the identical key", async () => {
    let firstAttempt = true;
    vi.mocked(apiFetch).mockImplementation((path: unknown, reqOpts?: RequestInit) => {
      const p = String(path);
      const method = reqOpts?.method ?? "GET";
      if (p === "/auth/me") {
        return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "c1", name: "Test Co" } });
      }
      if (p === "/projects/p1/budget" && method === "GET") return Promise.resolve(fixtureSummary);
      if (p === "/projects/p1/budget/expenses" && method === "POST") {
        if (firstAttempt) {
          firstAttempt = false;
          return Promise.reject(new Error("انقطع الاتصال"));
        }
        return Promise.resolve(newExpenseFixture);
      }
      return Promise.reject(new Error(`unexpected apiFetch call in test: ${p} ${method}`));
    });
    const { container } = renderSection();
    await waitFor(() => expect(screen.getByText("+ تسجيل مصروف")).toBeInTheDocument());

    fillForm(container);
    // First attempt fails (simulating a lost response / network error) —
    // ExpenseForm never clears its fields on failure, so they stay as-is.
    submit();
    await waitFor(() => expect(postExpenseCalls()).toHaveLength(1));

    // Retry on the SAME still-populated, still-mounted form.
    submit();
    await waitFor(() => expect(postExpenseCalls()).toHaveLength(2));

    const keyAttempt1 = ((postExpenseCalls()[0][1] as RequestInit).headers as Record<string, string>)["Idempotency-Key"];
    const keyAttempt2 = ((postExpenseCalls()[1][1] as RequestInit).headers as Record<string, string>)["Idempotency-Key"];
    expect(keyAttempt1).toBe(keyAttempt2);
  });

  it("a genuinely new expense (after a successful prior submission) gets a different key from the previous one", async () => {
    vi.mocked(apiFetch).mockImplementation((path: unknown, reqOpts?: RequestInit) => {
      const p = String(path);
      const method = reqOpts?.method ?? "GET";
      if (p === "/auth/me") {
        return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "c1", name: "Test Co" } });
      }
      if (p === "/projects/p1/budget" && method === "GET") return Promise.resolve(fixtureSummary);
      if (p === "/projects/p1/budget/expenses" && method === "POST") return Promise.resolve(newExpenseFixture);
      return Promise.reject(new Error(`unexpected apiFetch call in test: ${p} ${method}`));
    });
    const { container } = renderSection();
    await waitFor(() => expect(screen.getByText("+ تسجيل مصروف")).toBeInTheDocument());

    // First expense: fill, submit successfully — the form clears its own
    // fields on success (it never unmounts).
    fillForm(container);
    submit();
    await waitFor(() => expect(postExpenseCalls()).toHaveLength(1));
    await waitFor(() => expect((screen.getByPlaceholderText("وصف المصروف") as HTMLInputElement).value).toBe(""));

    // Second, genuinely separate expense on the SAME still-mounted form.
    fillForm(container);
    submit();
    await waitFor(() => expect(postExpenseCalls()).toHaveLength(2));

    const keyFirstExpense = ((postExpenseCalls()[0][1] as RequestInit).headers as Record<string, string>)["Idempotency-Key"];
    const keySecondExpense = ((postExpenseCalls()[1][1] as RequestInit).headers as Record<string, string>)["Idempotency-Key"];
    expect(keyFirstExpense).not.toBe(keySecondExpense);
  });
});
