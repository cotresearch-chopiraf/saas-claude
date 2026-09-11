import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Layout } from "../components/Layout";
import { PageHeader } from "../ui/PageHeader";
import { Card } from "../ui/Card";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { MetricCard } from "../ui/MetricCard";
import { FinancialTable, type FinancialColumn } from "../ui/FinancialTable";
import { ErrorState } from "../ui/ErrorState";
import { Can } from "../auth/Can";
import { formatDate } from "../lib/format";
import { listEmployees, createEmployee, updateEmployee } from "../api/employees";
import { ApiError } from "../api/client";
import type { Employee, EmployeeStatus } from "../api/types";
import { useTranslation } from "../i18n/I18nProvider";

const statusTone: Record<EmployeeStatus, "success" | "neutral"> = { active: "success", inactive: "neutral" };

// MIDAD Phase A2 — the Employee (Workforce) domain UI, deliberately
// minimal (mirrors pages/Suppliers.tsx exactly, plus a summary row and
// search/status filter per the A2 spec) — a company-wide workforce
// directory, not an HR system. Global nav page (not project-scoped),
// consuming the existing, verified server/src/routes/employees.ts. This
// is master data only: no payroll, no allocation, no posting — see
// employees.ts's own file comment for the exact boundary.
export function Employees() {
  const { t, locale } = useTranslation();
  const [employees, setEmployees] = useState<Employee[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | EmployeeStatus>("all");

  function load() {
    setError(null);
    setEmployees(null);
    listEmployees()
      .then(setEmployees)
      .catch((err) => setError(err instanceof Error ? err.message : t("employeesPage.loadError")));
  }
  useEffect(load, []);

  const filtered = useMemo(() => {
    if (!employees) return employees;
    const q = search.trim().toLowerCase();
    return employees.filter((e) => {
      if (statusFilter !== "all" && e.status !== statusFilter) return false;
      if (!q) return true;
      return e.name.toLowerCase().includes(q) || e.employeeNumber.toLowerCase().includes(q);
    });
  }, [employees, search, statusFilter]);

  const total = employees?.length ?? 0;
  const activeCount = employees?.filter((e) => e.status === "active").length ?? 0;
  const inactiveCount = employees?.filter((e) => e.status === "inactive").length ?? 0;

  const columns: FinancialColumn<Employee>[] = [
    { key: "name", header: t("employeesPage.columns.name"), render: (e) => e.name },
    { key: "employeeNumber", header: t("employeesPage.columns.employeeNumber"), render: (e) => e.employeeNumber },
    { key: "jobTitle", header: t("employeesPage.columns.jobTitle"), render: (e) => e.jobTitle ?? "—" },
    { key: "status", header: t("employeesPage.columns.status"), render: (e) => <Badge tone={statusTone[e.status]}>{t(`customerDetail.status.${e.status}`)}</Badge> },
    { key: "hireDate", header: t("employeesPage.columns.hireDate"), render: (e) => formatDate(e.hireDate, locale) },
  ];

  return (
    <Layout>
      <PageHeader
        title={t("employeesPage.title")}
        subtitle={t("employeesPage.subtitle")}
        actions={
          <Can permission="workforce.manage">
            <Button size="sm" onClick={() => setShowCreate((v) => !v)}>
              {showCreate ? t("common.cancel") : t("employeesPage.addEmployee")}
            </Button>
          </Can>
        }
      />

      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <MetricCard label={t("employeesPage.metrics.total")} value={String(total)} />
        <MetricCard label={t("employeesPage.metrics.active")} value={String(activeCount)} tone="success" />
        <MetricCard label={t("employeesPage.metrics.inactive")} value={String(inactiveCount)} />
      </div>

      {showCreate && (
        <Can permission="workforce.manage">
          <div className="mb-6">
            <EmployeeForm
              onCreated={() => {
                setShowCreate(false);
                load();
              }}
            />
          </div>
        </Can>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          type="text"
          placeholder={t("employeesPage.searchPlaceholder")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full max-w-xs rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <div className="flex gap-1">
          {(["all", "active", "inactive"] as const).map((s) => (
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
              {s === "all" ? t("employeesPage.filterAll") : t(`customerDetail.status.${s}`)}
            </button>
          ))}
        </div>
      </div>

      <FinancialTable
        columns={columns}
        rows={filtered}
        rowKey={(e) => e.id}
        error={error}
        onRetry={load}
        emptyMessage={employees && employees.length > 0 ? t("employeesPage.noSearchResults") : t("employeesPage.emptyMessage")}
        rowActions={(e) => (
          <Can permission="workforce.manage">
            <EmployeeRowActions employee={e} onChanged={load} />
          </Can>
        )}
      />
    </Layout>
  );
}

function EmployeeForm({ onCreated }: { onCreated: (employee: Employee) => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [employeeNumber, setEmployeeNumber] = useState("");
  const [jobTitle, setJobTitle] = useState("");
  const [hireDate, setHireDate] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const employee = await createEmployee({
        name,
        employeeNumber,
        jobTitle: jobTitle || undefined,
        hireDate: hireDate || undefined,
        email: email || undefined,
        phone: phone || undefined,
      });
      onCreated(employee);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("employeesPage.form.genericError"));
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
        <input
          required
          placeholder={t("employeesPage.form.namePlaceholder")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <div>
          <input
            required
            placeholder={t("employeesPage.form.employeeNumberPlaceholder")}
            value={employeeNumber}
            onChange={(e) => setEmployeeNumber(e.target.value)}
            className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
          />
          <p className="mt-1 text-xs text-stone-400">{t("employeesPage.form.employeeNumberHint")}</p>
        </div>
        <input
          placeholder={t("employeesPage.form.jobTitlePlaceholder")}
          value={jobTitle}
          onChange={(e) => setJobTitle(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <input
          type="date"
          placeholder={t("employeesPage.form.hireDatePlaceholder")}
          value={hireDate}
          onChange={(e) => setHireDate(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <input
          type="email"
          placeholder={t("employeesPage.form.emailPlaceholder")}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <input
          placeholder={t("employeesPage.form.phonePlaceholder")}
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <Button type="submit" disabled={submitting}>
          {submitting ? t("employeesPage.form.saving") : t("employeesPage.form.save")}
        </Button>
      </form>
    </Card>
  );
}

function EmployeeRowActions({ employee, onChanged }: { employee: Employee; onChanged: () => void }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(employee.name);
  const [jobTitle, setJobTitle] = useState(employee.jobTitle ?? "");
  const [email, setEmail] = useState(employee.email ?? "");
  const [phone, setPhone] = useState(employee.phone ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSave() {
    setBusy(true);
    setError(null);
    try {
      await updateEmployee(employee.id, {
        name,
        jobTitle: jobTitle || undefined,
        email: email || undefined,
        phone: phone || undefined,
      });
      setEditing(false);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("employeesPage.rowActions.saveError"));
    } finally {
      setBusy(false);
    }
  }

  async function onToggleStatus() {
    setBusy(true);
    setError(null);
    try {
      await updateEmployee(employee.id, { status: employee.status === "active" ? "inactive" : "active" });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("employeesPage.rowActions.statusError"));
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <div className="flex flex-col items-end gap-1">
        {error && <span className="text-xs text-danger-600">{error}</span>}
        <div className="flex flex-wrap justify-end gap-1">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-28 rounded-md border border-stone-300 px-2 py-1 text-xs"
          />
          <input
            value={jobTitle}
            onChange={(e) => setJobTitle(e.target.value)}
            placeholder={t("employeesPage.rowActions.jobTitlePlaceholder")}
            className="w-28 rounded-md border border-stone-300 px-2 py-1 text-xs"
          />
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t("employeesPage.rowActions.emailPlaceholder")}
            className="w-32 rounded-md border border-stone-300 px-2 py-1 text-xs"
          />
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder={t("employeesPage.rowActions.phonePlaceholder")}
            className="w-24 rounded-md border border-stone-300 px-2 py-1 text-xs"
          />
          <Button size="sm" onClick={onSave} disabled={busy}>
            {t("common.save")}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setEditing(false)} disabled={busy}>
            {t("common.cancel")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-end gap-3">
      {error && <span className="text-xs text-danger-600">{error}</span>}
      <button type="button" onClick={() => setEditing(true)} className="text-sm text-primary hover:underline">
        {t("employeesPage.rowActions.edit")}
      </button>
      <button type="button" onClick={onToggleStatus} disabled={busy} className="text-sm text-stone-500 hover:underline">
        {employee.status === "active" ? t("employeesPage.rowActions.deactivate") : t("employeesPage.rowActions.reactivate")}
      </button>
    </div>
  );
}
