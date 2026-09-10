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
import { Modal } from "../ui/Modal";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Can } from "../auth/Can";
import { formatDate, formatMoney } from "../lib/format";
import {
  getPayrollPeriod,
  submitPayrollPeriod,
  approvePayrollPeriod,
  rejectPayrollPeriod,
  postPayrollPeriod,
} from "../api/payrollPeriods";
import { createPayrollRecord, updatePayrollRecord } from "../api/payrollRecords";
import { listLaborAllocations } from "../api/laborAllocations";
import { listLaborCostPostings, reverseLaborCostPosting } from "../api/laborCostPostings";
import { listEmployees } from "../api/employees";
import { ApiError } from "../api/client";
import type {
  Employee,
  LaborAllocation,
  LaborCostPosting,
  PayrollPeriodStatus,
  PayrollPeriodWithRecords,
  PayrollRecord,
} from "../api/types";

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
  const [postings, setPostings] = useState<LaborCostPosting[] | null>(null);

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

  function loadPostings() {
    if (!id) return;
    listLaborCostPostings({ payrollPeriodId: id })
      .then(setPostings)
      .catch(() => setPostings([]));
  }
  useEffect(() => {
    if (period?.status === "posted") loadPostings();
  }, [id, period?.status]);

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

  async function onPostPeriod() {
    if (!period) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await postPayrollPeriod(period.id);
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "تعذّر ترحيل تكلفة العمالة");
      throw err;
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
                {period.status === "approved" && (
                  <Can permission="payroll.post">
                    <PostAction period={period} busy={actionBusy} onPost={onPostPeriod} />
                  </Can>
                )}
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

          {period.status === "posted" && (
            <div className="mb-6">
              <PostedSummary period={period} postings={postings} onReversed={loadPostings} />
            </div>
          )}

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

