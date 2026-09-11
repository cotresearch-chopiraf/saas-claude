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
import { formatMoney } from "../lib/format";
import { getPayrollPeriod } from "../api/payrollPeriods";
import { getPayrollRecord } from "../api/payrollRecords";
import {
  listLaborAllocations,
  createLaborAllocation,
  updateLaborAllocation,
  deleteLaborAllocation,
} from "../api/laborAllocations";
import { listCostCodes } from "../api/costPlan";
import { apiFetch, ApiError } from "../api/client";
import type { CostCode, LaborAllocation, PayrollPeriod, PayrollRecord, Project } from "../api/types";
import { useTranslation } from "../i18n/I18nProvider";

// A period's records/allocations are editable only while draft/rejected —
// mirrors EDITABLE_PERIOD_STATUSES in server/src/routes/payrollPeriods.ts
// exactly. UX convenience only: every mutation route independently
// re-enforces this server-side (see laborAllocations.ts's own lock-under-
// transaction discipline), so a stale client view can never bypass it.
const EDITABLE_STATUSES: PayrollPeriod["status"][] = ["draft", "rejected"];

// MIDAD Phase A4 — Labor Allocation: distribute one payroll record's net
// amount across projects [and optionally cost codes]. This is pre-posting
// internal data — see routes/laborAllocations.ts's own file comment on
// why nothing here ever touches `expenses` or any existing financial
// module. Deliberately minimal per the A4 spec: الموظف → المشروع → كود
// التكلفة → النسبة → القيمة, no database IDs or internal fields shown.
export function LaborAllocation() {
  const { t, locale } = useTranslation();
  const { periodId, recordId } = useParams<{ periodId: string; recordId: string }>();
  const [period, setPeriod] = useState<PayrollPeriod | null>(null);
  const [record, setRecord] = useState<PayrollRecord | null>(null);
  const [allocations, setAllocations] = useState<LaborAllocation[] | null>(null);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  function load() {
    if (!periodId || !recordId) return;
    setError(null);
    setPeriod(null);
    setRecord(null);
    setAllocations(null);
    Promise.all([
      getPayrollPeriod(periodId),
      getPayrollRecord(recordId),
      listLaborAllocations({ payrollRecordId: recordId }),
    ])
      .then(([p, r, a]) => {
        setPeriod(p);
        setRecord(r);
        setAllocations(a);
      })
      .catch((err) => setError(err instanceof Error ? err.message : t("laborAllocationPage.loadError")));
  }
  useEffect(load, [periodId, recordId]);
  useEffect(() => {
    apiFetch<Project[]>("/projects")
      .then(setProjects)
      .catch(() => setProjects([]));
  }, []);

  if (!periodId || !recordId) return null;

  const editable = period ? EDITABLE_STATUSES.includes(period.status) : false;
  const netAmount = record ? Number(record.netAmount) : 0;
  const allocatedTotal = allocations ? allocations.reduce((sum, a) => sum + Number(a.amount), 0) : 0;
  const remaining = Math.max(0, netAmount - allocatedTotal);
  const remainingPercent = allocations ? Math.max(0, 100 - allocations.reduce((sum, a) => sum + Number(a.percentage), 0)) : 100;

  const columns: FinancialColumn<LaborAllocation>[] = [
    { key: "project", header: t("laborAllocationPage.columns.project"), render: (a) => a.project.name },
    { key: "costCode", header: t("laborAllocationPage.columns.costCode"), render: (a) => (a.costCode ? `${a.costCode.code} — ${a.costCode.name}` : "—") },
    { key: "percentage", header: t("laborAllocationPage.columns.percentage"), render: (a) => `${Number(a.percentage)}%` },
    { key: "amount", header: t("laborAllocationPage.columns.amount"), render: (a) => formatMoney(a.amount, undefined, locale) },
  ];

  return (
    <Layout>
      <div className="mb-4">
        <Link to={`/payroll/${periodId}`} className="text-sm text-primary hover:underline">
          {t("laborAllocationPage.backToPayrollPeriod")}
        </Link>
      </div>

      {error && <ErrorState message={error} onRetry={load} />}
      {!error && (!period || !record || !allocations) && <Skeleton rows={6} />}

      {period && record && allocations && (
        <>
          <PageHeader
            title={t("laborAllocationPage.title", { name: record.employee.name })}
            subtitle={t("laborAllocationPage.subtitle", { number: record.employee.employeeNumber })}
            actions={<Badge tone={editable ? "neutral" : "success"}>{editable ? t("laborAllocationPage.editableBadge") : t("laborAllocationPage.lockedBadge")}</Badge>}
          />

          {!editable && (
            <div className="mb-4 rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-sm text-stone-600">
              {t("laborAllocationPage.lockedNotice")}
            </div>
          )}

          <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <MetricCard label={t("laborAllocationPage.metrics.netAmount")} value={formatMoney(netAmount, undefined, locale)} />
            <MetricCard label={t("laborAllocationPage.metrics.allocated")} value={formatMoney(allocatedTotal, undefined, locale)} />
            <MetricCard
              label={t("laborAllocationPage.metrics.unallocated")}
              value={formatMoney(remaining, undefined, locale)}
              tone={remaining > 0 ? "warning" : "success"}
              hint={t("laborAllocationPage.metrics.remainingHint", { percent: remainingPercent })}
            />
          </div>

          {editable && (
            <Can permission="payroll.manage">
              <div className="mb-4">
                <Button size="sm" onClick={() => setShowAdd((v) => !v)}>
                  {showAdd ? t("common.cancel") : t("laborAllocationPage.newAllocation")}
                </Button>
              </div>
              {showAdd && projects && (
                <div className="mb-6">
                  <AllocationForm
                    recordId={recordId}
                    projects={projects}
                    netAmount={netAmount}
                    remainingPercent={remainingPercent}
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
            rows={allocations}
            rowKey={(a) => a.id}
            emptyMessage={t("laborAllocationPage.emptyMessage")}
            rowActions={
              editable
                ? (a) => (
                    <Can permission="payroll.manage">
                      <AllocationRowActions allocation={a} netAmount={netAmount} remainingPercent={remainingPercent} onChanged={load} />
                    </Can>
                  )
                : undefined
            }
          />
        </>
      )}
    </Layout>
  );
}

function AllocationForm({
  recordId,
  projects,
  netAmount,
  remainingPercent,
  onCreated,
}: {
  recordId: string;
  projects: Project[];
  netAmount: number;
  remainingPercent: number;
  onCreated: () => void;
}) {
  const { t, locale } = useTranslation();
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [costCodeId, setCostCodeId] = useState("");
  const [costCodes, setCostCodes] = useState<CostCode[]>([]);
  const [percentage, setPercentage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!projectId) return;
    setCostCodeId("");
    listCostCodes(projectId)
      .then(setCostCodes)
      .catch(() => setCostCodes([]));
  }, [projectId]);

  const previewAmount = (netAmount * (Number(percentage) || 0)) / 100;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!projectId) {
      setError(t("laborAllocationPage.form.selectProjectError"));
      return;
    }
    setSubmitting(true);
    try {
      await createLaborAllocation({
        payrollRecordId: recordId,
        projectId,
        costCodeId: costCodeId || undefined,
        percentage: Number(percentage),
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("laborAllocationPage.form.genericError"));
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
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <select
          value={costCodeId}
          onChange={(e) => setCostCodeId(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        >
          <option value="">{t("laborAllocationPage.form.noCostCode")}</option>
          {costCodes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.code} — {c.name}
            </option>
          ))}
        </select>
        <input
          required
          type="number"
          min="0.01"
          max="100"
          step="0.01"
          placeholder={t("laborAllocationPage.form.percentagePlaceholder", { percent: remainingPercent })}
          value={percentage}
          onChange={(e) => setPercentage(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <div className="flex items-center justify-between rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-sm">
          <span className="text-stone-500">{t("laborAllocationPage.form.amountLabel")}</span>
          <span className="font-medium text-stone-800">{formatMoney(previewAmount, undefined, locale)}</span>
        </div>
        <Button type="submit" disabled={submitting} className="sm:col-span-4">
          {submitting ? t("laborAllocationPage.form.saving") : t("laborAllocationPage.form.save")}
        </Button>
      </form>
    </Card>
  );
}

function AllocationRowActions({
  allocation,
  netAmount,
  remainingPercent,
  onChanged,
}: {
  allocation: LaborAllocation;
  netAmount: number;
  remainingPercent: number;
  onChanged: () => void;
}) {
  const { t, locale } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [percentage, setPercentage] = useState(allocation.percentage);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ownRemainingPercent = useMemo(() => remainingPercent + Number(allocation.percentage), [remainingPercent, allocation.percentage]);

  async function onSave() {
    setBusy(true);
    setError(null);
    try {
      await updateLaborAllocation(allocation.id, { percentage: Number(percentage) });
      setEditing(false);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("laborAllocationPage.rowActions.saveError"));
    } finally {
      setBusy(false);
    }
  }

  async function onDelete() {
    setBusy(true);
    setError(null);
    try {
      await deleteLaborAllocation(allocation.id);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("laborAllocationPage.rowActions.deleteError"));
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <div className="flex flex-col items-end gap-1">
        {error && <span className="text-xs text-danger-600">{error}</span>}
        <div className="flex flex-wrap items-center justify-end gap-1">
          <input
            type="number"
            min="0.01"
            max="100"
            step="0.01"
            value={percentage}
            onChange={(e) => setPercentage(e.target.value)}
            className="w-20 rounded-md border border-stone-300 px-2 py-1 text-xs"
          />
          <span className="text-xs text-stone-400">{t("laborAllocationPage.rowActions.upToPercent", { percent: ownRemainingPercent })}</span>
          <span className="text-xs text-stone-500">{formatMoney((netAmount * (Number(percentage) || 0)) / 100, undefined, locale)}</span>
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
        {t("laborAllocationPage.rowActions.edit")}
      </button>
      <button type="button" onClick={onDelete} disabled={busy} className="text-sm text-danger-600 hover:underline">
        {t("common.delete")}
      </button>
    </div>
  );
}
