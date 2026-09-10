import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { PageHeader } from "../ui/PageHeader";
import { Card } from "../ui/Card";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { MetricCard } from "../ui/MetricCard";
import { FinancialTable, type FinancialColumn } from "../ui/FinancialTable";
import { ErrorState } from "../ui/ErrorState";
import { Skeleton } from "../ui/Skeleton";
import { Can } from "../auth/Can";
import { formatDate, formatMoney } from "../lib/format";
import {
  getPayrollPeriod,
  submitPayrollPeriod,
  approvePayrollPeriod,
  rejectPayrollPeriod,
} from "../api/payrollPeriods";
import { createPayrollRecord, updatePayrollRecord } from "../api/payrollRecords";
import { listEmployees } from "../api/employees";
import { ApiError } from "../api/client";
import type { Employee, PayrollPeriodStatus, PayrollPeriodWithRecords, PayrollRecord } from "../api/types";

const statusLabel: Record<PayrollPeriodStatus, string> = {
  draft: "مسودة",
  submitted: "بانتظار الاعتماد",
  approved: "معتمدة",
  posted: "مرحّلة",
  rejected: "مرفوضة",
};
const statusTone: Record<PayrollPeriodStatus, "neutral" | "warning" | "success" | "danger"> = {
  draft: "neutral",
  submitted: "warning",
  approved: "success",
  posted: "success",
  rejected: "danger",
};

// A period's records are editable only while draft/rejected — mirrors
// EDITABLE_PERIOD_STATUSES in server/src/routes/payrollPeriods.ts exactly.
// This is a UX convenience only: every mutation route independently
// re-enforces this server-side, so a stale client view can never bypass it
// (see payrollRecords.ts's own lock-under-transaction discipline).
const EDITABLE_STATUSES: PayrollPeriodStatus[] = ["draft", "rejected"];

// MIDAD Phase A3 — Payroll Period detail: records, summary totals, and the
// draft -> submitted -> approved/rejected lifecycle. This is INTERNAL
// payroll data (see payrollPeriods.ts's own file comment) — the page never
// claims an official Mudad/WPS submission or bank confirmation. Payroll
// records have no status of their own; editability is governed entirely by
// this period's status.
export function PayrollPeriodDetail() {
  const { id } = useParams<{ id: string }>();
  const [period, setPeriod] = useState<PayrollPeriodWithRecords | null>(null);
  const [employees, setEmployees] = useState<Employee[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  function load() {
    if (!id) return;
    setError(null);
    setPeriod(null);
    getPayrollPeriod(id)
      .then(setPeriod)
      .catch((err) => setError(err instanceof Error ? err.message : "تعذّر تحميل فترة الرواتب"));
  }
  useEffect(load, [id]);
  useEffect(() => {
    listEmployees()
      .then(setEmployees)
      .catch(() => setEmployees([]));
  }, []);

  if (!id) return null;

  const editable = period ? EDITABLE_STATUSES.includes(period.status) : false;

  async function onSubmitPeriod() {
    if (!period) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await submitPayrollPeriod(period.id);
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "تعذّر إرسال الفترة");
    } finally {
      setActionBusy(false);
    }
  }

  async function onApprovePeriod() {
    if (!period) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await approvePayrollPeriod(period.id);
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "تعذّر اعتماد الفترة");
    } finally {
      setActionBusy(false);
    }
  }

  async function onRejectPeriod() {
    if (!period) return;
    const reason = window.prompt("سبب الرفض:");
    if (!reason) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await rejectPayrollPeriod(period.id, reason);
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "تعذّر رفض الفترة");
    } finally {
      setActionBusy(false);
    }
  }

  const columns: FinancialColumn<PayrollRecord>[] = [
    { key: "employee", header: "الموظف", render: (r) => r.employee.name },
    { key: "employeeNumber", header: "الرقم", render: (r) => r.employee.employeeNumber },
    { key: "grossAmount", header: "الأساسي", render: (r) => formatMoney(r.grossAmount) },
    { key: "deductionsAmount", header: "الخصومات", render: (r) => formatMoney(r.deductionsAmount) },
    { key: "netAmount", header: "الصافي", render: (r) => formatMoney(r.netAmount) },
  ];

  return (
    <Layout>
      <div className="mb-4">
        <Link to="/payroll" className="text-sm text-primary hover:underline">
          العودة إلى الرواتب
        </Link>
      </div>

      {error && <ErrorState message={error} onRetry={load} />}
      {!error && !period && <Skeleton rows={6} />}

      {period && (
        <>
          <PageHeader
            title={`رواتب ${formatDate(period.periodStart)} – ${formatDate(period.periodEnd)}`}
            subtitle="سجل الرواتب الداخلي لهذه الفترة."
            actions={
              <div className="flex items-center gap-2">
                <Badge tone={statusTone[period.status]}>{statusLabel[period.status]}</Badge>
                <Can permission="payroll.manage">
                  {period.status === "draft" || period.status === "rejected" ? (
                    <Button size="sm" onClick={onSubmitPeriod} disabled={actionBusy}>
                      إرسال للاعتماد
                    </Button>
                  ) : null}
                  {period.status === "submitted" ? (
                    <>
                      <Button size="sm" onClick={onApprovePeriod} disabled={actionBusy}>
                        اعتماد
                      </Button>
                      <Button size="sm" variant="secondary" onClick={onRejectPeriod} disabled={actionBusy}>
                        رفض
                      </Button>
                    </>
                  ) : null}
                </Can>
              </div>
            }
          />

          {actionError && (
            <div className="mb-4">
              <ErrorState message={actionError} />
            </div>
          )}

          {period.status === "rejected" && period.rejectionReason && (
            <div className="mb-4 rounded-md border border-danger-200 bg-danger-50 px-3 py-2 text-sm text-danger-700">
              سبب الرفض: {period.rejectionReason}
            </div>
          )}

          {!editable && (
            <div className="mb-4 rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-sm text-stone-600">
              لا يمكن تعديل سجلات هذه الفترة — تم إرسالها أو اعتمادها بالفعل.
            </div>
          )}

          <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-4">
            <MetricCard label="عدد الموظفين" value={String(period.summary.employeeCount)} />
            <MetricCard label="إجمالي الأساسي" value={formatMoney(period.summary.totalGross)} />
            <MetricCard label="إجمالي الخصومات" value={formatMoney(period.summary.totalDeductions)} />
            <MetricCard label="صافي الرواتب" value={formatMoney(period.summary.totalNet)} tone="success" />
          </div>

          {editable && (
            <Can permission="payroll.manage">
              <div className="mb-4">
                <Button size="sm" onClick={() => setShowAdd((v) => !v)}>
                  {showAdd ? "إلغاء" : "+ إضافة سجل راتب"}
                </Button>
              </div>
              {showAdd && employees && (
                <div className="mb-6">
                  <AddRecordForm
                    periodId={period.id}
                    employees={employees}
                    existingEmployeeIds={period.records.map((r) => r.employeeId)}
                    onCreated={() => {
                      setShowAdd(false);
                      load();
                    }}
                  />
                </div>
              )}
            </Can>
          )}

          <FinancialTable
            columns={columns}
            rows={period.records}
            rowKey={(r) => r.id}
            emptyMessage="لا توجد سجلات رواتب في هذه الفترة بعد"
            rowActions={(r) => (
              <div className="flex justify-end gap-3">
                <Link to={`/payroll/${period.id}/records/${r.id}/allocate`} className="text-sm text-primary hover:underline">
                  توزيع
                </Link>
                {editable && (
                  <Can permission="payroll.manage">
                    <RecordRowActions record={r} onChanged={load} />
                  </Can>
                )}
              </div>
            )}
          />
        </>
      )}
    </Layout>
  );
}

