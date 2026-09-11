import { useEffect, useMemo, useState, type FormEvent } from "react";
import { PageHeader } from "../../ui/PageHeader";
import { Card } from "../../ui/Card";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { MetricCard } from "../../ui/MetricCard";
import { Skeleton } from "../../ui/Skeleton";
import { EmptyState } from "../../ui/EmptyState";
import { ErrorState } from "../../ui/ErrorState";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Can } from "../../auth/Can";
import { apiFetch, ApiError } from "../../api/client";
import { formatDate } from "../../lib/format";
import {
  listPunchItems,
  createPunchItem,
  updatePunchItem,
  deletePunchItem,
  transitionPunchItemStatus,
  type CreatePunchItemInput,
  type PunchItemFilters,
} from "../../api/punchItems";
import type { CompanyMember, PunchItem, PunchItemPriority, PunchItemStatus } from "../../api/types";
import { useProjectContext } from "../context";
import { useTranslation } from "../../i18n/I18nProvider";

// MIDAD Phase C2 — Punch Lists / Site Deficiencies. INTERNAL ONLY — this
// file is never imported from client/src/portal/, and PunchItem carries no
// clientVisible-style field of any kind. No financial figure appears
// anywhere on this screen; priority/status are operational classification
// only and never feed Budget/Actual Cost/Commitments/Forecast/Cash Flow/
// IPC/Invoices.

const statusTone: Record<PunchItemStatus, "neutral" | "info" | "success" | "warning" | "danger"> = {
  open: "neutral",
  assigned: "info",
  in_progress: "warning",
  resolved: "success",
  verified: "success",
  closed: "neutral",
};
const priorityTone: Record<PunchItemPriority, "neutral" | "info" | "warning" | "danger"> = {
  low: "neutral",
  medium: "info",
  high: "warning",
  critical: "danger",
};

// The one valid next-action set per status, per this phase's own lifecycle
// table — shown here for UX convenience only; the server independently
// re-validates every transition and is the real authorization boundary.
// labelKey resolves via punchList.actions.*; isReopen distinguishes the
// "reopen" actions for button styling without comparing translated text.
const STATUS_ACTIONS: Record<PunchItemStatus, { status: PunchItemStatus; labelKey: string; needsResolution?: boolean; isReopen?: boolean }[]> = {
  open: [
    { status: "in_progress", labelKey: "startWork" },
    { status: "assigned", labelKey: "assign" },
  ],
  assigned: [{ status: "in_progress", labelKey: "startWork" }],
  in_progress: [{ status: "resolved", labelKey: "markResolved", needsResolution: true }],
  resolved: [
    { status: "verified", labelKey: "verify" },
    { status: "in_progress", labelKey: "reopen", isReopen: true },
  ],
  verified: [
    { status: "closed", labelKey: "close" },
    { status: "in_progress", labelKey: "reopen", isReopen: true },
  ],
  closed: [],
};

function memberName(members: CompanyMember[], userId: string | null): string {
  if (!userId) return "—";
  return members.find((m) => m.id === userId)?.name ?? "—";
}

