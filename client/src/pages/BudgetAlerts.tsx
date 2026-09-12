import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { PageHeader } from "../ui/PageHeader";
import { Card } from "../ui/Card";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Skeleton } from "../ui/Skeleton";
import { EmptyState } from "../ui/EmptyState";
import { ErrorState } from "../ui/ErrorState";
import { Can } from "../auth/Can";
import { ApiError, apiFetch } from "../api/client";
import { formatMoney, formatDateTime } from "../lib/format";
import { listBudgetAlerts, evaluateBudgetAlerts, acknowledgeBudgetAlert, resolveBudgetAlert } from "../api/budgetAlerts";
import type { BudgetAlert, BudgetAlertSeverity, BudgetAlertStatus, Project } from "../api/types";
import { useTranslation } from "../i18n/I18nProvider";

// MIDAD Phase E — Proactive Budget Overrun Alerts.
//
// This page never computes a financial value or an alert of its own: every
// severity/metric/snapshot figure comes verbatim from the server's already-
// evaluated budget_alerts records (server/src/routes/budgetAlerts.ts). The
// browser is a display surface only — see lib/format.ts's own header
// comment for why that discipline applies here exactly as it does to every
// other financial screen in this codebase.
//
// Absence of an alert is never presented as a health guarantee: the empty
// state below deliberately avoids any "آمن"/"safe" wording.

const severityTone: Record<BudgetAlertSeverity, "info" | "warning" | "danger"> = { info: "info", warning: "warning", critical: "danger" };
const severityEmoji: Record<BudgetAlertSeverity, string> = { info: "ℹ️", warning: "🟠", critical: "🔴" };
const statusTone: Record<BudgetAlertStatus, "warning" | "info" | "success"> = { open: "warning", acknowledged: "info", resolved: "success" };

