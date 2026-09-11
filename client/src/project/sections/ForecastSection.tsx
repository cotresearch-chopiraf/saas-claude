import { useEffect, useState, type FormEvent } from "react";
import { PageHeader } from "../../ui/PageHeader";
import { Card } from "../../ui/Card";
import { Button } from "../../ui/Button";
import { MetricCard } from "../../ui/MetricCard";
import { FinancialTable, type FinancialColumn } from "../../ui/FinancialTable";
import { ErrorState } from "../../ui/ErrorState";
import { Skeleton } from "../../ui/Skeleton";
import { Can } from "../../auth/Can";
import { formatMoney, formatPercent, formatDate, formatDateTime } from "../../lib/format";
import { getForecast, listForecastSnapshots, createForecastSnapshot } from "../../api/forecast";
import { ApiError } from "../../api/client";
import type { ForecastCalculation, ForecastMethod, ForecastResult, ForecastSnapshot } from "../../api/types";
import { useProjectContext } from "../context";
import { useTranslation } from "../../i18n/I18nProvider";

const methods: ForecastMethod[] = ["cost_to_complete", "commitment_aware"];

// Forecast (UI-05) — the frontend for the existing, fully-tested
// server/src/routes/forecast.ts. Every ETC/EAC/variance figure is
// computed exclusively by lib/forecast.ts's calculateForecast(); this
// screen only displays what the API returns, both live (GET /forecast)
// and as immutable, owner-only-created historical snapshots. Downstream
// of Cost Plan/Actual Cost/Commitment/IPC and mutates none of them — see
// docs/MIDAD_FORECAST_MODEL.md. Cash Flow (which itself reuses this
// domain's own calculation, per routes/cashflow.ts) is deliberately out
// of scope here.
export function ForecastSection() {
  const { t, locale } = useTranslation();
  const { projectId } = useProjectContext();
  const [forecast, setForecast] = useState<ForecastResult | null>(null);
  const [snapshots, setSnapshots] = useState<ForecastSnapshot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  function load() {
    setError(null);
    setForecast(null);
    setSnapshots(null);
    Promise.all([getForecast(projectId), listForecastSnapshots(projectId)])
      .then(([forecastResult, snapshotRows]) => {
        setForecast(forecastResult);
        setSnapshots(snapshotRows);
      })
      .catch((err) => setError(err instanceof Error ? err.message : t("forecastPage.loadError")));
  }
  useEffect(load, [projectId]);

  if (error && !forecast) {
    return (
      <div className="space-y-6">
        <PageHeader title={t("forecastPage.title")} />
        <ErrorState message={error} onRetry={load} />
      </div>
    );
  }
  if (!forecast) {
    return (
      <div className="space-y-6">
        <PageHeader title={t("forecastPage.title")} />
        <Skeleton rows={6} />
      </div>
    );
  }

  const snapshotColumns: FinancialColumn<ForecastSnapshot>[] = [
    { key: "asOfDate", header: t("forecastPage.snapshotColumns.asOfDate"), render: (s) => formatDate(s.asOfDate, locale) },
    { key: "method", header: t("forecastPage.snapshotColumns.method"), render: (s) => t(`forecastPage.method.${s.method}`) },
    { key: "eac", header: "EAC", align: "end", render: (s) => formatMoney(s.eac, s.currency, locale) },
    { key: "etc", header: "ETC", align: "end", render: (s) => formatMoney(s.etc, s.currency, locale) },
    {
      key: "variancePercent",
      header: t("forecastPage.snapshotColumns.variance"),
      align: "end",
      render: (s) => formatPercent(s.variancePercent === null ? null : Number(s.variancePercent), 1, locale),
    },
    { key: "notes", header: t("forecastPage.snapshotColumns.notes"), render: (s) => s.notes ?? "—" },
    { key: "createdAt", header: t("forecastPage.snapshotColumns.createdAt"), render: (s) => formatDateTime(s.createdAt, locale) },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("forecastPage.title")}
        actions={
          <Can permission="forecast.manage">
            <Button size="sm" onClick={() => setShowCreate((v) => !v)}>
              {showCreate ? t("common.cancel") : t("forecastPage.newSnapshot")}
            </Button>
          </Can>
        }
      />

      {error && (
        <div>
          <ErrorState message={error} />
        </div>
      )}

      {/* Method-independent inputs, shared by both methods below — the
          same four canonical figures Forecast reads from Cost Plan,
          Actual Cost, Commitment, and IPC. Certified Progress is context
          only (see docs/MIDAD_FORECAST_MODEL.md §5) — never blended into
          either method's ETC/EAC. */}
      <div className="grid gap-4 sm:grid-cols-4">
        <MetricCard label={t("forecastPage.inputs.costPlan")} value={formatMoney(forecast.methods.cost_to_complete.costPlan, forecast.currency, locale)} />
        <MetricCard label={t("forecastPage.inputs.actualCost")} value={formatMoney(forecast.methods.cost_to_complete.actualCost, forecast.currency, locale)} />
        <MetricCard label={t("forecastPage.inputs.committedCost")} value={formatMoney(forecast.methods.cost_to_complete.committedCost, forecast.currency, locale)} />
        <MetricCard
          label={t("forecastPage.inputs.certifiedValue")}
          value={formatMoney(forecast.methods.cost_to_complete.certifiedValue, forecast.currency, locale)}
          hint={t("forecastPage.inputs.certifiedValueHint")}
        />
      </div>

      {forecast.excludedForeignCurrencyCommitmentIds.length > 0 && (
        <p className="text-sm text-warning-700">
          {t("forecastPage.excludedForeignCurrency", {
            count: forecast.excludedForeignCurrencyCommitmentIds.length,
            currency: forecast.currency,
          })}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {methods.map((m) => (
          <MethodCard key={m} calc={forecast.methods[m]} currency={forecast.currency} />
        ))}
      </div>

      {showCreate && (
        <Can permission="forecast.manage">
          <SnapshotCreateForm projectId={projectId} onCreated={load} />
        </Can>
      )}

      <FinancialTable
        columns={snapshotColumns}
        rows={snapshots}
        rowKey={(s) => s.id}
        emptyMessage={t("forecastPage.emptySnapshots")}
      />
    </div>
  );
}

function MethodCard({ calc, currency }: { calc: ForecastCalculation; currency: string }) {
  const { t, locale } = useTranslation();
  const varianceTone = calc.variance >= 0 ? "success" : "danger";
  return (
    <Card className="p-5">
      <h3 className="mb-3 font-semibold text-stone-800">{t(`forecastPage.method.${calc.method}`)}</h3>
      <dl className="space-y-3 text-sm">
        <Field label={t("forecastPage.methodCard.etc")} value={formatMoney(calc.etc, currency, locale)} />
        <Field label={t("forecastPage.methodCard.eac")} value={formatMoney(calc.eac, currency, locale)} />
        <Field label={t("forecastPage.methodCard.variance")} value={formatMoney(calc.variance, currency, locale)} tone={varianceTone} />
        <Field label={t("forecastPage.methodCard.variancePercent")} value={formatPercent(calc.variancePercent, 1, locale)} tone={varianceTone} />
      </dl>
    </Card>
  );
}

function Field({ label, value, tone }: { label: string; value: string; tone?: "success" | "danger" }) {
  const toneClass = tone === "success" ? "text-success-700" : tone === "danger" ? "text-danger-700" : "text-stone-800";
  return (
    <div className="flex items-baseline justify-between border-b border-stone-100 pb-2">
      <dt className="text-stone-500">{label}</dt>
      <dd className={`font-medium ${toneClass}`}>{value}</dd>
    </div>
  );
}

function SnapshotCreateForm({ projectId, onCreated }: { projectId: string; onCreated: () => void }) {
  const { t } = useTranslation();
  const [method, setMethod] = useState<ForecastMethod>("commitment_aware");
  const [asOfDate, setAsOfDate] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await createForecastSnapshot(projectId, {
        method,
        asOfDate: asOfDate || undefined,
        notes: notes || undefined,
      });
      setNotes("");
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("forecastPage.createForm.genericError"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="p-5">
      <form onSubmit={onSubmit} className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        {error && (
          <div className="sm:col-span-4">
            <ErrorState message={error} />
          </div>
        )}
        <select
          value={method}
          onChange={(e) => setMethod(e.target.value as ForecastMethod)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm sm:col-span-2"
        >
          {methods.map((m) => (
            <option key={m} value={m}>
              {t(`forecastPage.method.${m}`)}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={asOfDate}
          onChange={(e) => setAsOfDate(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <input
          placeholder={t("forecastPage.createForm.notesPlaceholder")}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <Button type="submit" size="sm" disabled={submitting} className="sm:col-span-4">
          {submitting ? t("forecastPage.createForm.saving") : t("forecastPage.createForm.create")}
        </Button>
      </form>
    </Card>
  );
}
