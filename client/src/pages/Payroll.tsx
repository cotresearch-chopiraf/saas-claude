import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Layout } from "../components/Layout";
import { PageHeader } from "../ui/PageHeader";
import { Card } from "../ui/Card";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { FinancialTable, type FinancialColumn } from "../ui/FinancialTable";
import { ErrorState } from "../ui/ErrorState";
import { Can } from "../auth/Can";
import { formatDate, formatMoney } from "../lib/format";
import { listPayrollPeriods, createPayrollPeriod } from "../api/payrollPeriods";
import { ApiError } from "../api/client";
import type { PayrollPeriod, PayrollPeriodStatus } from "../api/types";
import { useTranslation } from "../i18n/I18nProvider";

const statusTone: Record<PayrollPeriodStatus, "neutral" | "warning" | "success" | "danger"> = {
  draft: "neutral",
  submitted: "warning",
  approved: "success",
  posted: "success",
  rejected: "danger",
};

// MIDAD Phase A3 — Payroll Periods list. This is INTERNAL payroll data
// maintained by the company — never described as an official Mudad/WPS
// submission (see payrollPeriods.ts's own file comment for the exact
// financial-truth and internal/external-data boundaries this UI must
// respect). Deliberately simple: a period, its status, and its totals —
// no charts, no analytics, matching this app's existing master-data list
// pattern (Suppliers/Customers/Employees) rather than a payroll dashboard.
export function Payroll() {
  const { t, locale } = useTranslation();
  const [periods, setPeriods] = useState<PayrollPeriod[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  function load() {
    setError(null);
    setPeriods(null);
    listPayrollPeriods()
      .then(setPeriods)
      .catch((err) => setError(err instanceof Error ? err.message : t("payrollPage.loadError")));
  }
  useEffect(load, []);

  const columns: FinancialColumn<PayrollPeriod>[] = [
    {
      key: "period",
      header: t("payrollPage.columns.period"),
      render: (p) => (
        <Link to={`/payroll/${p.id}`} className="font-medium text-primary hover:underline">
          {formatDate(p.periodStart, locale)} – {formatDate(p.periodEnd, locale)}
        </Link>
      ),
    },
    { key: "status", header: t("payrollPage.columns.status"), render: (p) => <Badge tone={statusTone[p.status]}>{t(`payrollPage.status.${p.status}`)}</Badge> },
    { key: "employeeCount", header: t("payrollPage.columns.employeeCount"), render: (p) => String(p.summary.employeeCount) },
    { key: "totalNet", header: t("payrollPage.columns.totalNet"), render: (p) => formatMoney(p.summary.totalNet, undefined, locale) },
  ];

  return (
    <Layout>
      <PageHeader
        title={t("payrollPage.title")}
        subtitle={t("payrollPage.subtitle")}
        actions={
          <Can permission="payroll.manage">
            <Button size="sm" onClick={() => setShowCreate((v) => !v)}>
              {showCreate ? t("common.cancel") : t("payrollPage.newPeriod")}
            </Button>
          </Can>
        }
      />

      {showCreate && (
        <Can permission="payroll.manage">
          <div className="mb-6">
            <PayrollPeriodForm
              onCreated={() => {
                setShowCreate(false);
                load();
              }}
            />
          </div>
        </Can>
      )}

      <FinancialTable
        columns={columns}
        rows={periods}
        rowKey={(p) => p.id}
        error={error}
        onRetry={load}
        emptyMessage={t("payrollPage.emptyMessage")}
        rowActions={(p) => (
          <Link to={`/payroll/${p.id}`} className="text-sm text-primary hover:underline">
            {t("payrollPage.openPeriod")}
          </Link>
        )}
      />
    </Layout>
  );
}

function PayrollPeriodForm({ onCreated }: { onCreated: () => void }) {
  const { t } = useTranslation();
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [payrollDate, setPayrollDate] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await createPayrollPeriod({
        periodStart,
        periodEnd,
        payrollDate: payrollDate || undefined,
        notes: notes || undefined,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("payrollPage.form.genericError"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="p-5">
      <form onSubmit={onSubmit} className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {error && (
          <div className="sm:col-span-3">
            <ErrorState message={error} />
          </div>
        )}
        <div>
          <label className="mb-1 block text-xs text-stone-500">{t("payrollPage.form.periodStart")}</label>
          <input
            required
            type="date"
            value={periodStart}
            onChange={(e) => setPeriodStart(e.target.value)}
            className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-stone-500">{t("payrollPage.form.periodEnd")}</label>
          <input
            required
            type="date"
            value={periodEnd}
            onChange={(e) => setPeriodEnd(e.target.value)}
            className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-stone-500">{t("payrollPage.form.payrollDateLabel")}</label>
          <input
            type="date"
            value={payrollDate}
            onChange={(e) => setPayrollDate(e.target.value)}
            className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
          />
        </div>
        <input
          placeholder={t("payrollPage.form.notesPlaceholder")}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm sm:col-span-2"
        />
        <Button type="submit" disabled={submitting}>
          {submitting ? t("payrollPage.form.saving") : t("payrollPage.form.create")}
        </Button>
      </form>
    </Card>
  );
}
