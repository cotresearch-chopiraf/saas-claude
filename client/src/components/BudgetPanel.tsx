import { FormEvent, useEffect, useState } from "react";
import { apiFetch, getToken, ApiError } from "../api/client";
import { Can } from "../auth/Can";
import { formatMoney } from "../lib/format";
import type { BudgetSummary } from "../api/types";

// A plain <a href> can't carry the Bearer token, so the CSV export fetches
// as a blob and triggers the browser's own save dialog — this is also the
// direct answer to the market leader's #1 complaint: your data is never
// locked in here.
async function downloadBudgetCsv(projectId: string) {
  const res = await fetch(`/api/projects/${projectId}/budget/export.csv`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `budget-${projectId}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

const money = (n: number) => formatMoney(n);

export function BudgetPanel({ projectId }: { projectId: string }) {
  const [summary, setSummary] = useState<BudgetSummary | null>(null);
  const [category, setCategory] = useState("");
  const [plannedAmount, setPlannedAmount] = useState("");
  const [expenseDescription, setExpenseDescription] = useState("");
  const [expenseAmount, setExpenseAmount] = useState("");
  const [expenseItemId, setExpenseItemId] = useState("");
  const [error, setError] = useState<string | null>(null);

  function load() {
    apiFetch<BudgetSummary>(`/projects/${projectId}/budget`).then(setSummary);
  }

  useEffect(load, [projectId]);

  if (!summary) return <p className="text-stone-500">جارٍ التحميل...</p>;

  const { totals } = summary;
  const overBudget = totals.remaining < 0;

  async function addItem(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch(`/projects/${projectId}/budget/items`, {
        method: "POST",
        body: JSON.stringify({ category, plannedAmount }),
      });
      setCategory("");
      setPlannedAmount("");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّرت إضافة البند");
    }
  }

  async function addExpense(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch(`/projects/${projectId}/budget/expenses`, {
        method: "POST",
        body: JSON.stringify({
          description: expenseDescription,
          amount: expenseAmount,
          expenseDate: new Date().toISOString().slice(0, 10),
          budgetItemId: expenseItemId || undefined,
        }),
      });
      setExpenseDescription("");
      setExpenseAmount("");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر تسجيل المصروف");
    }
  }

  return (
    <div className="space-y-6">
      {error && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="المخطَّط" value={money(totals.planned)} />
        <StatCard label="المُنفَق" value={money(totals.spent)} />
        <StatCard
          label={overBudget ? "تجاوز الميزانية" : "المتبقي"}
          value={money(Math.abs(totals.remaining))}
          tone={overBudget ? "danger" : "default"}
        />
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="font-semibold text-stone-700">بنود الميزانية</h3>
          <button
            onClick={() => downloadBudgetCsv(projectId)}
            className="text-sm text-primary underline decoration-dotted"
          >
            تصدير CSV
          </button>
        </div>
        <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-stone-50 text-stone-500">
              <tr>
                <th className="p-3 text-right">البند</th>
                <th className="p-3 text-right">مخطَّط</th>
                <th className="p-3 text-right">مُنفَق</th>
              </tr>
            </thead>
            <tbody>
              {summary.items.map((item) => (
                <tr key={item.id} className="border-t border-stone-100">
                  <td className="p-3">{item.category}</td>
                  <td className="p-3">{money(Number(item.plannedAmount))}</td>
                  <td className={`p-3 ${item.spent > Number(item.plannedAmount) ? "text-red-600" : ""}`}>
                    {money(item.spent)}
                  </td>
                </tr>
              ))}
              {summary.items.length === 0 && (
                <tr>
                  <td colSpan={3} className="p-4 text-center text-stone-400">
                    لا توجد بنود بعد
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <Can permission="budget.manage">
          <form onSubmit={addItem} className="mt-3 flex gap-2">
            <input
              required
              placeholder="اسم البند (مثال: مواد البناء)"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="flex-1 rounded-md border border-stone-300 px-3 py-2 text-sm"
            />
            <input
              required
              type="number"
              min="0"
              placeholder="المبلغ المخطَّط"
              value={plannedAmount}
              onChange={(e) => setPlannedAmount(e.target.value)}
              className="w-40 rounded-md border border-stone-300 px-3 py-2 text-sm"
            />
            <button className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white">إضافة بند</button>
          </form>
        </Can>
      </div>

      <div>
        <h3 className="mb-2 font-semibold text-stone-700">المصروفات</h3>
        <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-stone-50 text-stone-500">
              <tr>
                <th className="p-3 text-right">الوصف</th>
                <th className="p-3 text-right">التاريخ</th>
                <th className="p-3 text-right">المبلغ</th>
              </tr>
            </thead>
            <tbody>
              {summary.expenses.map((exp) => (
                <tr key={exp.id} className="border-t border-stone-100">
                  <td className="p-3">{exp.description}</td>
                  <td className="p-3 text-stone-500">{exp.expenseDate}</td>
                  <td className="p-3">{money(Number(exp.amount))}</td>
                </tr>
              ))}
              {summary.expenses.length === 0 && (
                <tr>
                  <td colSpan={3} className="p-4 text-center text-stone-400">
                    لا توجد مصروفات مسجّلة بعد
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <Can permission="budget.manage">
          <form onSubmit={addExpense} className="mt-3 flex flex-wrap gap-2">
            <input
              required
              placeholder="وصف المصروف"
              value={expenseDescription}
              onChange={(e) => setExpenseDescription(e.target.value)}
              className="flex-1 rounded-md border border-stone-300 px-3 py-2 text-sm"
            />
            <input
              required
              type="number"
              min="0"
              placeholder="المبلغ"
              value={expenseAmount}
              onChange={(e) => setExpenseAmount(e.target.value)}
              className="w-32 rounded-md border border-stone-300 px-3 py-2 text-sm"
            />
            <select
              value={expenseItemId}
              onChange={(e) => setExpenseItemId(e.target.value)}
              className="rounded-md border border-stone-300 px-3 py-2 text-sm"
            >
              <option value="">بدون بند محدد</option>
              {summary.items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.category}
                </option>
              ))}
            </select>
            <button className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white">تسجيل مصروف</button>
          </form>
        </Can>
      </div>
    </div>
  );
}

function StatCard({ label, value, tone = "default" }: { label: string; value: string; tone?: "default" | "danger" }) {
  return (
    <div className="rounded-lg border border-stone-200 bg-white p-4">
      <p className="text-xs text-stone-500">{label}</p>
      <p className={`mt-1 text-lg font-bold ${tone === "danger" ? "text-red-600" : "text-stone-800"}`}>{value}</p>
    </div>
  );
}