export function BudgetAlerts() {
  const { t, locale } = useTranslation();
  const [alerts, setAlerts] = useState<BudgetAlert[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [searchParams] = useSearchParams();
  // Drill-down entry point from OverviewSection's own compact card
  // (?projectId=...) — only read once, on first mount; the user's own
  // in-page filter selection afterward is not fought with the URL.
  const [projectFilter, setProjectFilter] = useState<string>(() => searchParams.get("projectId") ?? "");
  const [statusFilter, setStatusFilter] = useState<"active" | BudgetAlertStatus>("active");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [evaluating, setEvaluating] = useState(false);

  function load() {
    setError(null);
    listBudgetAlerts(projectFilter ? { projectId: projectFilter } : {})
      .then(setAlerts)
      .catch((err) => setError(err instanceof ApiError ? err.message : t("budgetAlertsPage.loadError")));
  }
  useEffect(load, [projectFilter]);
  useEffect(() => {
    apiFetch<Project[]>("/projects").then(setProjects).catch(() => setProjects([]));
  }, []);

  async function onEvaluate() {
    setEvaluating(true);
    setError(null);
    try {
      await evaluateBudgetAlerts(projectFilter || undefined);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("budgetAlertsPage.refreshError"));
    } finally {
      setEvaluating(false);
    }
  }

  const visible = useMemo(() => {
    if (!alerts) return alerts;
    if (statusFilter === "active") return alerts.filter((a) => a.status !== "resolved");
    return alerts.filter((a) => a.status === statusFilter);
  }, [alerts, statusFilter]);

  const selected = alerts?.find((a) => a.id === selectedId) ?? null;

  return (
    <Layout>
      <PageHeader
        title={t("budgetAlertsPage.title")}
        subtitle={t("budgetAlertsPage.subtitle")}
        actions={
          <Button size="sm" onClick={onEvaluate} disabled={evaluating}>
            {evaluating ? t("budgetAlertsPage.refreshing") : t("budgetAlertsPage.refresh")}
          </Button>
        }
      />

      <div className="mb-6">
        {error && <ErrorState message={error} onRetry={load} />}
        {!error && alerts === null && <Skeleton rows={3} />}
        {!error && alerts && <SummaryCard alerts={alerts} onSelect={setSelectedId} />}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <select
          value={projectFilter}
          onChange={(e) => setProjectFilter(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        >
          <option value="">{t("budgetAlertsPage.allProjects")}</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <div className="flex gap-1">
          {(["active", "open", "acknowledged", "resolved"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              className={`rounded-md border px-3 py-1.5 text-xs font-medium ${
                statusFilter === s ? "border-primary bg-primary/10 text-primary" : "border-stone-300 text-stone-500 hover:bg-stone-50"
              }`}
            >
              {s === "active" ? t("budgetAlertsPage.statusFilterActive") : t(`budgetAlertsPage.status.${s}`)}
            </button>
          ))}
        </div>
      </div>

      {error && <ErrorState message={error} onRetry={load} />}
      {!error && visible === null && <Skeleton rows={5} />}
      {!error && visible && visible.length === 0 && (
        <EmptyState
          message={t("budgetAlertsPage.emptyMessage")}
          action={<p className="text-xs text-stone-400">{t("dashboardPage.needsAttention.noIssues")}</p>}
        />
      )}
      {!error && visible && visible.length > 0 && (
        <ul className="space-y-2">
          {visible.map((a) => (
            <AlertRow key={a.id} alert={a} onSelect={() => setSelectedId(a.id)} projects={projects} />
          ))}
        </ul>
      )}

      {selected && (
        <div className="mt-6">
          <AlertDetail
            alert={selected}
            projectName={projects.find((p) => p.id === selected.projectId)?.name}
            onChanged={load}
            onClose={() => setSelectedId(null)}
          />
        </div>
      )}
    </Layout>
  );
}

function SummaryCard({ alerts, onSelect }: { alerts: BudgetAlert[]; onSelect: (id: string) => void }) {
  const { t } = useTranslation();
  const active = alerts.filter((a) => a.status !== "resolved");
  const counts: Record<BudgetAlertSeverity, number> = {
    critical: active.filter((a) => a.severity === "critical").length,
    warning: active.filter((a) => a.severity === "warning").length,
    info: active.filter((a) => a.severity === "info").length,
  };
  const topAlerts = [...active]
    .sort((a, b) => {
      const rank: Record<BudgetAlertSeverity, number> = { critical: 0, warning: 1, info: 2 };
      if (rank[a.severity] !== rank[b.severity]) return rank[a.severity] - rank[b.severity];
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    })
    .slice(0, 5);

  return (
    <Card className="p-5">
      <h2 className="mb-3 font-semibold text-stone-800">{t("dashboardPage.needsAttention.heading")}</h2>
      <div className="mb-4 grid grid-cols-3 gap-3">
        <div className="rounded-md bg-danger-50 p-3 text-center">
          <p className="text-2xl font-bold text-danger-700">{counts.critical}</p>
          <p className="text-xs text-danger-600">{t("budgetAlertsPage.summary.criticalCount")}</p>
        </div>
        <div className="rounded-md bg-warning-50 p-3 text-center">
          <p className="text-2xl font-bold text-warning-700">{counts.warning}</p>
          <p className="text-xs text-warning-600">{t("budgetAlertsPage.summary.warningCount")}</p>
        </div>
        <div className="rounded-md bg-info-50 p-3 text-center">
          <p className="text-2xl font-bold text-info-700">{counts.info}</p>
          <p className="text-xs text-info-600">{t("budgetAlertsPage.summary.infoCount")}</p>
        </div>
      </div>

      {topAlerts.length === 0 ? (
        <p className="text-sm text-stone-400">{t("dashboardPage.needsAttention.noIssues")}</p>
      ) : (
        <div>
          <p className="mb-2 text-xs font-semibold text-stone-500">{t("budgetAlertsPage.summary.topAlertsHeading")}</p>
          <ul className="space-y-1">
            {topAlerts.map((a) => (
              <li key={a.id} className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-stone-50" onClick={() => onSelect(a.id)}>
                <span>{severityEmoji[a.severity]}</span>
                <span className="flex-1">
                  <span className="font-medium text-stone-800">{a.project?.name ?? t("budgetAlertsPage.summary.defaultProjectName")}</span>
                  <span className="text-stone-500"> — {a.title}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function AlertRow({ alert, projects, onSelect }: { alert: BudgetAlert; projects: Project[]; onSelect: () => void }) {
  const { t, locale } = useTranslation();
  const projectName = alert.project?.name ?? projects.find((p) => p.id === alert.projectId)?.name ?? t("budgetAlertsPage.summary.defaultProjectName");
  return (
    <li className="cursor-pointer rounded-md border border-stone-100 px-3 py-2 text-sm hover:bg-stone-50" onClick={onSelect}>
      <div className="flex items-center justify-between">
        <span>
          <span className="font-medium text-stone-800">{projectName}</span>
          <span className="text-stone-500"> — {alert.title}</span>
        </span>
        <div className="flex items-center gap-2">
          <Badge tone={severityTone[alert.severity]}>{t(`dashboardPage.severity.${alert.severity}`)}</Badge>
          <Badge tone={statusTone[alert.status]}>{t(`budgetAlertsPage.status.${alert.status}`)}</Badge>
        </div>
      </div>
      <p className="mt-1 text-xs text-stone-400">{t("budgetAlertsPage.discoveredAt", { date: formatDateTime(alert.createdAt, locale) })}</p>
    </li>
  );
}

function AlertDetail({
  alert,
  projectName,
  onChanged,
  onClose,
}: {
  alert: BudgetAlert;
  projectName: string | undefined;
  onChanged: () => void;
  onClose: () => void;
}) {
  const { t, locale } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onAcknowledge() {
    setError(null);
    setSubmitting(true);
    try {
      await acknowledgeBudgetAlert(alert.id);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("budgetAlertsPage.detail.acknowledgeError"));
    } finally {
      setSubmitting(false);
    }
  }
  async function onResolve() {
    setError(null);
    setSubmitting(true);
    try {
      await resolveBudgetAlert(alert.id);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("budgetAlertsPage.detail.resolveError"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="p-5">
      <div className="mb-3 flex items-start justify-between">
        <div>
          <h3 className="font-semibold text-stone-800">{alert.title}</h3>
          <div className="mt-1 flex items-center gap-2">
            <Badge tone={severityTone[alert.severity]}>{t(`dashboardPage.severity.${alert.severity}`)}</Badge>
            <Badge tone={statusTone[alert.status]}>{t(`budgetAlertsPage.status.${alert.status}`)}</Badge>
          </div>
        </div>
        <button type="button" onClick={onClose} className="text-stone-400 hover:text-stone-600" aria-label={t("budgetAlertsPage.detail.closeAriaLabel")}>✕</button>
      </div>

      {error && (
        <div className="mb-3">
          <ErrorState message={error} />
        </div>
      )}

      <dl className="mb-4 text-sm">
        <Row label={t("budgetAlertsPage.detail.project")} value={projectName ?? "—"} />
        {alert.costCode && <Row label={t("budgetAlertsPage.detail.costCode")} value={`${alert.costCode.code} — ${alert.costCode.name}`} />}
        <Row label={t("budgetAlertsPage.detail.rule")} value={t(`budgetAlertsPage.rules.${alert.ruleCode}`)} />
        <Row label={t("budgetAlertsPage.detail.discoveredAtLabel")} value={formatDateTime(alert.createdAt, locale)} />
      </dl>

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {alert.budgetAmount !== null && <MiniStat label={t("budgetAlertsPage.detail.metrics.budget")} value={formatMoney(alert.budgetAmount, alert.currency, locale)} />}
        {alert.actualAmount !== null && <MiniStat label={t("budgetAlertsPage.detail.metrics.actual")} value={formatMoney(alert.actualAmount, alert.currency, locale)} />}
        {alert.commitmentAmount !== null && <MiniStat label={t("budgetAlertsPage.detail.metrics.commitments")} value={formatMoney(alert.commitmentAmount, alert.currency, locale)} />}
        {alert.forecastAmount !== null && <MiniStat label={t("budgetAlertsPage.detail.metrics.forecast")} value={formatMoney(alert.forecastAmount, alert.currency, locale)} />}
      </div>
      <p className="mb-4 text-xs text-stone-400">{t("budgetAlertsPage.detail.snapshotNotice")}</p>

      <div className="mb-4 rounded-md bg-stone-50 p-3">
        <p className="mb-1 text-xs font-semibold text-stone-500">{t("budgetAlertsPage.detail.whyHeading")}</p>
        <p className="text-sm text-stone-700">{alert.description}</p>
      </div>
      <div className="mb-4 rounded-md bg-stone-50 p-3">
        <p className="mb-1 text-xs font-semibold text-stone-500">{t("budgetAlertsPage.detail.whatToDoHeading")}</p>
        <p className="text-sm text-stone-700">{alert.recommendedAction}</p>
      </div>

      {alert.acknowledgedAt && <p className="mb-1 text-xs text-stone-400">{t("budgetAlertsPage.detail.acknowledgedAt", { date: formatDateTime(alert.acknowledgedAt, locale) })}</p>}
      {alert.resolvedAt && <p className="mb-3 text-xs text-stone-400">{t("budgetAlertsPage.detail.resolvedAt", { date: formatDateTime(alert.resolvedAt, locale) })}</p>}

      <Can permission="budgetAlert.manage">
        <div className="flex gap-2">
          {alert.status === "open" && (
            <Button size="sm" disabled={submitting} onClick={onAcknowledge}>{t("budgetAlertsPage.detail.acknowledge")}</Button>
          )}
          {(alert.status === "open" || alert.status === "acknowledged") && (
            <Button size="sm" variant="secondary" disabled={submitting} onClick={onResolve}>{t("budgetAlertsPage.detail.markResolved")}</Button>
          )}
        </div>
      </Can>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between border-b border-stone-100 py-1.5">
      <dt className="text-stone-500">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-stone-100 p-2 text-center">
      <p className="text-sm font-semibold text-stone-800">{value}</p>
      <p className="text-xs text-stone-500">{label}</p>
    </div>
  );
}
