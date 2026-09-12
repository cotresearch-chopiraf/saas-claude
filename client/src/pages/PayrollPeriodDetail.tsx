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
import { useTranslation } from "../i18n/I18nProvider";

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
  const { t, locale } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const [period, setPeriod] = useState<PayrollPeriodWithRecords | null>(null);
  const [employees, setEmployees] = useState<Employee[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [postings, setPostings] = useState<LaborCostPosting[] | null>(null);
  const [showRejectModal, setShowRejectModal] = useState(false);

  function load() {
    if (!id) return;
    setError(null);
    setPeriod(null);
    getPayrollPeriod(id)
      .then(setPeriod)
      .catch((err) => setError(err instanceof Error ? err.message : t("payrollPeriodDetailPage.loadError")));
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
      setActionError(err instanceof ApiError ? err.message : t("payrollPeriodDetailPage.submitError"));
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
      setActionError(err instanceof ApiError ? err.message : t("payrollPeriodDetailPage.approveError"));
    } finally {
      setActionBusy(false);
    }
  }

  async function onRejectPeriod(reason: string) {
    if (!period) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await rejectPayrollPeriod(period.id, reason);
      setShowRejectModal(false);
      load();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t("payrollPeriodDetailPage.rejectError"));
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
      setActionError(err instanceof ApiError ? err.message : t("payrollPeriodDetailPage.postError"));
      throw err;
    } finally {
      setActionBusy(false);
    }
  }

  const columns: FinancialColumn<PayrollRecord>[] = [
    { key: "employee", header: t("payrollPeriodDetailPage.columns.employee"), render: (r) => r.employee.name },
    { key: "employeeNumber", header: t("payrollPeriodDetailPage.columns.employeeNumber"), render: (r) => r.employee.employeeNumber },
    { key: "grossAmount", header: t("payrollPeriodDetailPage.columns.grossAmount"), render: (r) => formatMoney(r.grossAmount, undefined, locale) },
    { key: "deductionsAmount", header: t("payrollPeriodDetailPage.columns.deductionsAmount"), render: (r) => formatMoney(r.deductionsAmount, undefined, locale) },
    { key: "netAmount", header: t("payrollPeriodDetailPage.columns.netAmount"), render: (r) => formatMoney(r.netAmount, undefined, locale) },
  ];

  return (
    <Layout>
      <div className="mb-4">
        <Link to="/payroll" className="text-sm text-primary hover:underline">
          {t("payrollPeriodDetailPage.backToPayroll")}
        </Link>
      </div>

      {error && <ErrorState message={error} onRetry={load} />}
      {!error && !period && <Skeleton rows={6} />}

      {period && (
        <>
          <PageHeader
            title={t("payrollPeriodDetailPage.title", { start: formatDate(period.periodStart, locale), end: formatDate(period.periodEnd, locale) })}
            subtitle={t("payrollPeriodDetailPage.subtitle")}
            actions={
              <div className="flex items-center gap-2">
                <Badge tone={statusTone[period.status]}>{t(`payrollPage.status.${period.status}`)}</Badge>
                <Can permission="payroll.manage">
                  {period.status === "draft" || period.status === "rejected" ? (
                    <Button size="sm" onClick={onSubmitPeriod} disabled={actionBusy}>
                      {t("payrollPeriodDetailPage.submitForApproval")}
                    </Button>
                  ) : null}
                  {period.status === "submitted" ? (
                    <>
                      <Button size="sm" onClick={onApprovePeriod} disabled={actionBusy}>
                        {t("payrollPeriodDetailPage.approve")}
                      </Button>
                      <Button size="sm" variant="secondary" onClick={() => setShowRejectModal(true)} disabled={actionBusy}>
                        {t("payrollPeriodDetailPage.reject")}
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
              {t("payrollPeriodDetailPage.rejectionReasonLabel", { reason: period.rejectionReason })}
            </div>
          )}

          {!editable && (
            <div className="mb-4 rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-sm text-stone-600">
              {t("payrollPeriodDetailPage.notEditableNotice")}
            </div>
          )}

          <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-4">
            <MetricCard label={t("payrollPeriodDetailPage.metrics.employeeCount")} value={String(period.summary.employeeCount)} />
            <MetricCard label={t("payrollPeriodDetailPage.metrics.totalGross")} value={formatMoney(period.summary.totalGross, undefined, locale)} />
            <MetricCard label={t("payrollPeriodDetailPage.metrics.totalDeductions")} value={formatMoney(period.summary.totalDeductions, undefined, locale)} />
            <MetricCard label={t("payrollPeriodDetailPage.metrics.totalNet")} value={formatMoney(period.summary.totalNet, undefined, locale)} tone="success" />
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
                  {showAdd ? t("common.cancel") : t("payrollPeriodDetailPage.addRecord")}
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
            emptyMessage={t("payrollPeriodDetailPage.recordsEmptyMessage")}
            rowActions={(r) => (
              <div className="flex justify-end gap-3">
                <Link to={`/payroll/${period.id}/records/${r.id}/allocate`} className="text-sm text-primary hover:underline">
                  {t("payrollPeriodDetailPage.allocateLink")}
                </Link>
                {editable && (
                  <Can permission="payroll.manage">
                    <RecordRowActions record={r} onChanged={load} />
                  </Can>
                )}
              </div>
            )}
          />

          <RejectPeriodModal
            open={showRejectModal}
            busy={actionBusy}
            onClose={() => setShowRejectModal(false)}
            onReject={onRejectPeriod}
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
  const { t, locale } = useTranslation();
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
      setError(t("payrollPeriodDetailPage.form.selectEmployeeError"));
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
      setError(err instanceof ApiError ? err.message : t("payrollPeriodDetailPage.form.genericError"));
    } finally {
      setSubmitting(false);
    }
  }

  if (available.length === 0) {
    return (
      <Card className="p-5">
        <p className="text-sm text-stone-500">{t("payrollPeriodDetailPage.form.allEmployeesAdded")}</p>
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
          placeholder={t("payrollPeriodDetailPage.form.grossPlaceholder")}
          value={grossAmount}
          onChange={(e) => setGrossAmount(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <input
          type="number"
          min="0"
          step="0.01"
          placeholder={t("payrollPeriodDetailPage.form.deductionsPlaceholder")}
          value={deductionsAmount}
          onChange={(e) => setDeductionsAmount(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <div className="flex items-center justify-between rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-sm">
          <span className="text-stone-500">{t("payrollPeriodDetailPage.form.netLabel")}</span>
          <span className="font-medium text-stone-800">{formatMoney(netPreview, undefined, locale)}</span>
        </div>
        <Button type="submit" disabled={submitting} className="sm:col-span-4">
          {submitting ? t("payrollPeriodDetailPage.form.saving") : t("payrollPeriodDetailPage.form.save")}
        </Button>
      </form>
    </Card>
  );
}

function RecordRowActions({ record, onChanged }: { record: PayrollRecord; onChanged: () => void }) {
  const { t } = useTranslation();
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
      setError(err instanceof ApiError ? err.message : t("payrollPeriodDetailPage.rowActions.saveError"));
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
        {t("common.edit")}
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
// Phase F.2 — replaces a native window.prompt() with the same in-app
// reject-reason pattern already established by ProgressSection.tsx's own
// RejectForm (a required textarea inside a real dialog, with its own
// error/disabled/busy states) — window.prompt has no error display, no
// cancel styling, and blocks the render thread.
function RejectPeriodModal({
  open,
  busy,
  onClose,
  onReject,
}: {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onReject: (reason: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!reason.trim()) return;
    onReject(reason);
  }

  return (
    <Modal open={open} onClose={onClose} title={t("payrollPeriodDetailPage.rejectModal.title")} className="mx-4 w-full max-w-md">
      <form onSubmit={handleSubmit} className="space-y-3">
        <textarea
          required
          placeholder={t("payrollPeriodDetailPage.rejectModal.reasonPlaceholder")}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
          rows={3}
        />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" size="sm" variant="danger" disabled={busy || !reason.trim()}>
            {busy ? t("payrollPeriodDetailPage.rejectModal.rejecting") : t("payrollPeriodDetailPage.rejectModal.confirm")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function PostAction({
  period,
  busy,
  onPost,
}: {
  period: PayrollPeriodWithRecords;
  busy: boolean;
  onPost: () => Promise<void>;
}) {
  const { t, locale } = useTranslation();
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
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : t("payrollPeriodDetailPage.postAction.loadError")));
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
      setConfirmError(err instanceof ApiError ? err.message : t("payrollPeriodDetailPage.postError"));
    }
  }

  return (
    <>
      <Button size="sm" onClick={openPreview} disabled={busy}>
        {t("payrollPeriodDetailPage.postAction.trigger")}
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title={t("payrollPeriodDetailPage.postAction.modalTitle")} className="mx-4 w-full max-w-lg">
        {loadError && <ErrorState message={loadError} />}
        {!loadError && !allocations && <Skeleton rows={3} />}
        {allocations && (
          <div className="space-y-4">
            <p className="text-sm text-stone-600">{t("payrollPeriodDetailPage.postAction.warning")}</p>
            <div className="grid grid-cols-2 gap-3">
              <MetricCard label={t("payrollPeriodDetailPage.postAction.metrics.allocationCount")} value={String(allocations.length)} />
              <MetricCard label={t("payrollPeriodDetailPage.postAction.metrics.totalAmount")} value={formatMoney(totalToPost, undefined, locale)} tone="success" />
              <MetricCard label={t("payrollPeriodDetailPage.postAction.metrics.unallocated")} value={formatMoney(unallocated, undefined, locale)} />
              <MetricCard label={t("payrollPeriodDetailPage.postAction.metrics.projectCount")} value={String(projectNames.length)} />
            </div>
            {projectNames.length > 0 && (
              <div className="text-sm text-stone-600">
                <span className="font-medium text-stone-700">{t("payrollPeriodDetailPage.postAction.projectsLabel")}</span>
                {projectNames.join(t("payrollPeriodDetailPage.postAction.listSeparator"))}
              </div>
            )}
            {allocations.length === 0 && (
              <p className="text-sm text-danger-600">{t("payrollPeriodDetailPage.postAction.noAllocations")}</p>
            )}
            {confirmError && <ErrorState message={confirmError} />}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => setOpen(false)} disabled={busy}>
                {t("common.cancel")}
              </Button>
              <Button size="sm" onClick={onConfirm} disabled={busy || allocations.length === 0}>
                {busy ? t("payrollPeriodDetailPage.postAction.posting") : t("payrollPeriodDetailPage.postAction.confirm")}
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
  const { t, locale } = useTranslation();
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
      setReverseError(err instanceof ApiError ? err.message : t("payrollPeriodDetailPage.postedSummary.reverseError"));
    } finally {
      setReverseBusy(false);
    }
  }

  const columns: FinancialColumn<LaborCostPosting>[] = [
    { key: "project", header: t("payrollPeriodDetailPage.postedSummary.columns.project"), render: (p) => p.laborAllocation?.project.name ?? "—" },
    { key: "costCode", header: t("payrollPeriodDetailPage.postedSummary.columns.costCode"), render: (p) => p.laborAllocation?.costCode?.code ?? "—" },
    {
      key: "amount",
      header: t("payrollPeriodDetailPage.postedSummary.columns.amount"),
      render: (p) => formatMoney(p.expense?.amount ?? "0", undefined, locale),
    },
    { key: "kind", header: t("payrollPeriodDetailPage.postedSummary.columns.kind"), render: (p) => t(`payrollPeriodDetailPage.postedSummary.kind.${p.kind === "posting" ? "posting" : "reversal"}`) },
    { key: "date", header: t("payrollPeriodDetailPage.postedSummary.columns.date"), render: (p) => formatDate(p.postedAt, locale) },
  ];

  return (
    <Card className="p-5">
      <h2 className="mb-3 font-semibold text-stone-800">{t("payrollPeriodDetailPage.postAction.trigger")}</h2>
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <MetricCard label={t("payrollPeriodDetailPage.postedSummary.metrics.status")} value={t("payrollPage.status.posted")} tone="success" />
        <MetricCard label={t("payrollPeriodDetailPage.postedSummary.metrics.postedDate")} value={period.postedAt ? formatDate(period.postedAt, locale) : "—"} />
        <MetricCard label={t("payrollPeriodDetailPage.postedSummary.metrics.totalPosted")} value={formatMoney(totalPosted, undefined, locale)} tone="success" />
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
          emptyMessage={t("payrollPeriodDetailPage.postedSummary.emptyMessage")}
          rowActions={(p) =>
            p.kind === "posting" && !reversedPostingIds.has(p.id) ? (
              <Can permission="payroll.post">
                <button
                  type="button"
                  onClick={() => setReverseTarget(p)}
                  className="text-sm text-danger-600 hover:underline"
                >
                  {t("payrollPeriodDetailPage.postedSummary.reverseAction")}
                </button>
              </Can>
            ) : null
          }
        />
      )}

      <ConfirmDialog
        open={reverseTarget !== null}
        title={t("payrollPeriodDetailPage.postedSummary.reverseConfirm.title")}
        message={t("payrollPeriodDetailPage.postedSummary.reverseConfirm.message")}
        confirmLabel={reverseBusy ? t("payrollPeriodDetailPage.postedSummary.reverseConfirm.reversing") : t("payrollPeriodDetailPage.postedSummary.reverseConfirm.confirm")}
        destructive
        onConfirm={onConfirmReverse}
        onCancel={() => setReverseTarget(null)}
      />
    </Card>
  );
}
