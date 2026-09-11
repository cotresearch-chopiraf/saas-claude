import { useEffect, useState, type FormEvent } from "react";
import { PageHeader } from "../../ui/PageHeader";
import { Card } from "../../ui/Card";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { Tabs } from "../../ui/Tabs";
import { MetricCard } from "../../ui/MetricCard";
import { FinancialTable, type FinancialColumn } from "../../ui/FinancialTable";
import { ErrorState } from "../../ui/ErrorState";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Skeleton } from "../../ui/Skeleton";
import { Can } from "../../auth/Can";
import { formatMoney, formatDate } from "../../lib/format";
import {
  getBudget,
  createBudgetItem,
  updateBudgetItem,
  deleteBudgetItem,
  listCostCodes,
  listBudgetRevisions,
  getBudgetRevision,
  createBudgetRevision,
  approveBudgetRevision,
  assignBudgetItemToRevision,
} from "../../api/costPlan";
import { ApiError } from "../../api/client";
import type { BudgetItem, BudgetRevision, BudgetRevisionStatus, BudgetRevisionWithItems, BudgetSummary, CostCode } from "../../api/types";
import { useProjectContext } from "../context";
import { useTranslation } from "../../i18n/I18nProvider";

const revisionStatusTone: Record<BudgetRevisionStatus, "neutral" | "success" | "warning"> = {
  draft: "warning",
  approved: "success",
  superseded: "neutral",
};

export function CostPlanSection() {
  const { t } = useTranslation();
  const { projectId } = useProjectContext();
  const [activeTab, setActiveTab] = useState<"plan" | "revisions">("plan");

  return (
    <div className="space-y-6">
      <PageHeader title={t("costPlan.title")} />
      <Tabs
        items={[
          { key: "plan", label: t("costPlan.tabs.plan") },
          { key: "revisions", label: t("costPlan.tabs.revisions") },
        ]}
        active={activeTab}
        onChange={(key) => setActiveTab(key as "plan" | "revisions")}
      />
      {activeTab === "plan" ? <PlanTab projectId={projectId} /> : <RevisionsTab projectId={projectId} />}
    </div>
  );
}

// --- Plan tab -------------------------------------------------------------

