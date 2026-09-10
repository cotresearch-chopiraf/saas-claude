import { FormEvent, useEffect, useMemo, useState } from "react";
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
import { getComplianceDashboard } from "../api/workforceCompliance";
import { formatDate } from "../lib/format";
import type { BudgetAlert, BudgetAlertSeverity, ComplianceDashboard, Customer, Project } from "../api/types";

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

interface AttentionItem {
  key: string;
  severity: BudgetAlertSeverity;
  title: string;
  detail: string;
  href: string;
}

export function Dashboard() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [alerts, setAlerts] = useState<BudgetAlert[] | null>(null);
  const [alertsError, setAlertsError] = useState<string | null>(null);
  // Compliance exceptions are a secondary, best-effort addition to Needs
  // Attention (Budget Alerts is the section's primary, fully-error-handled
  // source) — if this one call fails, that one attention item is simply
  // omitted rather than blocking the whole section with a second error UI.
  // Company-wide, one call, zero N+1 — the same dashboard endpoint
  // LaborCompliance.tsx's own DashboardCard already uses. Only its
  // pre-aggregated {open, highOrCritical} counts are read here; nothing is
  // recomputed from raw Nitaqat/GOSI/exception records.
  const [compliance, setCompliance] = useState<ComplianceDashboard | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | Project["status"]>("all");
  const [sort, setSort] = useState<{ key: string; direction: "asc" | "desc" }>({ key: "createdAt", direction: "desc" });

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
  function loadCompliance() {
    getComplianceDashboard()
      .then(setCompliance)
      .catch(() => setCompliance(null));
  }
  useEffect(loadProjects, []);
  useEffect(loadAlerts, []);
  useEffect(loadCompliance, []);

  const activeCount = projects?.filter((p) => p.status === "active").length ?? 0;
  const onHoldCount = projects?.filter((p) => p.status === "on_hold").length ?? 0;
  const activeAlerts = (alerts ?? []).filter((a) => a.status !== "resolved");
  const criticalCount = activeAlerts.filter((a) => a.severity === "critical").length;
  const warningCount = activeAlerts.filter((a) => a.severity === "warning").length;

  const attentionItems: AttentionItem[] = useMemo(() => {
    const items: AttentionItem[] = activeAlerts.map((a) => ({
      key: `alert-${a.id}`,
      severity: a.severity,
      title: `${a.project?.name ?? "مشروع"} — ${a.title}`,
      detail: a.recommendedAction,
      href: `/budget-alerts?projectId=${a.projectId}`,
    }));
    if (compliance && compliance.exceptions.open > 0) {
      items.push({
        key: "compliance-exceptions",
        severity: compliance.exceptions.highOrCritical > 0 ? "critical" : "warning",
        title: "استثناءات امتثال العمالة",
        detail:
          compliance.exceptions.highOrCritical > 0
            ? `${compliance.exceptions.open} استثناء مفتوح، منها ${compliance.exceptions.highOrCritical} عالية الأولوية`
            : `${compliance.exceptions.open} استثناء مفتوح`,
        href: "/labor-compliance",
      });
    }
    return items.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]).slice(0, 5);
  }, [activeAlerts, compliance]);
  const attentionLoading = alerts === null;

  const filteredProjects = useMemo(() => {
    if (!projects) return projects;
    const q = search.trim().toLowerCase();
    const filtered = projects.filter((p) => {
      if (statusFilter !== "all" && p.status !== statusFilter) return false;
      if (!q) return true;
      return p.name.toLowerCase().includes(q) || (p.clientName ?? "").toLowerCase().includes(q);
    });
    // Purely a client-side reorder of already-loaded/already-filtered rows
    // (no new data, no financial computation) — mirrors the search/status
    // filter above, just one more presentational transform of the same set.
    const dir = sort.direction === "asc" ? 1 : -1;
    return [...filtered].sort((a, b) => {
      switch (sort.key) {
        case "name":
          return a.name.localeCompare(b.name, "ar") * dir;
        case "client":
          return (a.clientName ?? "").localeCompare(b.clientName ?? "", "ar") * dir;
        case "status":
          return a.status.localeCompare(b.status) * dir;
        case "createdAt":
        default:
          return (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) * dir;
      }
    });
  }, [projects, search, statusFilter, sort]);

  function toggleSort(key: string) {
    setSort((prev) => (prev.key === key ? { key, direction: prev.direction === "asc" ? "desc" : "asc" } : { key, direction: "asc" }));
  }

  const columns: FinancialColumn<Project>[] = [
    {
      key: "name",
      header: "المشروع",
      sortable: true,
      render: (p) => (
        <Link to={`/projects/${p.id}`} className="font-medium text-stone-800 hover:text-primary">
          {p.name}
        </Link>
      ),
    },
    { key: "client", header: "العميل", sortable: true, render: (p) => p.clientName ?? "—" },
    {
      key: "status",
      header: "الحالة",
      sortable: true,
      render: (p) => <Badge tone={statusTone[p.status]}>{statusLabel[p.status]}</Badge>,
    },
    { key: "createdAt", header: "تاريخ الإنشاء", sortable: true, render: (p) => formatDate(p.createdAt) },
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
        {!alertsError && attentionLoading && <Skeleton rows={2} />}
        {!alertsError && !attentionLoading && attentionItems.length === 0 && (
          <Card className="p-5">
            <p className="text-sm text-stone-400">لا توجد حالياً مؤشرات مالية تتجاوز قواعد التنبيه المحددة.</p>
          </Card>
        )}
        {!alertsError && attentionItems.length > 0 && (
          <div className="space-y-2">
            {attentionItems.map((item) => (
              <Card key={item.key} className="flex items-start justify-between gap-3 p-4">
                <div className="flex items-start gap-3">
                  <Badge tone={severityTone[item.severity]}>{severityLabel[item.severity]}</Badge>
                  <div>
                    <p className="text-sm font-medium text-stone-800">{item.title}</p>
                    <p className="mt-0.5 text-xs text-stone-500">{item.detail}</p>
                  </div>
                </div>
                <Link to={item.href} className="shrink-0 text-sm text-primary hover:underline">
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
          <>
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <input
                type="text"
                placeholder="البحث بالاسم أو العميل"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full max-w-xs rounded-md border border-stone-300 px-3 py-2 text-sm"
              />
              <div className="flex gap-1">
                {(["all", "active", "on_hold", "completed"] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setStatusFilter(s)}
                    className={`rounded-md border px-3 py-1.5 text-xs font-medium ${
                      statusFilter === s
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-stone-300 text-stone-500 hover:bg-stone-50"
                    }`}
                  >
                    {s === "all" ? "الكل" : statusLabel[s]}
                  </button>
                ))}
              </div>
            </div>
            <FinancialTable
              columns={columns}
              rows={filteredProjects}
              rowKey={(p) => p.id}
              error={projectsError}
              onRetry={loadProjects}
              emptyMessage={projects && projects.length > 0 ? "لا نتائج مطابقة للبحث" : "لا توجد مشاريع بعد"}
              sort={sort}
              onSort={toggleSort}
            />
          </>
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