// MIDAD Phase A5 — the "ترحيل تكلفة العمالة" action. Only ever shown for
// an "approved" period to a "payroll.post" holder (both re-checked
// server-side regardless). The pre-confirmation preview is fetched fresh
// when the modal opens and sums the SAME `laborAllocations.amount` the
// server will post — client-side arithmetic for display only, exactly
// LaborAllocation.tsx's own established preview precedent, never the
// number actually recorded (that always comes back from the POST
// response after load() re-fetches the period).
function PostAction({
  period,
  busy,
  onPost,
}: {
  period: PayrollPeriodWithRecords;
  busy: boolean;
  onPost: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [allocations, setAllocations] = useState<LaborAllocation[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  function openPreview() {
    setOpen(true);
    setLoadError(null);
    setAllocations(null);
    listLaborAllocations({ payrollPeriodId: period.id })
      .then(setAllocations)
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "تعذّر تحميل بيانات التوزيع"));
  }

  const totalToPost = allocations ? allocations.reduce((sum, a) => sum + Number(a.amount), 0) : 0;
  const unallocated = allocations ? Math.max(period.summary.totalNet - totalToPost, 0) : 0;
  const projectNames = allocations ? Array.from(new Set(allocations.map((a) => a.project.name))) : [];

  async function onConfirm() {
    setConfirmError(null);
    try {
      await onPost();
      setOpen(false);
    } catch (err) {
      setConfirmError(err instanceof ApiError ? err.message : "تعذّر ترحيل تكلفة العمالة");
    }
  }

  return (
    <>
      <Button size="sm" onClick={openPreview} disabled={busy}>
        ترحيل تكلفة العمالة
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="تأكيد ترحيل تكلفة العمالة" className="mx-4 w-full max-w-lg">
        {loadError && <ErrorState message={loadError} />}
        {!loadError && !allocations && <Skeleton rows={3} />}
        {allocations && (
          <div className="space-y-4">
            <p className="text-sm text-stone-600">
              سيؤدي هذا إلى إنشاء مصروفات فعلية على المشاريع المتأثرة، وستدخل ضمن التكلفة الفعلية لهذه المشاريع فوراً. لا يمكن
              التراجع عن هذا الإجراء إلا عبر عملية عكس منفصلة لكل توزيع على حدة.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <MetricCard label="عدد التوزيعات" value={String(allocations.length)} />
              <MetricCard label="إجمالي المبلغ المرحَّل" value={formatMoney(totalToPost)} tone="success" />
              <MetricCard label="المبلغ غير الموزَّع" value={formatMoney(unallocated)} />
              <MetricCard label="عدد المشاريع المتأثرة" value={String(projectNames.length)} />
            </div>
            {projectNames.length > 0 && (
              <div className="text-sm text-stone-600">
                <span className="font-medium text-stone-700">المشاريع: </span>
                {projectNames.join("، ")}
              </div>
            )}
            {allocations.length === 0 && (
              <p className="text-sm text-danger-600">لا يوجد أي توزيع تكلفة عمالة لترحيله في هذه الفترة.</p>
            )}
            {confirmError && <ErrorState message={confirmError} />}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setOpen(false)} disabled={busy}>
                إلغاء
              </Button>
              <Button size="sm" onClick={onConfirm} disabled={busy || allocations.length === 0}>
                {busy ? "جارٍ الترحيل..." : "تأكيد الترحيل"}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}

// MIDAD Phase A5 — read-only post-posting summary + drill-down, shown once
// a period reaches "posted". `totalPosted` is the NET figure (posting rows
// minus reversal rows, both taken from each row's own linked Expense
// amount — a reversal's Expense is already stored negative), never
// recomputed from labor allocations, since a reversed allocation must not
// silently drop back out of view.
function PostedSummary({
  period,
  postings,
  onReversed,
}: {
  period: PayrollPeriodWithRecords;
  postings: LaborCostPosting[] | null;
  onReversed: () => void;
}) {
  const [reverseTarget, setReverseTarget] = useState<LaborCostPosting | null>(null);
  const [reverseBusy, setReverseBusy] = useState(false);
  const [reverseError, setReverseError] = useState<string | null>(null);

  const reversedPostingIds = new Set((postings ?? []).filter((p) => p.kind === "reversal").map((p) => p.reversalOfPostingId));
  const totalPosted = (postings ?? []).reduce((sum, p) => sum + Number(p.expense?.amount ?? 0), 0);

  async function onConfirmReverse() {
    if (!reverseTarget) return;
    setReverseBusy(true);
    setReverseError(null);
    try {
      await reverseLaborCostPosting(reverseTarget.id);
      setReverseTarget(null);
      onReversed();
    } catch (err) {
      setReverseError(err instanceof ApiError ? err.message : "تعذّر عكس الترحيل");
    } finally {
      setReverseBusy(false);
    }
  }

  const columns: FinancialColumn<LaborCostPosting>[] = [
    { key: "project", header: "المشروع", render: (p) => p.laborAllocation?.project.name ?? "—" },
    { key: "costCode", header: "بند التكلفة", render: (p) => p.laborAllocation?.costCode?.code ?? "—" },
    {
      key: "amount",
      header: "المبلغ",
      render: (p) => formatMoney(p.expense?.amount ?? "0"),
    },
    { key: "kind", header: "النوع", render: (p) => (p.kind === "posting" ? "ترحيل" : "عكس") },
    { key: "date", header: "التاريخ", render: (p) => formatDate(p.postedAt) },
  ];

  return (
    <Card className="p-5">
      <h2 className="mb-3 font-semibold text-stone-800">ترحيل تكلفة العمالة</h2>
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <MetricCard label="الحالة" value="مرحّلة" tone="success" />
        <MetricCard label="تاريخ الترحيل" value={period.postedAt ? formatDate(period.postedAt) : "—"} />
        <MetricCard label="إجمالي المبلغ المرحّل" value={formatMoney(totalPosted)} tone="success" />
      </div>

      {reverseError && (
        <div className="mb-3">
          <ErrorState message={reverseError} />
        </div>
      )}

      {!postings && <Skeleton rows={3} />}
      {postings && (
        <FinancialTable
          columns={columns}
          rows={postings}
          rowKey={(p) => p.id}
          emptyMessage="لا يوجد سجل ترحيل لعرضه"
          rowActions={(p) =>
            p.kind === "posting" && !reversedPostingIds.has(p.id) ? (
              <Can permission="payroll.post">
                <button
                  type="button"
                  onClick={() => setReverseTarget(p)}
                  className="text-sm text-danger-600 hover:underline"
                >
                  عكس
                </button>
              </Can>
            ) : null
          }
        />
      )}

      <ConfirmDialog
        open={reverseTarget !== null}
        title="تأكيد عكس الترحيل"
        message="سيؤدي هذا إلى إنشاء قيد مصروف مقابل بمبلغ سالب يلغي الأثر المالي لهذا الترحيل. لن يتم حذف أو تعديل السجل الأصلي — يبقى محفوظاً في السجل المالي بالكامل."
        confirmLabel={reverseBusy ? "جارٍ العكس..." : "تأكيد العكس"}
        destructive
        onConfirm={onConfirmReverse}
        onCancel={() => setReverseTarget(null)}
      />
    </Card>
  );
}
