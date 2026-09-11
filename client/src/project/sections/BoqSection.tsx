import { useEffect, useState, type FormEvent } from "react";
import { PageHeader } from "../../ui/PageHeader";
import { Card } from "../../ui/Card";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { FinancialTable, type FinancialColumn } from "../../ui/FinancialTable";
import { ErrorState } from "../../ui/ErrorState";
import { EmptyState } from "../../ui/EmptyState";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Skeleton } from "../../ui/Skeleton";
import { Can } from "../../auth/Can";
import { formatMoney, formatQuantity, formatDate } from "../../lib/format";
import { listContracts } from "../../api/contracts";
import { listRevisions, getRevision, createRevision, publishRevision, addItem, deleteItem } from "../../api/boq";
import { ApiError } from "../../api/client";
import type { BoqItem, BoqRevision, BoqRevisionStatus, BoqRevisionWithItems, Contract } from "../../api/types";
import { useProjectContext } from "../context";
import { useTranslation } from "../../i18n/I18nProvider";

// Reuses the exact same status labels already localized for the dashboard's
// BOQ-revision footnote (dashboard.financial.boqRevisionStatus.*) — one
// translated status vocabulary for "draft/published/superseded", not two
// copies that could drift apart.
const statusTone: Record<BoqRevisionStatus, "neutral" | "success" | "warning"> = {
  draft: "warning",
  published: "success",
  superseded: "neutral",
};

// Item hierarchy depth is a purely presentational tree-depth computation
// (indentation only) — it never touches quantity/rate/amount, so it is
// not a financial calculation. Capped defensively against malformed
// parent chains.
function itemDepth(item: BoqItem, byId: Map<string, BoqItem>): number {
  let depth = 0;
  let current = item;
  const seen = new Set<string>();
  while (current.parentItemId && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = byId.get(current.parentItemId);
    if (!parent) break;
    depth += 1;
    current = parent;
    if (depth > 20) break;
  }
  return depth;
}