function AddRecordForm({
  periodId,
  employees,
  existingEmployeeIds,
  onCreated,
}: {
  periodId: string;
  employees: Employee[];
  existingEmployeeIds: string[];
  onCreated: () => void;
}) {
  const available = useMemo(
    () => employees.filter((e) => !existingEmployeeIds.includes(e.id)),
    [employees, existingEmployeeIds],
  );
  const [employeeId, setEmployeeId] = useState(available[0]?.id ?? "");
  const [grossAmount, setGrossAmount] = useState("");
  const [deductionsAmount, setDeductionsAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const gross = Number(grossAmount) || 0;
  const deductions = Number(deductionsAmount) || 0;
  const netPreview = gross - deductions;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!employeeId) {
      setError("اختر الموظف");
      return;
    }
    setSubmitting(true);
    try {
      await createPayrollRecord({
        payrollPeriodId: periodId,
        employeeId,
        grossAmount: gross,
        deductionsAmount: deductions || undefined,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر إضافة سجل الراتب");
    } finally {
      setSubmitting(false);
    }
  }

  if (available.length === 0) {
    return (
      <Card className="p-5">
        <p className="text-sm text-stone-500">تمت إضافة جميع الموظفين إلى هذه الفترة بالفعل.</p>
      </Card>
    );
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
          value={employeeId}
          onChange={(e) => setEmployeeId(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        >
          {available.map((emp) => (
            <option key={emp.id} value={emp.id}>
              {emp.name} ({emp.employeeNumber})
            </option>
          ))}
        </select>
        <input
          required
          type="number"
          min="0"
          step="0.01"
          placeholder="الأساسي"
          value={grossAmount}
          onChange={(e) => setGrossAmount(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <input
          type="number"
          min="0"
          step="0.01"
          placeholder="الخصومات (اختياري)"
          value={deductionsAmount}
          onChange={(e) => setDeductionsAmount(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <div className="flex items-center justify-between rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-sm">
          <span className="text-stone-500">الصافي</span>
          <span className="font-medium text-stone-800">{formatMoney(netPreview)}</span>
        </div>
        <Button type="submit" disabled={submitting} className="sm:col-span-4">
          {submitting ? "جارٍ الحفظ..." : "حفظ السجل"}
        </Button>
      </form>
    </Card>
  );
}

function RecordRowActions({ record, onChanged }: { record: PayrollRecord; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [grossAmount, setGrossAmount] = useState(record.grossAmount);
  const [deductionsAmount, setDeductionsAmount] = useState(record.deductionsAmount);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSave() {
    setBusy(true);
    setError(null);
    try {
      await updatePayrollRecord(record.id, {
        grossAmount: Number(grossAmount),
        deductionsAmount: Number(deductionsAmount),
      });
      setEditing(false);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر حفظ التعديل");
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <div className="flex flex-col items-end gap-1">
        {error && <span className="text-xs text-danger-600">{error}</span>}
        <div className="flex flex-wrap justify-end gap-1">
          <input
            type="number"
            min="0"
            step="0.01"
            value={grossAmount}
            onChange={(e) => setGrossAmount(e.target.value)}
            className="w-24 rounded-md border border-stone-300 px-2 py-1 text-xs"
          />
          <input
            type="number"
            min="0"
            step="0.01"
            value={deductionsAmount}
            onChange={(e) => setDeductionsAmount(e.target.value)}
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
    </div>
  );
}
