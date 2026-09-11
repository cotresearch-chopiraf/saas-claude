import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
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
import { useAuth } from "../../auth/AuthContext";
import { hasPermission } from "../../auth/permissions";
import { formatMoney, formatQuantity, formatDateTime } from "../../lib/format";
import { listSuppliers } from "../../api/suppliers";
import { listContracts } from "../../api/contracts";
import { listCostCodes } from "../../api/costPlan";
import { listRevisions, getRevision } from "../../api/boq";
import {
  listCommitments,
  getCommitment,
  createCommitment,
  addCommitmentLine,
  deleteCommitmentLine,
  submitCommitment,
  approveCommitment,
  cancelCommitment,
  amendCommitment,
  updateCommitmentTerms,
} from "../../api/commitments";
import { ApiError } from "../../api/client";
import type {
  BoqItem,
  Commitment,
  CommitmentLine,
  CommitmentStatus,
  CommitmentType,
  CommitmentWithLines,
  Contract,
  CostCode,
  Supplier,
} from "../../api/types";
import { useProjectContext } from "../context";
import { useTranslation } from "../../i18n/I18nProvider";

const statusTone: Record<CommitmentStatus, "neutral" | "success" | "warning" | "info" | "danger"> = {
  draft: "warning",
  pending_approval: "info",
  active: "success",
  partially_fulfilled: "info",
  closed: "neutral",
  cancelled: "danger",
};

// Commitment / Procurement (UI-03A) — the frontend for the existing,
// fully-tested server/src/routes/commitments.ts. The backend owns
// numbering, line-amount calculation, and every state transition; this
// screen only displays and reflects what it returns.
export function ProcurementSection() {
  const { t, locale } = useTranslation();
  const { projectId } = useProjectContext();
  const [commitments, setCommitments] = useState<Commitment[] | null>(null);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [costCodes, setCostCodes] = useState<CostCode[]>([]);
  const [boqItems, setBoqItems] = useState<BoqItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  function load() {
    setError(null);
    setCommitments(null);
    Promise.all([listCommitments(projectId), listSuppliers(), listContracts(projectId), listCostCodes(projectId), loadLatestPublishedBoqItems(projectId)])
      .then(([commitmentRows, supplierRows, contractRows, costCodeRows, boqItemRows]) => {
        setCommitments(commitmentRows);
        setSuppliers(supplierRows);
        setContracts(contractRows);
        setCostCodes(costCodeRows);
        setBoqItems(boqItemRows);
      })
      .catch((err) => setError(err instanceof Error ? err.message : t("procurement.loadError")));
  }
  useEffect(load, [projectId]);

  const supplierLabel = (id: string) => suppliers.find((s) => s.id === id)?.name ?? "—";
  const contractLabel = (id: string | null) => {
    if (!id) return "—";
    const c = contracts.find((x) => x.id === id);
    return c ? (c.contractNumber ?? c.id.slice(0, 8)) : "—";
  };

  const columns: FinancialColumn<Commitment>[] = [
    { key: "commitmentNumber", header: t("procurement.columns.number"), render: (c) => `#${c.commitmentNumber}` },
    { key: "type", header: t("procurement.columns.type"), render: (c) => t(`procurement.type.${c.type}`) },
    { key: "supplier", header: t("procurement.columns.supplier"), render: (c) => supplierLabel(c.supplierId) },
    { key: "description", header: t("procurement.columns.description"), render: (c) => c.description ?? "—" },
    { key: "status", header: t("procurement.columns.status"), render: (c) => <Badge tone={statusTone[c.status]}>{t(`procurement.status.${c.status}`)}</Badge> },
    { key: "originalAmount", header: t("procurement.columns.originalAmount"), align: "end", render: (c) => (c.originalAmount !== null ? formatMoney(c.originalAmount, c.currency, locale) : "—") },
    { key: "revisedAmount", header: t("procurement.columns.revisedAmount"), align: "end", render: (c) => (c.revisedAmount !== null ? formatMoney(c.revisedAmount, c.currency, locale) : "—") },
    { key: "currency", header: t("procurement.columns.currency"), render: (c) => c.currency },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("procurement.title")}
        actions={
          <Can permission="commitment.manage">
            <Button size="sm" onClick={() => setShowCreate((v) => !v)} disabled={suppliers.length === 0}>
              {showCreate ? t("common.cancel") : t("procurement.newCommitment")}
            </Button>
          </Can>
        }
      />

      {suppliers.length === 0 && commitments !== null && (
        <EmptyState message={t("procurement.needsSupplierFirst")} />
      )}

      {showCreate && (
        <Can permission="commitment.manage">
          <CommitmentCreateForm
            projectId={projectId}
            suppliers={suppliers}
            contracts={contracts}
            onCreated={(commitment) => {
              setShowCreate(false);
              setSelectedId(commitment.id);
              load();
            }}
          />
        </Can>
      )}

      <FinancialTable
        columns={columns}
        rows={commitments}
        rowKey={(c) => c.id}
        error={error}
        onRetry={load}
        emptyMessage={t("procurement.emptyMessage")}
        rowActions={(c) => (
          <button type="button" onClick={() => setSelectedId(c.id)} className="text-sm text-primary hover:underline">
            {t("procurement.view")}
          </button>
        )}
      />

      {selectedId && (
        <CommitmentDetail
          projectId={projectId}
          commitmentId={selectedId}
          suppliers={suppliers}
          contracts={contracts}
          costCodes={costCodes}
          boqItems={boqItems}
          onChanged={load}
        />
      )}
    </div>
  );
}

