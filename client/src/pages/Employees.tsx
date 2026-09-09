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

const statusLabel: Record<EmployeeStatus, string> = { active: "نشط", inactive: "غير نشط" };
const statusTone: Record<EmployeeStatus, "success" | "neutral"> = { active: "success", inactive: "neutral" };

// MIDAD Phase A2 — the Employee (Workforce) domain UI, deliberately
// minimal (mirrors pages/Suppliers.tsx exactly, plus a summary row and
// search/status filter per the A2 spec) — a company-wide workforce
// directory, not an HR system. Global nav page (not project-scoped),
// consuming the existing, verified server/src/routes/employees.ts. This
// is master data only: no payroll, no allocation, no posting — see
// employees.ts's own file comment for the exact boundary.
export function Employees() {
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
      .catch((err) => setError(err instanceof Error ? err.message : "تعذّر تحميل قائمة الموظفين"));
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
    { key: "name", header: "الموظف", render: (e) => e.name },
    { key: "employeeNumber", header: "رقم الموظف", render: (e) => e.employeeNumber },
    { key: "jobTitle", header: "المسمى الوظيفي", render: (e) => e.jobTitle ?? "—" },
    { key: "status", header: "الحالة", render: (e) => <Badge tone={statusTone[e.status]}>{statusLabel[e.status]}</Badge> },
    { key: "hireDate", header: "تاريخ التعيين", render: (e) => formatDate(e.hireDate) },
  ];

  return (
    <Layout>
      <PageHeader
        title="الموظفون"
        subtitle="دليل القوى العاملة الخاص بالشركة."
        actions={
          <Can permission="workforce.manage">
            <Button size="sm" onClick={() => setShowCreate((v) => !v)}>
              {showCreate ? "إلغاء" : "+ إضافة موظف"}
            </Button>
          </Can>
        }
      />

      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <MetricCard label="إجمالي الموظفين" value={String(total)} />
        <MetricCard label="نشط" value={String(activeCount)} tone="success" />
        <MetricCard label="غير نشط" value={String(inactiveCount)} />
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
          placeholder="البحث بالاسم أو رقم الموظف"
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
              {s === "all" ? "الكل" : statusLabel[s]}
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
        emptyMessage={employees && employees.length > 0 ? "لا نتائج مطابقة للبحث" : "لا يوجد موظفون بعد"}
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
      setError(err instanceof ApiError ? err.message : "تعذّر إضافة الموظف");
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
          placeholder="الاسم الكامل"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <div>
          <input
            required
            placeholder="رقم الموظف"
            value={employeeNumber}
            onChange={(e) => setEmployeeNumber(e.target.value)}
            className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
          />
          <p className="mt-1 text-xs text-stone-400">يُستخدم لتحديد الموظف في سجلات القوى العاملة والرواتب.</p>
        </div>
        <input
          placeholder="المسمى الوظيفي (اختياري)"
          value={jobTitle}
          onChange={(e) => setJobTitle(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <input
          type="date"
          placeholder="تاريخ التعيين"
          value={hireDate}
          onChange={(e) => setHireDate(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <input
          type="email"
          placeholder="البريد الإلكتروني (اختياري)"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <input
          placeholder="الهاتف (اختياري)"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <Button type="submit" disabled={submitting}>
          {submitting ? "جارٍ الحفظ..." : "حفظ الموظف"}
        </Button>
      </form>
    </Card>
  );
}

function EmployeeRowActions({ employee, onChanged }: { employee: Employee; onChanged: () => void }) {
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
      setError(err instanceof ApiError ? err.message : "تعذّر حفظ التعديل");
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
      setError(err instanceof ApiError ? err.message : "تعذّر تغيير حالة الموظف");
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
            placeholder="المسمى الوظيفي"
            className="w-28 rounded-md border border-stone-300 px-2 py-1 text-xs"
          />
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="البريد الإلكتروني"
            className="w-32 rounded-md border border-stone-300 px-2 py-1 text-xs"
          />
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="الهاتف"
            className="w-24 rounded-md border border-stone-300 px-2 py-1 text-xs"
          />
          <Button size="sm" onClick={onSave} disabled={busy}>
            حفظ
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setEditing(false)} disabled={busy}>
            إلغاء
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-end gap-3">
      {error && <span className="text-xs text-danger-600">{error}</span>}
      <button type="button" onClick={() => setEditing(true)} className="text-sm text-primary hover:underline">
        تعديل
      </button>
      <button type="button" onClick={onToggleStatus} disabled={busy} className="text-sm text-stone-500 hover:underline">
        {employee.status === "active" ? "إلغاء التنشيط" : "إعادة التنشيط"}
      </button>
    </div>
  );
}