export function PunchListSection() {
  const { t, locale } = useTranslation();
  const { projectId } = useProjectContext();
  const [items, setItems] = useState<PunchItem[] | null>(null);
  const [summaryItems, setSummaryItems] = useState<PunchItem[] | null>(null);
  const [members, setMembers] = useState<CompanyMember[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editingItem, setEditingItem] = useState<PunchItem | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PunchItem | null>(null);

  const [statusFilter, setStatusFilter] = useState<PunchItemStatus | "all">("all");
  const [priorityFilter, setPriorityFilter] = useState<PunchItemPriority | "all">("all");
  const [assigneeFilter, setAssigneeFilter] = useState<string>("all");
  const [overdueOnly, setOverdueOnly] = useState(false);

  const filters: PunchItemFilters = useMemo(
    () => ({
      status: statusFilter === "all" ? undefined : statusFilter,
      priority: priorityFilter === "all" ? undefined : priorityFilter,
      assignedToUserId: assigneeFilter === "all" ? undefined : assigneeFilter,
      overdue: overdueOnly || undefined,
    }),
    [statusFilter, priorityFilter, assigneeFilter, overdueOnly],
  );

  function load() {
    setError(null);
    setItems(null);
    Promise.all([listPunchItems(projectId, filters), listPunchItems(projectId, {})])
      .then(([filtered, all]) => {
        setItems(filtered);
        setSummaryItems(all);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : t("punchList.loadError")));
  }
  useEffect(load, [projectId, filters]);
  useEffect(() => {
    apiFetch<CompanyMember[]>("/company/members")
      .then(setMembers)
      .catch(() => setMembers([]));
  }, []);

  const summary = useMemo(() => {
    const rows = summaryItems ?? [];
    const today = new Date().toISOString().slice(0, 10);
    return {
      open: rows.filter((i) => i.status === "open" || i.status === "assigned").length,
      inProgress: rows.filter((i) => i.status === "in_progress").length,
      resolved: rows.filter((i) => i.status === "resolved" || i.status === "verified").length,
      overdue: rows.filter((i) => i.dueDate && i.dueDate < today && i.status !== "closed").length,
    };
  }, [summaryItems]);

  const selected = items?.find((i) => i.id === selectedId) ?? null;

  async function confirmDelete() {
    if (!pendingDelete) return;
    await deletePunchItem(projectId, pendingDelete.id);
    if (selectedId === pendingDelete.id) setSelectedId(null);
    setPendingDelete(null);
    load();
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title={t("punchList.title")} />
        <ErrorState message={error} onRetry={load} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("punchList.title")}
        actions={
          <Button
            size="sm"
            onClick={() => {
              setEditingItem(null);
              setSelectedId(null);
              setShowCreate((v) => !v);
            }}
          >
            {showCreate ? t("common.cancel") : t("punchList.newItem")}
          </Button>
        }
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricCard label={t("punchList.summary.open")} value={String(summary.open)} />
        <MetricCard label={t("punchList.summary.inProgress")} value={String(summary.inProgress)} tone="warning" />
        <MetricCard label={t("punchList.summary.resolved")} value={String(summary.resolved)} tone="success" />
        <MetricCard label={t("punchList.summary.overdue")} value={String(summary.overdue)} tone={summary.overdue > 0 ? "danger" : "default"} />
      </div>

      {(showCreate || editingItem) && (
        <PunchItemForm
          projectId={projectId}
          members={members}
          editingItem={editingItem}
          onSaved={() => {
            setShowCreate(false);
            setEditingItem(null);
            load();
          }}
          onCancel={() => {
            setShowCreate(false);
            setEditingItem(null);
          }}
        />
      )}

      <div className="flex flex-wrap items-center gap-3">
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as PunchItemStatus | "all")} className="rounded-md border border-stone-300 px-3 py-1.5 text-sm">
          <option value="all">{t("punchList.filters.allStatuses")}</option>
          {(["open", "assigned", "in_progress", "resolved", "verified", "closed"] as PunchItemStatus[]).map((s) => (
            <option key={s} value={s}>
              {t(`punchList.status.${s}`)}
            </option>
          ))}
        </select>
        <select value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value as PunchItemPriority | "all")} className="rounded-md border border-stone-300 px-3 py-1.5 text-sm">
          <option value="all">{t("punchList.filters.allPriorities")}</option>
          {(["low", "medium", "high", "critical"] as PunchItemPriority[]).map((p) => (
            <option key={p} value={p}>
              {t(`punchList.priority.${p}`)}
            </option>
          ))}
        </select>
        <select value={assigneeFilter} onChange={(e) => setAssigneeFilter(e.target.value)} className="rounded-md border border-stone-300 px-3 py-1.5 text-sm">
          <option value="all">{t("punchList.filters.allAssignees")}</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-sm text-stone-600">
          <input type="checkbox" checked={overdueOnly} onChange={(e) => setOverdueOnly(e.target.checked)} />
          {t("punchList.filters.overdueOnly")}
        </label>
      </div>

      {items === null && <Skeleton rows={4} />}
      {items !== null && items.length === 0 && <EmptyState message={t("punchList.emptyMessage")} />}
      {items !== null && items.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {items.map((item) => (
            <Card key={item.id} className="cursor-pointer p-4 transition-shadow hover:shadow-md" onClick={() => setSelectedId(item.id)}>
              <p className="mb-1 font-medium text-stone-800">{item.title}</p>
              {item.location && <p className="text-xs text-stone-500">{t("punchList.card.location", { location: item.location })}</p>}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Badge tone={priorityTone[item.priority]}>{t(`punchList.priority.${item.priority}`)}</Badge>
                <Badge tone={statusTone[item.status]}>{t(`punchList.status.${item.status}`)}</Badge>
              </div>
              <div className="mt-2 flex items-center justify-between text-xs text-stone-500">
                <span>{t("punchList.card.assignee", { name: memberName(members, item.assignedToUserId) })}</span>
                {item.dueDate && <span>{t("punchList.card.due", { date: formatDate(item.dueDate, locale) })}</span>}
              </div>
            </Card>
          ))}
        </div>
      )}

      {selected && (
        <PunchItemDetail
          item={selected}
          members={members}
          projectId={projectId}
          onChanged={load}
          onEdit={() => {
            setShowCreate(false);
            setEditingItem(selected);
          }}
          onDeleteRequested={() => setPendingDelete(selected)}
          onClose={() => setSelectedId(null)}
        />
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t("punchList.deleteConfirm.title")}
        message={t("punchList.deleteConfirm.message", { title: pendingDelete?.title ?? "" })}
        destructive
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between border-b border-stone-100 py-2 text-sm last:border-0">
      <dt className="text-stone-500">{label}</dt>
      <dd className="font-medium text-stone-800">{value}</dd>
    </div>
  );
}

