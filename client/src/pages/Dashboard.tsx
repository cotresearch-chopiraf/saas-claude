import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Layout } from "../components/Layout";
import { PageHeader } from "../ui/PageHeader";
import { Card } from "../ui/Card";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { MetricCard } from "../ui/MetricCard";
import { FinancialTable, type FinancialColumn } from "../ui/FinancialTable";
import { Skeleton } from "../ui/Skeleton";
import { ErrorState } from "../ui/ErrorState";
import { apiFetch, ApiError } from "../api/client";
import { listCustomers } from "../api/customers";
import { listBudgetAlerts } from "../api/budgetAlerts";
import { formatDate } from "../lib/format";
import type { BudgetAlert, BudgetAlertSeverity, Customer, Project } from "../api/types";

// MIDAD Phase F — Dashboard redesigned as an Executive Command Center: a
// bounded KPI row, a "Needs Attention" section surfacing real cross-project
// risk, and a professional project table — replacing the previous flat
// equal-weight card grid. Every number here is either a plain count of
// already-loaded records or a server-generated Budget Alert (Phase E) —
// this page computes NOTHING financial itself. Per-project Budget/
// Forecast/Variance columns are deliberately NOT shown: no company-wide
// aggregate endpoint exists for them today, and fetching Budget/Forecast
// per project here would mean one API round-trip per row (N+1) — adding
// that endpoint is a backend change outside a UI-only phase's scope (see
// POST_AUDIT_BACKLOG.md). A manager gets that financial depth one click
// away, inside each project's own Overview.

const statusLabel: Record<Project["status"], string> = {
  active: "نشط",
  on_hold: "متوقف مؤقتاً",
  completed: "مكتمل",
};
const statusTone: Record<Project["status"], "success" | "warning" | "neutral"> = {
  active: "success",
  on_hold: "warning",
  completed: "neutral",
};
const severityLabel: Record<BudgetAlertSeverity, string> = { info: "معلومات", warning: "تحذير", critical: "حرج" };
const severityTone: Record<BudgetAlertSeverity, "info" | "warning" | "danger"> = { info: "info", warning: "warning", critical: "danger" };
const severityRank: Record<BudgetAlertSeverity, number> = { critical: 0, warning: 1, info: 2 };