// BOQ items are only meaningful to commit against once published — draft
// items can still change. Reuses the existing BOQ API exactly as-is (no
// new backend route, no new BOQ screen); if there is no published
// revision yet, the picker simply has nothing to offer.
async function loadLatestPublishedBoqItems(projectId: string): Promise<BoqItem[]> {
  const revisions = await listRevisions(projectId);
  const published = revisions.filter((r) => r.status === "published").sort((a, b) => b.revisionNumber - a.revisionNumber)[0];
  if (!published) return [];
  const detail = await getRevision(projectId, published.id);
  return detail.items.filter((i) => i.itemType === "item");
}

function CommitmentCreateForm({
  projectId,
  suppliers,
  contracts,
  onCreated,
}: {
  projectId: string;
  suppliers: Supplier[];
  contracts: Contract[];
  onCreated: (commitment: Commitment) => void;
}) {
  const { t } = useTranslation();
  const [supplierId, setSupplierId] = useState(suppliers[0]?.id ?? "");
  const [type, setType] = useState<CommitmentType>("purchase_order");
  const [contractId, setContractId] = useState("");
  const [description, setDescription] = useState("");
  const [retentionPercent, setRetentionPercent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const commitment = await createCommitment(projectId, {
        supplierId,
        type,
        contractId: contractId || undefined,
        description: description || undefined,
        ...(type === "subcontract" && retentionPercent ? { retentionPercent: Number(retentionPercent) } : {}),
      });
      onCreated(commitment);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("procurement.createForm.genericError"));
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
          value={supplierId}
          onChange={(e) => setSupplierId(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        >
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select
          value={type}
          onChange={(e) => setType(e.target.value as CommitmentType)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        >
          <option value="purchase_order">{t("procurement.type.purchase_order")}</option>
          <option value="subcontract">{t("procurement.type.subcontract")}</option>
        </select>
        <select
          value={contractId}
          onChange={(e) => setContractId(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        >
          <option value="">{t("procurement.createForm.noContract")}</option>
          {contracts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.contractNumber ?? c.id.slice(0, 8)}
            </option>
          ))}
        </select>
        <input
          placeholder={t("procurement.createForm.descriptionPlaceholder")}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm sm:col-span-2"
        />
        {type === "subcontract" && (
          <input
            type="number"
            min={0}
            max={100}
            step="0.01"
            placeholder={t("procurement.createForm.retentionPlaceholder")}
            value={retentionPercent}
            onChange={(e) => setRetentionPercent(e.target.value)}
            className="rounded-md border border-stone-300 px-3 py-2 text-sm"
          />
        )}
        <Button type="submit" disabled={submitting || !supplierId}>
          {submitting ? t("procurement.createForm.saving") : t("procurement.createForm.create")}
        </Button>
      </form>
    </Card>
  );
}

type PendingAction = "submit" | "approve" | "cancel" | null;

function confirmCopyFor(
  t: (key: string) => string,
): Record<Exclude<PendingAction, null>, { title: string; message: string; confirmLabel: string; destructive?: boolean }> {
  return {
    submit: {
      title: t("procurement.confirm.submitTitle"),
      message: t("procurement.confirm.submitMessage"),
      confirmLabel: t("procurement.confirm.submitLabel"),
    },
    approve: {
      title: t("procurement.confirm.approveTitle"),
      message: t("procurement.confirm.approveMessage"),
      confirmLabel: t("procurement.confirm.approveLabel"),
    },
    cancel: {
      title: t("procurement.confirm.cancelTitle"),
      message: t("procurement.confirm.cancelMessage"),
      confirmLabel: t("procurement.confirm.cancelLabel"),
      destructive: true,
    },
  };
}

function CommitmentDetail({
  projectId,
  commitmentId,
  suppliers,
  contracts,
  costCodes,
  boqItems,
  onChanged,
}: {
  projectId: string;
  commitmentId: string;
  suppliers: Supplier[];
  contracts: Contract[];
  costCodes: CostCode[];
  boqItems: BoqItem[];
  onChanged: () => void;
}) {
  const { t, locale } = useTranslation();
  const { user } = useAuth();
  const canManage = hasPermission(user?.role, "commitment.manage");
  const confirmCopy = confirmCopyFor(t);
  const [commitment, setCommitment] = useState<CommitmentWithLines | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAddLine, setShowAddLine] = useState(false);
  const [showAmend, setShowAmend] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [actingBusy, setActingBusy] = useState(false);
  const [retentionInput, setRetentionInput] = useState("");
  const [retentionSaving, setRetentionSaving] = useState(false);

  function load() {
    setError(null);
    setCommitment(null);
    getCommitment(projectId, commitmentId)
      .then((row) => {
        setCommitment(row);
        setRetentionInput(row.retentionPercent ?? "");
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : t("procurement.detail.loadError")));
  }
  useEffect(load, [projectId, commitmentId]);

  async function onSaveRetention() {
    setRetentionSaving(true);
    setError(null);
    try {
      await updateCommitmentTerms(projectId, commitmentId, {
        retentionPercent: retentionInput === "" ? null : Number(retentionInput),
      });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("procurement.detail.retentionSaveError"));
    } finally {
      setRetentionSaving(false);
    }
  }

  async function onConfirmAction() {
    if (!pendingAction) return;
    setActingBusy(true);
    try {
      if (pendingAction === "submit") await submitCommitment(projectId, commitmentId);
      else if (pendingAction === "approve") await approveCommitment(projectId, commitmentId);
      else if (pendingAction === "cancel") await cancelCommitment(projectId, commitmentId);
      setPendingAction(null);
      load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("procurement.detail.actionError"));
      setPendingAction(null);
    } finally {
      setActingBusy(false);
    }
  }

  async function onDeleteLine(lineId: string) {
    try {
      await deleteCommitmentLine(projectId, commitmentId, lineId);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("procurement.detail.deleteLineError"));
    }
  }

  if (error && !commitment) return <ErrorState message={error} onRetry={load} />;
  if (!commitment) return <Skeleton rows={5} />;

  const supplierName = suppliers.find((s) => s.id === commitment.supplierId)?.name ?? "—";
  const contractLabel = commitment.contractId
    ? (contracts.find((c) => c.id === commitment.contractId)?.contractNumber ?? commitment.contractId.slice(0, 8))
    : "—";
  const costCodeLabel = (id: string | null) => {
    if (!id) return "—";
    const c = costCodes.find((x) => x.id === id);
    return c ? `${c.code} — ${c.name}` : "—";
  };
  const boqItemLabel = (id: string | null) => {
    if (!id) return "—";
    const item = boqItems.find((x) => x.id === id);
    return item ? (item.code ? `${item.code} — ${item.description}` : item.description) : "—";
  };

  const isDraft = commitment.status === "draft";
  const isPendingApproval = commitment.status === "pending_approval";
  const canAmend = commitment.status === "active" || commitment.status === "partially_fulfilled";

  const lineColumns: FinancialColumn<CommitmentLine>[] = [
    { key: "description", header: t("procurement.detail.lineColumns.description"), render: (l) => l.description },
    { key: "quantity", header: t("procurement.detail.lineColumns.quantity"), align: "end", render: (l) => (l.quantity !== null ? formatQuantity(l.quantity, null, locale) : "—") },
    { key: "rate", header: t("procurement.detail.lineColumns.rate"), align: "end", render: (l) => (l.rate !== null ? formatMoney(l.rate, commitment.currency, locale) : "—") },
    { key: "amount", header: t("procurement.detail.lineColumns.amount"), align: "end", render: (l) => formatMoney(l.amount, commitment.currency, locale) },
    { key: "costCode", header: t("procurement.detail.lineColumns.costCode"), render: (l) => costCodeLabel(l.costCodeId) },
    { key: "boqItem", header: t("procurement.detail.lineColumns.boqItem"), render: (l) => boqItemLabel(l.boqItemId) },
  ];

  return (
    <Card className="p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold text-stone-800">{t("procurement.detail.title", { number: commitment.commitmentNumber })}</h2>
          <Badge tone={statusTone[commitment.status]}>{t(`procurement.status.${commitment.status}`)}</Badge>
          <span className="text-sm text-stone-500">{t(`procurement.type.${commitment.type}`)}</span>
        </div>
        <Can permission="commitment.manage">
          <div className="flex flex-wrap gap-2">
            {isDraft && (
              <Button size="sm" variant="secondary" onClick={() => setShowAddLine((v) => !v)}>
                {showAddLine ? t("common.cancel") : t("procurement.detail.addLine")}
              </Button>
            )}
            {isDraft && (
              <Button size="sm" onClick={() => setPendingAction("submit")}>
                {t("procurement.detail.submitForApproval")}
              </Button>
            )}
            {isPendingApproval && (
              <Button size="sm" onClick={() => setPendingAction("approve")}>
                {t("procurement.detail.approve")}
              </Button>
            )}
            {(isDraft || isPendingApproval) && (
              <Button size="sm" variant="danger" onClick={() => setPendingAction("cancel")}>
                {t("procurement.detail.cancelCommitment")}
              </Button>
            )}
            {canAmend && (
              <Button size="sm" variant="secondary" onClick={() => setShowAmend((v) => !v)}>
                {showAmend ? t("common.cancel") : t("procurement.detail.amend")}
              </Button>
            )}
          </div>
        </Can>
        {/* MIDAD Phase 2 — Subcontractor IPC. Read-open (matches every
            domain's read-access precedent), so visible to any member, not
            wrapped in <Can> — the mutation controls on the destination
            screen itself remain owner-gated. */}
        {commitment.type === "subcontract" && canAmend && (
          <Link
            to={`/projects/${projectId}/subcontract-ipcs/${commitment.id}`}
            className="text-sm text-primary hover:underline"
          >
            {t("procurement.detail.subcontractIpcsLink")}
          </Link>
        )}
      </div>

      {error && (
        <div className="mb-4">
          <ErrorState message={error} />
        </div>
      )}

      <dl className="mb-5 grid grid-cols-1 gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
        <Field label={t("procurement.detail.fields.supplier")} value={supplierName} />
        <Field label={t("procurement.detail.fields.contract")} value={contractLabel} />
        <Field label={t("procurement.detail.fields.description")} value={commitment.description ?? "—"} />
        <Field label={t("procurement.detail.fields.currency")} value={commitment.currency} />
        <Field label={t("procurement.detail.fields.originalAmount")} value={commitment.originalAmount !== null ? formatMoney(commitment.originalAmount, commitment.currency, locale) : "—"} />
        <Field label={t("procurement.detail.fields.revisedAmount")} value={commitment.revisedAmount !== null ? formatMoney(commitment.revisedAmount, commitment.currency, locale) : "—"} />
        <Field label={t("procurement.detail.fields.submittedAt")} value={formatDateTime(commitment.submittedAt, locale)} />
        <Field label={t("procurement.detail.fields.approvedAt")} value={formatDateTime(commitment.approvedAt, locale)} />
        {commitment.cancelledAt && <Field label={t("procurement.detail.fields.cancelledAt")} value={formatDateTime(commitment.cancelledAt, locale)} />}
        {commitment.type === "subcontract" &&
          (isDraft && canManage ? (
            <div className="flex items-center justify-between gap-2 border-b border-stone-100 pb-2">
              <dt className="text-stone-500">{t("procurement.detail.fields.retentionPercent")}</dt>
              <dd className="flex items-center gap-2">
                <input
                  type="number"
                  min={0}
                  max={100}
                  step="0.01"
                  value={retentionInput}
                  onChange={(e) => setRetentionInput(e.target.value)}
                  className="w-20 rounded-md border border-stone-300 px-2 py-1 text-xs"
                />
                <Button size="sm" onClick={onSaveRetention} disabled={retentionSaving}>
                  {retentionSaving ? t("common.saving") : t("common.save")}
                </Button>
              </dd>
            </div>
          ) : (
            <Field label={t("procurement.detail.fields.retentionPercentReadonly")} value={commitment.retentionPercent !== null ? `${commitment.retentionPercent}%` : "—"} />
          ))}
      </dl>

      {showAddLine && isDraft && (
        <div className="mb-4">
          <Can permission="commitment.manage">
            <CommitmentLineForm
              costCodes={costCodes}
              boqItems={boqItems}
              submitLabel={t("procurement.detail.addItemLabel")}
              onSubmit={async (input) => {
                await addCommitmentLine(projectId, commitmentId, input);
                setShowAddLine(false);
                load();
              }}
            />
          </Can>
        </div>
      )}

      {showAmend && canAmend && (
        <div className="mb-4">
          <Can permission="commitment.manage">
            <AmendLineForm
              costCodes={costCodes}
              boqItems={boqItems}
              onAmend={async (input) => {
                await amendCommitment(projectId, commitmentId, { lines: [input] });
                setShowAmend(false);
                load();
                onChanged();
              }}
            />
          </Can>
        </div>
      )}

      <FinancialTable
        columns={lineColumns}
        rows={commitment.lines}
        rowKey={(l) => l.id}
        emptyMessage={t("procurement.detail.emptyLines")}
        rowActions={
          isDraft
            ? (line) => (
                <Can permission="commitment.manage">
                  <button type="button" onClick={() => onDeleteLine(line.id)} className="text-sm text-danger-600 hover:underline">
                    {t("common.delete")}
                  </button>
                </Can>
              )
            : undefined
        }
      />

      <ConfirmDialog
        open={pendingAction !== null}
        title={pendingAction ? confirmCopy[pendingAction].title : ""}
        message={pendingAction ? confirmCopy[pendingAction].message : ""}
        confirmLabel={actingBusy ? t("procurement.confirm.executing") : pendingAction ? confirmCopy[pendingAction].confirmLabel : ""}
        destructive={pendingAction ? confirmCopy[pendingAction].destructive : undefined}
        onConfirm={onConfirmAction}
        onCancel={() => setPendingAction(null)}
      />
    </Card>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between border-b border-stone-100 pb-2">
      <dt className="text-stone-500">{label}</dt>
      <dd className="font-medium text-stone-800">{value}</dd>
    </div>
  );
}