function PunchItemDetail({
  item,
  members,
  projectId,
  onChanged,
  onEdit,
  onDeleteRequested,
  onClose,
}: {
  item: PunchItem;
  members: CompanyMember[];
  projectId: string;
  onChanged: () => void;
  onEdit: () => void;
  onDeleteRequested: () => void;
  onClose: () => void;
}) {
  const { t, locale } = useTranslation();
  const [resolutionDraft, setResolutionDraft] = useState("");
  const [showResolutionForm, setShowResolutionForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onAction(status: PunchItemStatus, needsResolution?: boolean) {
    if (needsResolution && !showResolutionForm) {
      setShowResolutionForm(true);
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await transitionPunchItemStatus(projectId, item.id, status, needsResolution ? resolutionDraft : undefined);
      setShowResolutionForm(false);
      setResolutionDraft("");
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("punchList.detail.actionError"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-stone-800">{item.title}</h2>
          <div className="mt-1 flex flex-wrap gap-2">
            <Badge tone={priorityTone[item.priority]}>{t(`punchList.priority.${item.priority}`)}</Badge>
            <Badge tone={statusTone[item.status]}>{t(`punchList.status.${item.status}`)}</Badge>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="secondary" onClick={onEdit}>
            {t("punchList.detail.edit")}
          </Button>
          <Can permission="punchItem.delete">
            <Button size="sm" variant="danger" onClick={onDeleteRequested}>
              {t("common.delete")}
            </Button>
          </Can>
          <button type="button" onClick={onClose} className="text-stone-400 hover:text-stone-600" aria-label={t("punchList.detail.closeDetailsAriaLabel")}>
            ✕
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-3">
          <ErrorState message={error} />
        </div>
      )}

      <dl className="mb-4">
        {item.description && <Field label={t("punchList.detail.fields.description")} value={item.description} />}
        <Field label={t("punchList.detail.fields.location")} value={item.location ?? "—"} />
        <Field label={t("punchList.detail.fields.assignee")} value={memberName(members, item.assignedToUserId)} />
        <Field label={t("punchList.detail.fields.dueDate")} value={item.dueDate ? formatDate(item.dueDate, locale) : "—"} />
        <Field label={t("punchList.detail.fields.createdBy")} value={memberName(members, item.createdBy)} />
        <Field label={t("punchList.detail.fields.createdAt")} value={formatDate(item.createdAt, locale)} />
      </dl>

      {item.resolutionDescription && (
        <div className="mb-4 rounded-lg border border-stone-100 bg-stone-50 p-3">
          <p className="mb-1 text-xs font-semibold text-stone-500">{t("punchList.detail.resolutionHeading")}</p>
          <p className="text-sm text-stone-700">{item.resolutionDescription}</p>
          <p className="mt-1 text-xs text-stone-500">
            {t("punchList.detail.byLine", { name: memberName(members, item.resolvedByUserId), date: item.resolvedAt ? formatDate(item.resolvedAt, locale) : "—" })}
          </p>
        </div>
      )}
      {item.verifiedAt && (
        <div className="mb-4 rounded-lg border border-stone-100 bg-stone-50 p-3">
          <p className="text-xs font-semibold text-stone-500">{t("punchList.detail.verifiedHeading")}</p>
          <p className="text-xs text-stone-500">
            {t("punchList.detail.byLine", { name: memberName(members, item.verifiedByUserId), date: formatDate(item.verifiedAt, locale) })}
          </p>
        </div>
      )}
      {item.closedAt && (
        <div className="mb-4 rounded-lg border border-stone-100 bg-stone-50 p-3">
          <p className="text-xs font-semibold text-stone-500">{t("punchList.detail.closedHeading")}</p>
          <p className="text-xs text-stone-500">
            {t("punchList.detail.byLine", { name: memberName(members, item.closedByUserId), date: formatDate(item.closedAt, locale) })}
          </p>
        </div>
      )}

      {showResolutionForm && (
        <div className="mb-4 rounded-lg border border-stone-200 p-3">
          <label className="mb-1 block text-xs text-stone-500">{t("punchList.detail.resolutionForm.label")}</label>
          <textarea
            value={resolutionDraft}
            onChange={(e) => setResolutionDraft(e.target.value)}
            className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
            rows={3}
          />
          <div className="mt-2 flex gap-2">
            <Button size="sm" disabled={submitting || resolutionDraft.trim().length < 2} onClick={() => onAction("resolved", true)}>
              {t("punchList.detail.resolutionForm.save")}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setShowResolutionForm(false)}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      )}

      {!showResolutionForm && STATUS_ACTIONS[item.status].length > 0 && (
        <div className="flex flex-wrap gap-2">
          {STATUS_ACTIONS[item.status].map((action) => (
            <Button
              key={action.status}
              size="sm"
              variant={action.isReopen ? "secondary" : "primary"}
              disabled={submitting}
              onClick={() => onAction(action.status, action.needsResolution)}
            >
              {t(`punchList.actions.${action.labelKey}`)}
            </Button>
          ))}
        </div>
      )}
    </Card>
  );
}