export function BoqSection() {
  const { t, locale } = useTranslation();
  const { projectId } = useProjectContext();
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [revisions, setRevisions] = useState<BoqRevision[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  function load() {
    setError(null);
    setRevisions(null);
    Promise.all([listContracts(projectId), listRevisions(projectId)])
      .then(([contractRows, revisionRows]) => {
        setContracts(contractRows);
        setRevisions(revisionRows);
      })
      .catch((err) => setError(err instanceof Error ? err.message : t("boq.loadError")));
  }

  useEffect(load, [projectId]);

  const contractLabel = (contractId: string) => {
    const c = contracts.find((x) => x.id === contractId);
    return c ? (c.contractNumber ?? c.id.slice(0, 8)) : "—";
  };

  const columns: FinancialColumn<BoqRevision>[] = [
    { key: "revisionNumber", header: t("boq.columns.revisionNumber"), render: (r) => `#${r.revisionNumber}` },
    { key: "contract", header: t("boq.columns.contract"), render: (r) => contractLabel(r.contractId) },
    { key: "status", header: t("boq.columns.status"), render: (r) => <Badge tone={statusTone[r.status]}>{t(`dashboard.financial.boqRevisionStatus.${r.status}`)}</Badge> },
    { key: "publishedAt", header: t("boq.columns.publishedAt"), render: (r) => formatDate(r.publishedAt, locale) },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("boq.title")}
        actions={
          <Can permission="boq.manage">
            <Button size="sm" onClick={() => setShowCreate((v) => !v)} disabled={contracts.length === 0}>
              {showCreate ? t("common.cancel") : t("boq.newRevision")}
            </Button>
          </Can>
        }
      />

      {contracts.length === 0 && revisions !== null && (
        <EmptyState message={t("boq.needsContractFirst")} />
      )}

      {showCreate && (
        <Can permission="boq.manage">
          <RevisionCreateForm
            projectId={projectId}
            contracts={contracts}
            onCreated={(revision) => {
              setShowCreate(false);
              setSelectedRevisionId(revision.id);
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
        emptyMessage={t("boq.emptyRevisions")}
        rowActions={(r) => (
          <button type="button" onClick={() => setSelectedRevisionId(r.id)} className="text-sm text-primary hover:underline">
            {t("boq.viewItems")}
          </button>
        )}
      />

      {selectedRevisionId && (
        <RevisionDetail projectId={projectId} revisionId={selectedRevisionId} onChanged={load} />
      )}
    </div>
  );
}

function RevisionCreateForm({
  projectId,
  contracts,
  onCreated,
}: {
  projectId: string;
  contracts: Contract[];
  onCreated: (revision: BoqRevision) => void;
}) {
  const { t } = useTranslation();
  const [contractId, setContractId] = useState(contracts[0]?.id ?? "");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const revision = await createRevision(projectId, { contractId, notes: notes || undefined });
      onCreated(revision);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("boq.genericError"));
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
        <select
          required
          value={contractId}
          onChange={(e) => setContractId(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        >
          {contracts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.contractNumber ?? c.id.slice(0, 8)}
            </option>
          ))}
        </select>
        <input
          placeholder={t("boq.notesPlaceholder")}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm sm:col-span-2"
        />
        <Button type="submit" disabled={submitting || !contractId}>
          {submitting ? t("boq.saving") : t("boq.createRevision")}
        </Button>
      </form>
    </Card>
  );
}

function RevisionDetail({
  projectId,
  revisionId,
  onChanged,
}: {
  projectId: string;
  revisionId: string;
  onChanged: () => void;
}) {
  const { t, locale } = useTranslation();
  const [revision, setRevision] = useState<BoqRevisionWithItems | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAddItem, setShowAddItem] = useState(false);
  const [confirmingPublish, setConfirmingPublish] = useState(false);
  const [publishing, setPublishing] = useState(false);

  function load() {
    setError(null);
    setRevision(null);
    getRevision(projectId, revisionId)
      .then(setRevision)
      .catch((err) => setError(err instanceof Error ? err.message : t("boq.detail.loadError")));
  }

  useEffect(load, [projectId, revisionId]);

  async function onPublish() {
    setPublishing(true);
    try {
      await publishRevision(projectId, revisionId);
      setConfirmingPublish(false);
      load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("boq.detail.publishError"));
      setConfirmingPublish(false);
    } finally {
      setPublishing(false);
    }
  }

  async function onDeleteItem(itemId: string) {
    try {
      await deleteItem(projectId, revisionId, itemId);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("boq.detail.deleteItemError"));
    }
  }

  if (error && !revision) return <ErrorState message={error} onRetry={load} />;
  if (!revision) return <Skeleton rows={5} />;

  const isDraft = revision.status === "draft";
  const byId = new Map(revision.items.map((i) => [i.id, i]));

  const columns: FinancialColumn<BoqItem>[] = [
    {
      key: "description",
      header: t("boq.detail.columns.description"),
      render: (item) => (
        <span style={{ paddingInlineStart: `${itemDepth(item, byId) * 16}px` }}>
          {item.itemType === "section" ? <strong>{item.description}</strong> : item.description}
        </span>
      ),
    },
    { key: "code", header: t("boq.detail.columns.code"), render: (item) => item.code ?? "—" },
    { key: "unit", header: t("boq.detail.columns.unit"), render: (item) => item.unit ?? "—" },
    { key: "quantity", header: t("boq.detail.columns.quantity"), align: "end", render: (item) => (item.quantity !== null ? formatQuantity(item.quantity, null, locale) : "—") },
    { key: "rate", header: t("boq.detail.columns.rate"), align: "end", render: (item) => (item.rate !== null ? formatMoney(item.rate, "SAR", locale) : "—") },
    { key: "amount", header: t("boq.detail.columns.amount"), align: "end", render: (item) => (item.amount !== null ? formatMoney(item.amount, "SAR", locale) : "—") },
  ];

  return (
    <Card className="p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold text-stone-800">{t("boq.detail.revisionTitle", { number: revision.revisionNumber })}</h2>
          <Badge tone={statusTone[revision.status]}>{t(`dashboard.financial.boqRevisionStatus.${revision.status}`)}</Badge>
        </div>
        <div className="flex gap-2">
          <Can permission="boq.manage">
            {isDraft && (
              <Button size="sm" variant="secondary" onClick={() => setShowAddItem((v) => !v)}>
                {showAddItem ? t("common.cancel") : t("boq.detail.addItem")}
              </Button>
            )}
          </Can>
          <Can permission="boq.manage">
            {isDraft && (
              <Button size="sm" onClick={() => setConfirmingPublish(true)}>
                {t("boq.detail.publishRevision")}
              </Button>
            )}
          </Can>
        </div>
      </div>

      {error && <div className="mb-4"><ErrorState message={error} /></div>}
      {revision.notes && <p className="mb-4 text-sm text-stone-500">{revision.notes}</p>}

      {showAddItem && isDraft && (
        <div className="mb-4">
          <Can permission="boq.manage">
            <AddItemForm projectId={projectId} revisionId={revisionId} onAdded={() => { setShowAddItem(false); load(); }} />
          </Can>
        </div>
      )}

      <FinancialTable
        columns={columns}
        rows={revision.items}
        rowKey={(i) => i.id}
        emptyMessage={t("boq.detail.emptyItems")}
        rowActions={
          isDraft
            ? (item) => (
                <Can permission="boq.manage">
                  <button type="button" onClick={() => onDeleteItem(item.id)} className="text-sm text-danger-600 hover:underline">
                    {t("common.delete")}
                  </button>
                </Can>
              )
            : undefined
        }
      />

      <ConfirmDialog
        open={confirmingPublish}
        title={t("boq.detail.confirmPublishTitle")}
        message={t("boq.detail.confirmPublishMessage")}
        confirmLabel={publishing ? t("boq.detail.publishing") : t("boq.detail.confirmPublishLabel")}
        destructive
        onConfirm={onPublish}
        onCancel={() => setConfirmingPublish(false)}
      />
    </Card>
  );
}