interface LineFormValues {
  description: string;
  quantity?: number;
  rate?: number;
  costCodeId?: string;
  boqItemId?: string;
}

// Shared line-entry fields for both "add a draft line" and "amend an
// active commitment" — only the submit behavior differs (add vs. a
// confirmed amend), never the field set or validation.
function LineFields({
  description,
  setDescription,
  quantity,
  setQuantity,
  rate,
  setRate,
  costCodeId,
  setCostCodeId,
  boqItemId,
  setBoqItemId,
  costCodes,
  boqItems,
}: {
  description: string;
  setDescription: (v: string) => void;
  quantity: string;
  setQuantity: (v: string) => void;
  rate: string;
  setRate: (v: string) => void;
  costCodeId: string;
  setCostCodeId: (v: string) => void;
  boqItemId: string;
  setBoqItemId: (v: string) => void;
  costCodes: CostCode[];
  boqItems: BoqItem[];
}) {
  const { t } = useTranslation();
  return (
    <>
      <input
        required
        placeholder={t("procurement.lineFields.descriptionPlaceholder")}
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        className="rounded-md border border-stone-300 px-3 py-2 text-sm sm:col-span-2"
      />
      <input
        type="number"
        min="0"
        step="0.001"
        placeholder={t("procurement.lineFields.quantityPlaceholder")}
        value={quantity}
        onChange={(e) => setQuantity(e.target.value)}
        className="rounded-md border border-stone-300 px-3 py-2 text-sm"
      />
      <input
        type="number"
        min="0"
        step="0.01"
        placeholder={t("procurement.lineFields.ratePlaceholder")}
        value={rate}
        onChange={(e) => setRate(e.target.value)}
        className="rounded-md border border-stone-300 px-3 py-2 text-sm"
      />
      <select
        value={costCodeId}
        onChange={(e) => setCostCodeId(e.target.value)}
        className="rounded-md border border-stone-300 px-3 py-2 text-sm"
      >
        <option value="">{t("procurement.lineFields.noCostCode")}</option>
        {costCodes.map((c) => (
          <option key={c.id} value={c.id}>
            {c.code} — {c.name}
          </option>
        ))}
      </select>
      <select
        value={boqItemId}
        onChange={(e) => setBoqItemId(e.target.value)}
        className="rounded-md border border-stone-300 px-3 py-2 text-sm"
      >
        <option value="">{t("procurement.lineFields.noBoqItem")}</option>
        {boqItems.map((i) => (
          <option key={i.id} value={i.id}>
            {i.code ? `${i.code} — ${i.description}` : i.description}
          </option>
        ))}
      </select>
    </>
  );
}