function PunchItemForm({
  projectId,
  members,
  editingItem,
  onSaved,
  onCancel,
}: {
  projectId: string;
  members: CompanyMember[];
  editingItem: PunchItem | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(editingItem?.title ?? "");
  const [description, setDescription] = useState(editingItem?.description ?? "");
  const [location, setLocation] = useState(editingItem?.location ?? "");
  const [priority, setPriority] = useState<PunchItemPriority>(editingItem?.priority ?? "medium");
  const [assignedToUserId, setAssignedToUserId] = useState(editingItem?.assignedToUserId ?? "");
  const [dueDate, setDueDate] = useState(editingItem?.dueDate ?? "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const input: CreatePunchItemInput = {
        title,
        description: description || undefined,
        location: location || undefined,
        priority,
        assignedToUserId: assignedToUserId || null,
        dueDate: dueDate || null,
      };
      if (editingItem) {
        await updatePunchItem(projectId, editingItem.id, input);
      } else {
        await createPunchItem(projectId, input);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("punchList.form.genericError"));
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
          placeholder={t("punchList.form.titlePlaceholder")}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm sm:col-span-3"
        />
        <textarea
          placeholder={t("punchList.form.descriptionPlaceholder")}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm sm:col-span-3"
          rows={2}
        />
        <input
          placeholder={t("punchList.form.locationPlaceholder")}
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <select value={priority} onChange={(e) => setPriority(e.target.value as PunchItemPriority)} className="rounded-md border border-stone-300 px-3 py-2 text-sm">
          {(["low", "medium", "high", "critical"] as PunchItemPriority[]).map((p) => (
            <option key={p} value={p}>
              {t(`punchList.priority.${p}`)}
            </option>
          ))}
        </select>
        <select value={assignedToUserId} onChange={(e) => setAssignedToUserId(e.target.value)} className="rounded-md border border-stone-300 px-3 py-2 text-sm">
          <option value="">{t("punchList.form.noAssignee")}</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <input type="date" value={dueDate ?? ""} onChange={(e) => setDueDate(e.target.value)} className="rounded-md border border-stone-300 px-3 py-2 text-sm" />

        <div className="flex items-center gap-2 sm:col-span-3">
          <Button type="submit" size="sm" disabled={submitting}>
            {submitting ? t("punchList.form.saving") : editingItem ? t("punchList.form.saveEdits") : t("punchList.form.saveNew")}
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
        </div>
      </form>
    </Card>
  );
}
