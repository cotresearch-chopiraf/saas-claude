import { FormEvent, useEffect, useState } from "react";
import { apiFetch, getToken, ApiError } from "../api/client";
import { Can } from "../auth/Can";
import { formatMoney } from "../lib/format";
import type { BudgetSummary } from "../api/types";
import { useTranslation } from "../i18n/I18nProvider";

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

export function BudgetPanel({ projectId }: { projectId: string }) {
  const { t, locale } = useTranslation();
  const money = (n: number) => formatMoney(n, undefined, locale);
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

  if (!summary) return <p className="text-stone-500">{t("common.loading")}</p>;

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
      setError(err instanceof ApiError ? err.message : t("legacyBudgetPage.budgetPanel.addItemError"));
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
      setError(err instanceof ApiError ? err.message : t("legacyBudgetPage.budgetPanel.addExpenseError"));
    }
  }

  return (
    <div className="space-y-6">
      {error && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label={t("legacyBudgetPage.budgetPanel.planned")} value={money(totals.planned)} />
        <StatCard label={t("legacyBudgetPage.budgetPanel.spent")} value={money(totals.spent)} />
        <StatCard
          label={overBudget ? t("legacyBudgetPage.budgetPanel.overBudget") : t("legacyBudgetPage.budgetPanel.remaining")}
          value={money(Math.abs(totals.remaining))}
          tone={overBudget ? "danger" : "default"}
        />
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="font-semibold text-stone-700">{t("legacyBudgetPage.budgetPanel.itemsHeading")}</h3>
          <button
            onClick={() => downloadBudgetCsv(projectId)}
            className="text-sm text-primary underline decoration-dotted"
          >
            {t("legacyBudgetPage.budgetPanel.exportCsv")}
          </button>
        </div>
        <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-stone-50 text-stone-500">
              <tr>
                <th className="p-3 text-start">{t("legacyBudgetPage.budgetPanel.columns.item")}</th>
                <th className="p-3 text-start">{t("legacyBudgetPage.budgetPanel.columns.planned")}</th>
                <th className="p-3 text-start">{t("legacyBudgetPage.budgetPanel.columns.spent")}</th>
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
                    {t("legacyBudgetPage.budgetPanel.noItems")}
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
              placeholder={t("legacyBudgetPage.budgetPanel.itemNamePlaceholder")}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="flex-1 rounded-md border border-stone-300 px-3 py-2 text-sm"
            />
            <input
              required
              type="number"
              min="0"
              placeholder={t("legacyBudgetPage.budgetPanel.plannedAmountPlaceholder")}
              value={plannedAmount}
              onChange={(e) => setPlannedAmount(e.target.value)}
              className="w-40 rounded-md border border-stone-300 px-3 py-2 text-sm"
            />
            <button className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white">{t("legacyBudgetPage.budgetPanel.addItem")}</button>
          </form>
        </Can>
      </div>

      <div>
        <h3 className="mb-2 font-semibold text-stone-700">{t("legacyBudgetPage.budgetPanel.expensesHeading")}</h3>
        <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-stone-50 text-stone-500">
              <tr>
                <th className="p-3 text-start">{t("legacyBudgetPage.budgetPanel.expenseColumns.description")}</th>
                <th className="p-3 text-start">{t("legacyBudgetPage.budgetPanel.expenseColumns.date")}</th>
                <th className="p-3 text-start">{t("legacyBudgetPage.budgetPanel.expenseColumns.amount")}</th>
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
                    {t("legacyBudgetPage.budgetPanel.noExpenses")}
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
              placeholder={t("legacyBudgetPage.budgetPanel.expenseDescriptionPlaceholder")}
              value={expenseDescription}
              onChange={(e) => setExpenseDescription(e.target.value)}
              className="flex-1 rounded-md border border-stone-300 px-3 py-2 text-sm"
            />
            <input
              required
              type="number"
              min="0"
              placeholder={t("legacyBudgetPage.budgetPanel.amountPlaceholder")}
              value={expenseAmount}
              onChange={(e) => setExpenseAmount(e.target.value)}
              className="w-32 rounded-md border border-stone-300 px-3 py-2 text-sm"
            />
            <select
              value={expenseItemId}
              onChange={(e) => setExpenseItemId(e.target.value)}
              className="rounded-md border border-stone-300 px-3 py-2 text-sm"
            >
              <option value="">{t("legacyBudgetPage.budgetPanel.noItemSelected")}</option>
              {summary.items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.category}
                </option>
              ))}
            </select>
            <button className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white">{t("legacyBudgetPage.budgetPanel.recordExpense")}</button>
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