function CommitmentLineForm({
  costCodes,
  boqItems,
  submitLabel,
  onSubmit,
}: {
  costCodes: CostCode[];
  boqItems: BoqItem[];
  submitLabel: string;
  onSubmit: (input: LineFormValues) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [description, setDescription] = useState("");
  const [quantity, setQuantity] = useState("");
  const [rate, setRate] = useState("");
  const [costCodeId, setCostCodeId] = useState("");
  const [boqItemId, setBoqItemId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit({
        description,
        quantity: quantity ? Number(quantity) : undefined,
        rate: rate ? Number(rate) : undefined,
        costCodeId: costCodeId || undefined,
        boqItemId: boqItemId || undefined,
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("procurement.lineForm.genericError"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-2 rounded-md border border-stone-200 p-3 sm:grid-cols-5">
      {error && (
        <div className="sm:col-span-5">
          <ErrorState message={error} />
        </div>
      )}
      <LineFields
        description={description}
        setDescription={setDescription}
        quantity={quantity}
        setQuantity={setQuantity}
        rate={rate}
        setRate={setRate}
        costCodeId={costCodeId}
        setCostCodeId={setCostCodeId}
        boqItemId={boqItemId}
        setBoqItemId={setBoqItemId}
        costCodes={costCodes}
        boqItems={boqItems}
      />
      <Button type="submit" size="sm" disabled={submitting} className="sm:col-span-5">
        {submitting ? t("procurement.lineForm.saving") : submitLabel}
      </Button>
    </form>
  );
}

// Amendment is a consequential, backend-derived change (revisedAmount is
// recomputed server-side from the full line set) — so unlike a plain
// draft-line add, staging a line here requires an explicit confirmation
// before it is actually submitted via POST /amend.
function AmendLineForm({
  costCodes,
  boqItems,
  onAmend,
}: {
  costCodes: CostCode[];
  boqItems: BoqItem[];
  onAmend: (input: LineFormValues) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [description, setDescription] = useState("");
  const [quantity, setQuantity] = useState("");
  const [rate, setRate] = useState("");
  const [costCodeId, setCostCodeId] = useState("");
  const [boqItemId, setBoqItemId] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onConfirmAmend() {
    setError(null);
    setSubmitting(true);
    try {
      await onAmend({
        description,
        quantity: quantity ? Number(quantity) : undefined,
        rate: rate ? Number(rate) : undefined,
        costCodeId: costCodeId || undefined,
        boqItemId: boqItemId || undefined,
      });
      setConfirming(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("procurement.amendForm.genericError"));
      setConfirming(false);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="grid grid-cols-1 gap-2 rounded-md border border-stone-200 p-3 sm:grid-cols-5">
      {error && (
        <div className="sm:col-span-5">
          <ErrorState message={error} />
        </div>
      )}
      <LineFields
        description={description}
        setDescription={setDescription}
        quantity={quantity}
        setQuantity={setQuantity}
        rate={rate}
        setRate={setRate}
        costCodeId={costCodeId}
        setCostCodeId={setCostCodeId}
        boqItemId={boqItemId}
        setBoqItemId={setBoqItemId}
        costCodes={costCodes}
        boqItems={boqItems}
      />
      <Button type="button" size="sm" disabled={!description} onClick={() => setConfirming(true)} className="sm:col-span-5">
        {t("procurement.amendForm.addAmendment")}
      </Button>

      <ConfirmDialog
        open={confirming}
        title={t("procurement.amendForm.confirmTitle")}
        message={t("procurement.amendForm.confirmMessage")}
        confirmLabel={submitting ? t("procurement.amendForm.saving") : t("procurement.amendForm.confirmLabel")}
        onConfirm={onConfirmAmend}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