function AddItemForm({
  projectId,
  revisionId,
  onAdded,
}: {
  projectId: string;
  revisionId: string;
  onAdded: () => void;
}) {
  const { t } = useTranslation();
  const [description, setDescription] = useState("");
  const [unit, setUnit] = useState("");
  const [quantity, setQuantity] = useState("");
  const [rate, setRate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await addItem(projectId, revisionId, {
        description,
        unit: unit || undefined,
        quantity: quantity ? Number(quantity) : undefined,
        rate: rate ? Number(rate) : undefined,
      });
      setDescription("");
      setUnit("");
      setQuantity("");
      setRate("");
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("boq.addItemForm.genericError"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="grid grid-cols-1 gap-2 rounded-md border border-stone-200 p-3 sm:grid-cols-5">
      {error && (
        <div className="sm:col-span-5">
          <ErrorState message={error} />
        </div>
      )}
      <input
        required
        placeholder={t("boq.addItemForm.descriptionPlaceholder")}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        className="rounded-md border border-stone-300 px-3 py-2 text-sm sm:col-span-2"
      />
      <input
        placeholder={t("boq.addItemForm.unitPlaceholder")}
        value={unit}
        onChange={(e) => setUnit(e.target.value)}
        className="rounded-md border border-stone-300 px-3 py-2 text-sm"
      />
      <input
        type="number"
        min="0"
        step="0.001"
        placeholder={t("boq.addItemForm.quantityPlaceholder")}
        value={quantity}
        onChange={(e) => setQuantity(e.target.value)}
        className="rounded-md border border-stone-300 px-3 py-2 text-sm"
      />
      <input
        type="number"
        min="0"
        step="0.01"
        placeholder={t("boq.addItemForm.ratePlaceholder")}
        value={rate}
        onChange={(e) => setRate(e.target.value)}
        className="rounded-md border border-stone-300 px-3 py-2 text-sm"
      />
      <Button type="submit" size="sm" disabled={submitting} className="sm:col-span-5">
        {submitting ? t("boq.addItemForm.adding") : t("boq.addItemForm.addItem")}
      </Button>
    </form>
  );
}
