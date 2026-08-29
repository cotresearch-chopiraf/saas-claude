import { useEffect, useState, type FormEvent } from "react";
import { PageHeader } from "../../ui/PageHeader";
import { Card } from "../../ui/Card";
import { Button } from "../../ui/Button";
import { MetricCard } from "../../ui/MetricCard";
import { FinancialTable, type FinancialColumn } from "../../ui/FinancialTable";
import { ErrorState } from "../../ui/ErrorState";
import { Skeleton } from "../../ui/Skeleton";
import { formatMoney, formatDate } from "../../lib/format";
import { getBudget, createExpense, deleteExpense } from "../../api/costPlan";
import { ApiError } from "../../api/client";
import type { BudgetItem, BudgetSummary, Expense } from "../../api/types";
import { useProjectContext } from "../context";

// Actual Cost (UI-03B) — the frontend for the existing expenses
// create/delete routes (server/src/routes/budget.ts), reusing the same
// GET /budget already consumed by UI-01's Cost Plan for `expenses` and
// `totals.spent`. No new backend, no new calculation: `totals.spent` is
// displayed exactly as the backend computes it, never re-summed here.
export function ActualCostSection() {
  const { projectId } = useProjectContext();
  const [summary, setSummary] = useState<BudgetSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setError(null);
    setSummary(null);
    getBudget(projectId)
      .then(setSummary)
      .catch((err) => setError(err instanceof Error ? err.message : "تعذّر تحميل التكلفة الفعلية"));
  }
  useEffect(load, [projectId]);

  if (error && !summary) {
    return (
      <div className="space-y-6">
        <PageHeader title="التكلفة الفعلية" />
        <ErrorState message={error} onRetry={load} />
      </div>
    );
  }
  if (!summary) {
    return (
      <div className="space-y-6">
        <PageHeader title="التكلفة الفعلية" />
        <Skeleton rows={6} />
      </div>
    );
  }

  const budgetItemLabel = (id: string | null) => {
    if (!id) return "—";
    const item = summary.items.find((i) => i.id === id);
    return item ? item.category : "—";
  };

  const columns: FinancialColumn<Expense>[] = [
    { key: "description", header: "الوصف", render: (e) => e.description },
    { key: "budgetItem", header: "بند الميزانية", render: (e) => budgetItemLabel(e.budgetItemId) },
    { key: "amount", header: "المبلغ", align: "end", render: (e) => formatMoney(e.amount) },
    { key: "expenseDate", header: "التاريخ", render: (e) => formatDate(e.expenseDate) },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title="التكلفة الفعلية" />

      <div className="grid gap-4 sm:grid-cols-3">
        <MetricCard label="إجمالي المُنفَق فعلياً" value={formatMoney(summary.totals.spent)} />
      </div>

      {/* Deliberately ungated (no <Can/>): POST/DELETE /budget/expenses carry
          no requirePermission gate server-side — mirrors the identical
          posture already established for Cost Plan's budget-item CRUD in
          UI-01. A member must see exactly the same controls an owner does. */}
      <ExpenseForm projectId={projectId} budgetItems={summary.items} onSaved={load} />

      <FinancialTable
        columns={columns}
        rows={summary.expenses}
        rowKey={(e) => e.id}
        emptyMessage="لا توجد مصروفات فعلية بعد"
        rowActions={(e) => <ExpenseRowActions projectId={projectId} expense={e} onChanged={load} />}
      />
    </div>
  );
}

function ExpenseForm({
  projectId,
  budgetItems,
  onSaved,
}: {
  projectId: string;
  budgetItems: BudgetItem[];
  onSaved: () => void;
}) {
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [expenseDate, setExpenseDate] = useState("");
  const [budgetItemId, setBudgetItemId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await createExpense(projectId, {
        description,
        amount: Number(amount),
        expenseDate,
        budgetItemId: budgetItemId || undefined,
      });
      setDescription("");
      setAmount("");
      setExpenseDate("");
      setBudgetItemId("");
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر تسجيل المصروف");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="p-4">
      <form onSubmit={onSubmit} className="flex flex-wrap gap-2">
        {error && (
          <div className="w-full">
            <ErrorState message={error} />
          </div>
        )}
        <input
          required
          placeholder="وصف المصروف"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="flex-1 rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <input
          required
          type="number"
          min="0"
          step="0.01"
          placeholder="المبلغ"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="w-32 rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <input
          required
          type="date"
          value={expenseDate}
          onChange={(e) => setExpenseDate(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <select
          value={budgetItemId}
          onChange={(e) => setBudgetItemId(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        >
          <option value="">بدون بند محدد</option>
          {budgetItems.map((i) => (
            <option key={i.id} value={i.id}>
              {i.category}
            </option>
          ))}
        </select>
        <Button type="submit" size="sm" disabled={submitting}>
          {submitting ? "جارٍ الحفظ..." : "+ تسجيل مصروف"}
        </Button>
      </form>
    </Card>
  );
}

function ExpenseRowActions({
  projectId,
  expense,
  onChanged,
}: {
  projectId: string;
  expense: Expense;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onDelete() {
    setBusy(true);
    setError(null);
    try {
      await deleteExpense(projectId, expense.id);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر حذف المصروف");
      setBusy(false);
    }
  }

  return (
    <div className="flex justify-end gap-2">
      {error && <span className="text-xs text-danger-600">{error}</span>}
      <button type="button" onClick={onDelete} disabled={busy} className="text-sm text-danger-600 hover:underline">
        حذف
      </button>
    </div>
  );
}
