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

const revisionStatusLabel: Record<BudgetRevisionStatus, string> = {
  draft: "مسودة",
  approved: "معتمدة",
  superseded: "مستبدَلة",
};
const revisionStatusTone: Record<BudgetRevisionStatus, "neutral" | "success" | "warning"> = {
  draft: "warning",
  approved: "success",
  superseded: "neutral",
};

export function CostPlanSection() {
  const { projectId } = useProjectContext();
  const [activeTab, setActiveTab] = useState<"plan" | "revisions">("plan");

  return (
    <div className="space-y-6">
      <PageHeader title="خطة التكلفة" />
      <Tabs
        items={[
          { key: "plan", label: "الخطة" },
          { key: "revisions", label: "المراجعات" },
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
      .catch((err) => setError(err instanceof Error ? err.message : "تعذّر تحميل خطة التكلفة"));
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
    { key: "category", header: "البند", render: (i) => i.category },
    { key: "costCode", header: "بند التكلفة", render: (i) => costCodeLabel(i.costCodeId) },
    { key: "planned", header: "المخطَّط", align: "end", render: (i) => formatMoney(i.plannedAmount) },
    { key: "spent", header: "المُنفَق", align: "end", render: (i) => formatMoney(i.spent) },
    { key: "boq", header: "جدول الكميات", render: (i) => (i.boqItemId ? "مرتبط" : "—") },
    { key: "revision", header: "المراجعة", render: (i) => revisionLabel(i.budgetRevisionId) },
  ];

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <MetricCard label="إجمالي المخطَّط" value={formatMoney(summary.totals.planned)} />
        <MetricCard label="إجمالي المُنفَق" value={formatMoney(summary.totals.spent)} />
        <MetricCard
          label={summary.totals.remaining < 0 ? "تجاوز الميزانية" : "المتبقي"}
          value={formatMoney(Math.abs(summary.totals.remaining))}
          tone={summary.totals.remaining < 0 ? "danger" : "default"}
        />
      </div>

      {costCodes.length > 0 && (
        <div className="flex items-center gap-2">
          <label className="text-sm text-stone-500">تصفية حسب بند التكلفة</label>
          <select
            value={costCodeFilter}
            onChange={(e) => setCostCodeFilter(e.target.value)}
            className="rounded-md border border-stone-300 px-3 py-2 text-sm"
          >
            <option value="">الكل</option>
            {costCodes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.code} — {c.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {error && <ErrorState message={error} onRetry={load} />}

      {/* Budget item CRUD mirrors actual backend authorization: POST/PATCH/DELETE
          /budget/items carry no RBAC gate server-side, so no <Can/> wrapper here — a
          member must see exactly the same controls an owner does. */}
      <BudgetItemForm projectId={projectId} onSaved={load} />

      <FinancialTable
        columns={columns}
        rows={visibleItems}
        rowKey={(i) => i.id}
        emptyMessage="لا توجد بنود ميزانية بعد"
        rowActions={(i) => <BudgetItemRowActions projectId={projectId} item={i} onChanged={load} />}
      />
    </div>
  );
}

function BudgetItemForm({ projectId, onSaved }: { projectId: string; onSaved: () => void }) {
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
      setError(err instanceof ApiError ? err.message : "تعذّر إضافة بند الميزانية");
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
          placeholder="اسم البند"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="flex-1 rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <input
          required
          type="number"
          min="0"
          step="0.01"
          placeholder="المبلغ المخطَّط"
          value={plannedAmount}
          onChange={(e) => setPlannedAmount(e.target.value)}
          className="w-40 rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <Button type="submit" size="sm" disabled={submitting}>
          {submitting ? "جارٍ الحفظ..." : "+ إضافة بند"}
        </Button>
      </form>
    </Card>
  );
}

function BudgetItemRowActions({ projectId, item, onChanged }: { projectId: string; item: BudgetItem; onChanged: () => void }) {
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
      setError(err instanceof ApiError ? err.message : "تعذّر حفظ التعديل");
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
      setError(err instanceof ApiError ? err.message : "تعذّر حذف البند");
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
      <button type="button" onClick={() => setEditing(true)} className="text-sm text-primary hover:underline">
        تعديل
      </button>
      <button type="button" onClick={onDelete} disabled={busy} className="text-sm text-danger-600 hover:underline">
        حذف
      </button>
    </div>
  );
}

// --- Revisions tab ----------------------------------------------------------

function RevisionsTab({ projectId }: { projectId: string }) {
  const [revisions, setRevisions] = useState<BudgetRevision[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  function load() {
    setError(null);
    setRevisions(null);
    listBudgetRevisions(projectId)
      .then(setRevisions)
      .catch((err) => setError(err instanceof Error ? err.message : "تعذّر تحميل مراجعات الميزانية"));
  }
  useEffect(load, [projectId]);

  const columns: FinancialColumn<BudgetRevision>[] = [
    { key: "revisionNumber", header: "رقم المراجعة", render: (r) => `#${r.revisionNumber}` },
    { key: "status", header: "الحالة", render: (r) => <Badge tone={revisionStatusTone[r.status]}>{revisionStatusLabel[r.status]}</Badge> },
    { key: "reason", header: "السبب", render: (r) => r.reason ?? "—" },
    { key: "createdAt", header: "تاريخ الإنشاء", render: (r) => formatDate(r.createdAt) },
    { key: "approvedAt", header: "تاريخ الاعتماد", render: (r) => formatDate(r.approvedAt) },
  ];

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <Can permission="budgetRevision.manage">
          <Button size="sm" onClick={() => setShowCreate((v) => !v)}>
            {showCreate ? "إلغاء" : "+ مراجعة جديدة"}
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
        emptyMessage="لا توجد مراجعات ميزانية بعد"
        rowActions={(r) => (
          <button type="button" onClick={() => setSelectedId(r.id)} className="text-sm text-primary hover:underline">
            عرض
          </button>
        )}
      />

      {selectedId && <RevisionDetail projectId={projectId} revisionId={selectedId} onChanged={load} />}
    </div>
  );
}

function RevisionCreateForm({ projectId, onCreated }: { projectId: string; onCreated: (revision: BudgetRevision) => void }) {
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
      setError(err instanceof ApiError ? err.message : "تعذّر إنشاء مراجعة جديدة");
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
          placeholder="سبب المراجعة (اختياري)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="flex-1 rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <Button type="submit" disabled={submitting}>
          {submitting ? "جارٍ الحفظ..." : "إنشاء مراجعة"}
        </Button>
      </form>
    </Card>
  );
}

function RevisionDetail({ projectId, revisionId, onChanged }: { projectId: string; revisionId: string; onChanged: () => void }) {
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
      .catch((err) => setError(err instanceof Error ? err.message : "تعذّر تحميل تفاصيل المراجعة"));
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
      setError(err instanceof ApiError ? err.message : "تعذّر اعتماد المراجعة");
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
    { key: "category", header: "البند", render: (i) => i.category },
    { key: "planned", header: "المخطَّط", align: "end", render: (i) => formatMoney(i.plannedAmount) },
  ];

  return (
    <Card className="p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold text-stone-800">مراجعة #{revision.revisionNumber}</h2>
          <Badge tone={revisionStatusTone[revision.status]}>{revisionStatusLabel[revision.status]}</Badge>
        </div>
        <div className="flex gap-2">
          {isDraft && (
            <Button size="sm" variant="secondary" onClick={() => setShowAssign((v) => !v)}>
              {showAssign ? "إلغاء" : "+ إسناد بند"}
            </Button>
          )}
          <Can permission="budgetRevision.manage">
            {isDraft && (
              <Button size="sm" onClick={() => setConfirmingApprove(true)}>
                اعتماد المراجعة
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

      <FinancialTable columns={columns} rows={revision.items} rowKey={(i) => i.id} emptyMessage="لا توجد بنود مُسندة لهذه المراجعة بعد" />

      <ConfirmDialog
        open={confirmingApprove}
        title="اعتماد مراجعة الميزانية"
        message="بعد الاعتماد لا يمكن تعديل بنود هذه المراجعة. هل تريد المتابعة؟"
        confirmLabel={approving ? "جارٍ الاعتماد..." : "اعتماد"}
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
      setError(err instanceof ApiError ? err.message : "تعذّر إسناد البند");
    } finally {
      setSubmitting(false);
    }
  }

  if (candidates.length === 0) {
    return <p className="text-sm text-stone-400">لا توجد بنود ميزانية أخرى يمكن إسنادها.</p>;
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
        {submitting ? "جارٍ الإسناد..." : "إسناد"}
      </Button>
    </form>
  );
}