function PlanTab({ projectId }: { projectId: string }) {
  const { t, locale } = useTranslation();
  const [summary, setSummary] = useState<BudgetSummary | null>(null);
  const [costCodes, setCostCodes] = useState<CostCode[]>([]);
  const [revisions, setRevisions] = useState<BudgetRevision[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [costCodeFilter, setCostCodeFilter] = useState<string>("");

  function load() {
    setError(null);
    setSummary(null);
    Promise.all([getBudget(projectId), listCostCodes(projectId), listBudgetRevisions(projectId)])
      .then(([budget, codes, revs]) => {
        setSummary(budget);
        setCostCodes(codes);
        setRevisions(revs);
      })
      .catch((err) => setError(err instanceof Error ? err.message : t("costPlan.loadError")));
  }
  useEffect(load, [projectId]);

  const costCodeLabel = (id: string | null) => {
    if (!id) return "—";
    const c = costCodes.find((x) => x.id === id);
    return c ? `${c.code} — ${c.name}` : "—";
  };
  const revisionLabel = (id: string | null) => {
    if (!id) return "—";
    const r = revisions.find((x) => x.id === id);
    return r ? `#${r.revisionNumber}` : "—";
  };

  if (error && !summary) return <ErrorState message={error} onRetry={load} />;
  if (!summary) return <Skeleton rows={6} />;

  // Grouping is presentation-only filtering of already-loaded rows — it
  // never recomputes or aggregates a financial figure; the totals below
  // always come from the backend's own `totals`, regardless of the filter.
  const visibleItems = costCodeFilter ? summary.items.filter((i) => i.costCodeId === costCodeFilter) : summary.items;

  const columns: FinancialColumn<BudgetItem>[] = [
    { key: "category", header: t("costPlan.columns.category"), render: (i) => i.category },
    { key: "costCode", header: t("costPlan.columns.costCode"), render: (i) => costCodeLabel(i.costCodeId) },
    { key: "planned", header: t("costPlan.columns.planned"), align: "end", render: (i) => formatMoney(i.plannedAmount, "SAR", locale) },
    { key: "spent", header: t("costPlan.columns.spent"), align: "end", render: (i) => formatMoney(i.spent, "SAR", locale) },
    { key: "boq", header: t("costPlan.columns.boq"), render: (i) => (i.boqItemId ? t("costPlan.columns.boqLinked") : "—") },
    { key: "revision", header: t("costPlan.columns.revision"), render: (i) => revisionLabel(i.budgetRevisionId) },
  ];

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <MetricCard label={t("costPlan.metrics.totalPlanned")} value={formatMoney(summary.totals.planned, "SAR", locale)} />
        <MetricCard label={t("costPlan.metrics.totalSpent")} value={formatMoney(summary.totals.spent, "SAR", locale)} />
        <MetricCard
          label={summary.totals.remaining < 0 ? t("costPlan.metrics.overBudget") : t("costPlan.metrics.remaining")}
          value={formatMoney(Math.abs(summary.totals.remaining), "SAR", locale)}
          tone={summary.totals.remaining < 0 ? "danger" : "default"}
        />
      </div>

      {costCodes.length > 0 && (
        <div className="flex items-center gap-2">
          <label className="text-sm text-stone-500">{t("costPlan.filterByCostCode")}</label>
          <select
            value={costCodeFilter}
            onChange={(e) => setCostCodeFilter(e.target.value)}
            className="rounded-md border border-stone-300 px-3 py-2 text-sm"
          >
            <option value="">{t("costPlan.all")}</option>
            {costCodes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} — {c.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {error && <ErrorState message={error} onRetry={load} />}

      {/* Final Pre-Launch Audit — POST/PATCH/DELETE /budget/items are now
          owner-gated server-side (budget.manage), matching every sibling
          financial domain; mirrored here so a member sees the same controls
          the backend would actually allow. */}
      <Can permission="budget.manage">
        <BudgetItemForm projectId={projectId} onSaved={load} />
      </Can>

      <FinancialTable
        columns={columns}
        rows={visibleItems}
        rowKey={(i) => i.id}
        emptyMessage={t("costPlan.emptyItems")}
        rowActions={(i) => <BudgetItemRowActions projectId={projectId} item={i} onChanged={load} />}
      />
    </div>
  );
}

function BudgetItemForm({ projectId, onSaved }: { projectId: string; onSaved: () => void }) {
  const { t } = useTranslation();
  const [category, setCategory] = useState("");
  const [plannedAmount, setPlannedAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await createBudgetItem(projectId, { category, plannedAmount: Number(plannedAmount) });
      setCategory("");
      setPlannedAmount("");
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("costPlan.itemForm.genericError"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="p-4">
      <form onSubmit={onSubmit} className="flex flex-wrap gap-2">
        {error && (
          <div className="w-full">
            <ErrorState message={error} />
          </div>
        )}
        <input
          required
          placeholder={t("costPlan.itemForm.namePlaceholder")}
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="flex-1 rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <input
          required
          type="number"
          min="0"
          step="0.01"
          placeholder={t("costPlan.itemForm.plannedAmountPlaceholder")}
          value={plannedAmount}
          onChange={(e) => setPlannedAmount(e.target.value)}
          className="w-40 rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <Button type="submit" size="sm" disabled={submitting}>
          {submitting ? t("costPlan.itemForm.saving") : t("costPlan.itemForm.addItem")}
        </Button>
      </form>
    </Card>
  );
}

function BudgetItemRowActions({ projectId, item, onChanged }: { projectId: string; item: BudgetItem; onChanged: () => void }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [category, setCategory] = useState(item.category);
  const [plannedAmount, setPlannedAmount] = useState(item.plannedAmount);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSave() {
    setBusy(true);
    setError(null);
    try {
      await updateBudgetItem(projectId, item.id, { category, plannedAmount: Number(plannedAmount) });
      setEditing(false);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("costPlan.rowActions.saveError"));
    } finally {
      setBusy(false);
    }
  }

  async function onDelete() {
    setBusy(true);
    try {
      await deleteBudgetItem(projectId, item.id);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("costPlan.rowActions.deleteError"));
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <div className="flex flex-col items-end gap-1">
        {error && <span className="text-xs text-danger-600">{error}</span>}
        <div className="flex gap-1">
          <input
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-28 rounded-md border border-stone-300 px-2 py-1 text-xs"
          />
          <input
            type="number"
            min="0"
            step="0.01"
            value={plannedAmount}
            onChange={(e) => setPlannedAmount(e.target.value)}
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
    <Can permission="budget.manage">
      <div className="flex justify-end gap-3">
        <button type="button" onClick={() => setEditing(true)} className="text-sm text-primary hover:underline">
          {t("common.edit")}
        </button>
        <button type="button" onClick={onDelete} disabled={busy} className="text-sm text-danger-600 hover:underline">
          {t("common.delete")}
        </button>
      </div>
    </Can>
  );
}

// --- Revisions tab ----------------------------------------------------------

function RevisionsTab({ projectId }: { projectId: string }) {
  const { t, locale } = useTranslation();
  const [revisions, setRevisions] = useState<BudgetRevision[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  function load() {
    setError(null);
    setRevisions(null);
    listBudgetRevisions(projectId)
      .then(setRevisions)
      .catch((err) => setError(err instanceof Error ? err.message : t("costPlan.revisions.loadListError")));
  }
  useEffect(load, [projectId]);

  const columns: FinancialColumn<BudgetRevision>[] = [
    { key: "revisionNumber", header: t("costPlan.revisions.columns.revisionNumber"), render: (r) => `#${r.revisionNumber}` },
    { key: "status", header: t("costPlan.revisions.columns.status"), render: (r) => <Badge tone={revisionStatusTone[r.status]}>{t(`costPlan.revisions.status.${r.status}`)}</Badge> },
    { key: "reason", header: t("costPlan.revisions.columns.reason"), render: (r) => r.reason ?? "—" },
    { key: "createdAt", header: t("costPlan.revisions.columns.createdAt"), render: (r) => formatDate(r.createdAt, locale) },
    { key: "approvedAt", header: t("costPlan.revisions.columns.approvedAt"), render: (r) => formatDate(r.approvedAt, locale) },
  ];

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <Can permission="budgetRevision.manage">
          <Button size="sm" onClick={() => setShowCreate((v) => !v)}>
            {showCreate ? t("common.cancel") : t("costPlan.revisions.newRevision")}
          </Button>
        </Can>
      </div>

      {showCreate && (
        <Can permission="budgetRevision.manage">
          <RevisionCreateForm
            projectId={projectId}
            onCreated={(revision) => {
              setShowCreate(false);
              setSelectedId(revision.id);
              load();
            }}
          />
        </Can>
      )}

      <FinancialTable
        columns={columns}
        rows={revisions}
        rowKey={(r) => r.id}
        error={error}
        onRetry={load}
        emptyMessage={t("costPlan.revisions.emptyMessage")}
        rowActions={(r) => (
          <button type="button" onClick={() => setSelectedId(r.id)} className="text-sm text-primary hover:underline">
            {t("costPlan.revisions.view")}
          </button>
        )}
      />

      {selectedId && <RevisionDetail projectId={projectId} revisionId={selectedId} onChanged={load} />}
    </div>
  );
}

function RevisionCreateForm({ projectId, onCreated }: { projectId: string; onCreated: (revision: BudgetRevision) => void }) {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const revision = await createBudgetRevision(projectId, { reason: reason || undefined });
      onCreated(revision);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("costPlan.revisions.createForm.genericError"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="p-5">
      <form onSubmit={onSubmit} className="flex flex-wrap gap-2">
        {error && (
          <div className="w-full">
            <ErrorState message={error} />
          </div>
        )}
        <input
          placeholder={t("costPlan.revisions.createForm.reasonPlaceholder")}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="flex-1 rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <Button type="submit" disabled={submitting}>
          {submitting ? t("costPlan.revisions.createForm.saving") : t("costPlan.revisions.createForm.create")}
        </Button>
      </form>
    </Card>
  );
}

function RevisionDetail({ projectId, revisionId, onChanged }: { projectId: string; revisionId: string; onChanged: () => void }) {
  const { t, locale } = useTranslation();
  const [revision, setRevision] = useState<BudgetRevisionWithItems | null>(null);
  const [unassignedItems, setUnassignedItems] = useState<BudgetItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirmingApprove, setConfirmingApprove] = useState(false);
  const [approving, setApproving] = useState(false);
  const [showAssign, setShowAssign] = useState(false);

  function load() {
    setError(null);
    setRevision(null);
    Promise.all([getBudgetRevision(projectId, revisionId), getBudget(projectId)])
      .then(([rev, budget]) => {
        setRevision(rev);
        setUnassignedItems(budget.items.filter((i) => i.budgetRevisionId !== revisionId));
      })
      .catch((err) => setError(err instanceof Error ? err.message : t("costPlan.revisions.detail.loadError")));
  }
  useEffect(load, [projectId, revisionId]);

  async function onApprove() {
    setApproving(true);
    try {
      await approveBudgetRevision(projectId, revisionId);
      setConfirmingApprove(false);
      load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("costPlan.revisions.detail.approveError"));
      setConfirmingApprove(false);
    } finally {
      setApproving(false);
    }
  }

  if (error && !revision) return <ErrorState message={error} onRetry={load} />;
  if (!revision) return <Skeleton rows={4} />;

  const isDraft = revision.status === "draft";

  // Deliberately no "planned/spent" column here: GET /budget-revisions/:id
  // returns raw budget_items rows, which do not carry the `spent` figure
  // GET /budget synthesizes — showing a fabricated or stale spent value
  // here would be worse than not showing one.
  const columns: FinancialColumn<BudgetItem>[] = [
    { key: "category", header: t("costPlan.columns.category"), render: (i) => i.category },
    { key: "planned", header: t("costPlan.columns.planned"), align: "end", render: (i) => formatMoney(i.plannedAmount, "SAR", locale) },
  ];

  return (
    <Card className="p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold text-stone-800">{t("costPlan.revisions.detail.title", { number: revision.revisionNumber })}</h2>
          <Badge tone={revisionStatusTone[revision.status]}>{t(`costPlan.revisions.status.${revision.status}`)}</Badge>
        </div>
        <div className="flex gap-2">
          {isDraft && (
            <Button size="sm" variant="secondary" onClick={() => setShowAssign((v) => !v)}>
              {showAssign ? t("common.cancel") : t("costPlan.revisions.detail.assignItem")}
            </Button>
          )}
          <Can permission="budgetRevision.manage">
            {isDraft && (
              <Button size="sm" onClick={() => setConfirmingApprove(true)}>
                {t("costPlan.revisions.detail.approveRevision")}
              </Button>
            )}
          </Can>
        </div>
      </div>

      {error && (
        <div className="mb-4">
          <ErrorState message={error} />
        </div>
      )}
      {revision.reason && <p className="mb-4 text-sm text-stone-500">{revision.reason}</p>}

      {showAssign && isDraft && (
        <div className="mb-4">
          <AssignItemForm
            projectId={projectId}
            revisionId={revisionId}
            candidates={unassignedItems}
            onAssigned={() => {
              setShowAssign(false);
              load();
            }}
          />
        </div>
      )}

      <FinancialTable columns={columns} rows={revision.items} rowKey={(i) => i.id} emptyMessage={t("costPlan.revisions.detail.emptyAssigned")} />

      <ConfirmDialog
        open={confirmingApprove}
        title={t("costPlan.revisions.detail.confirmApproveTitle")}
        message={t("costPlan.revisions.detail.confirmApproveMessage")}
        confirmLabel={approving ? t("costPlan.revisions.detail.approving") : t("costPlan.revisions.detail.confirmApproveLabel")}
        destructive
        onConfirm={onApprove}
        onCancel={() => setConfirmingApprove(false)}
      />
    </Card>
  );
}

function AssignItemForm({
  projectId,
  revisionId,
  candidates,
  onAssigned,
}: {
  projectId: string;
  revisionId: string;
  candidates: BudgetItem[];
  onAssigned: () => void;
}) {
  const { t } = useTranslation();
  const [itemId, setItemId] = useState(candidates[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!itemId) return;
    setError(null);
    setSubmitting(true);
    try {
      await assignBudgetItemToRevision(projectId, revisionId, itemId, {});
      onAssigned();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("costPlan.revisions.assignForm.genericError"));
    } finally {
      setSubmitting(false);
    }
  }

  if (candidates.length === 0) {
    return <p className="text-sm text-stone-400">{t("costPlan.revisions.assignForm.noCandidates")}</p>;
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-wrap gap-2">
      {error && (
        <div className="w-full">
          <ErrorState message={error} />
        </div>
      )}
      <select
        value={itemId}
        onChange={(e) => setItemId(e.target.value)}
        className="rounded-md border border-stone-300 px-3 py-2 text-sm"
      >
        {candidates.map((i) => (
          <option key={i.id} value={i.id}>
            {i.category}
          </option>
        ))}
      </select>
      <Button type="submit" size="sm" disabled={submitting}>
        {submitting ? t("costPlan.revisions.assignForm.assigning") : t("costPlan.revisions.assignForm.assign")}
      </Button>
    </form>
  );
}