export function Dashboard() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<BudgetAlert[] | null>(null);
  const [alertsError, setAlertsError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  function loadProjects() {
    setProjectsError(null);
    apiFetch<Project[]>("/projects")
      .then(setProjects)
      .catch((err) => setProjectsError(err instanceof ApiError ? err.message : "تعذّر تحميل المشاريع"));
  }
  function loadAlerts() {
    setAlertsError(null);
    listBudgetAlerts()
      .then(setAlerts)
      .catch((err) => setAlertsError(err instanceof ApiError ? err.message : "تعذّر تحميل تنبيهات الميزانية"));
  }
  useEffect(loadProjects, []);
  useEffect(loadAlerts, []);

  const activeCount = projects?.filter((p) => p.status === "active").length ?? 0;
  const onHoldCount = projects?.filter((p) => p.status === "on_hold").length ?? 0;
  const activeAlerts = (alerts ?? []).filter((a) => a.status !== "resolved");
  const criticalCount = activeAlerts.filter((a) => a.severity === "critical").length;
  const warningCount = activeAlerts.filter((a) => a.severity === "warning").length;
  const needsAttention = [...activeAlerts].sort((a, b) => severityRank[a.severity] - severityRank[b.severity]).slice(0, 4);

  const columns: FinancialColumn<Project>[] = [
    {
      key: "name",
      header: "المشروع",
      render: (p) => (
        <Link to={`/projects/${p.id}`} className="font-medium text-stone-800 hover:text-primary">
          {p.name}
        </Link>
      ),
    },
    { key: "client", header: "العميل", render: (p) => p.clientName ?? "—" },
    { key: "status", header: "الحالة", render: (p) => <Badge tone={statusTone[p.status]}>{statusLabel[p.status]}</Badge> },
    { key: "createdAt", header: "تاريخ الإنشاء", render: (p) => formatDate(p.createdAt) },
  ];

  return (
    <Layout>
      <PageHeader
        title="نظرة عامة"
        subtitle="ملخص تنفيذي لحالة الشركة ومشاريعها."
        actions={
          <Button size="sm" onClick={() => setShowForm((v) => !v)}>
            {showForm ? "إلغاء" : "+ مشروع جديد"}
          </Button>
        }
      />

      {showForm && (
        <div className="mb-6">
          <NewProjectForm
            onCreated={() => {
              setShowForm(false);
              loadProjects();
            }}
          />
        </div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricCard label="مشاريع نشطة" value={String(activeCount)} />
        <MetricCard label="متوقفة مؤقتاً" value={String(onHoldCount)} tone={onHoldCount > 0 ? "warning" : "default"} />
        <MetricCard label="تنبيهات حرجة" value={String(criticalCount)} tone={criticalCount > 0 ? "danger" : "default"} />
        <MetricCard label="تنبيهات تحذيرية" value={String(warningCount)} tone={warningCount > 0 ? "warning" : "default"} />
      </div>

      <div className="mb-6">
        <h2 className="mb-3 font-semibold text-stone-800">يحتاج إلى انتباه</h2>
        {alertsError && <ErrorState message={alertsError} onRetry={loadAlerts} />}
        {!alertsError && alerts === null && <Skeleton rows={2} />}
        {!alertsError && alerts && needsAttention.length === 0 && (
          <Card className="p-5">
            <p className="text-sm text-stone-400">لا توجد حالياً مؤشرات مالية تتجاوز قواعد التنبيه المحددة.</p>
          </Card>
        )}
        {!alertsError && needsAttention.length > 0 && (
          <div className="space-y-2">
            {needsAttention.map((a) => (
              <Card key={a.id} className="flex items-start justify-between gap-3 p-4">
                <div className="flex items-start gap-3">
                  <Badge tone={severityTone[a.severity]}>{severityLabel[a.severity]}</Badge>
                  <div>
                    <p className="text-sm font-medium text-stone-800">
                      {a.project?.name ?? "مشروع"} — {a.title}
                    </p>
                    <p className="mt-0.5 text-xs text-stone-500">{a.recommendedAction}</p>
                  </div>
                </div>
                <Link to={`/budget-alerts?projectId=${a.projectId}`} className="shrink-0 text-sm text-primary hover:underline">
                  مراجعة
                </Link>
              </Card>
            ))}
            <div className="text-end">
              <Link to="/budget-alerts" className="text-sm text-primary hover:underline">
                عرض جميع التنبيهات
              </Link>
            </div>
          </div>
        )}
      </div>

      <div>
        <h2 className="mb-3 font-semibold text-stone-800">المشاريع</h2>
        {projects && projects.length === 0 && !projectsError ? (
          <Card className="p-8 text-center">
            <p className="text-stone-500">لا توجد مشاريع بعد. أنشئ أول مشروع لبدء تتبع الميزانية والتقدم.</p>
          </Card>
        ) : (
          <FinancialTable columns={columns} rows={projects} rowKey={(p) => p.id} error={projectsError} onRetry={loadProjects} />
        )}
      </div>
    </Layout>
  );
}

function NewProjectForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [clientName, setClientName] = useState("");
  // MIDAD Phase A' — an entirely optional, independent link to a
  // first-class Customer. Never required, never derived from/synced with
  // clientName above — a project may set either, both, or neither.
  const [customerId, setCustomerId] = useState("");
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [budgetTotal, setBudgetTotal] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listCustomers()
      .then(setCustomers)
      .catch(() => setCustomers([]));
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch("/projects", {
        method: "POST",
        body: JSON.stringify({ name, clientName, customerId: customerId || undefined, budgetTotal: budgetTotal || 0 }),
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذّر إنشاء المشروع");
    }
  }

  return (
    <Card className="p-5">
      <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-3">
        {error && <div className="col-span-3 rounded-md bg-danger-50 px-3 py-2 text-sm text-danger-700">{error}</div>}
        <input
          required
          placeholder="اسم المشروع"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <input
          placeholder="اسم العميل"
          value={clientName}
          onChange={(e) => setClientName(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <select
          value={customerId}
          onChange={(e) => setCustomerId(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        >
          <option value="">ربط بعميل (اختياري)</option>
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <input
          type="number"
          min="0"
          placeholder="الميزانية الإجمالية ($)"
          value={budgetTotal}
          onChange={(e) => setBudgetTotal(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <Button type="submit" className="sm:col-span-1">
          حفظ المشروع
        </Button>
      </form>
    </Card>
  );
}
