import { useEffect, useState, type FormEvent } from "react";
import { PageHeader } from "../../ui/PageHeader";
import { Card } from "../../ui/Card";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { FinancialTable, type FinancialColumn } from "../../ui/FinancialTable";
import { ErrorState } from "../../ui/ErrorState";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Skeleton } from "../../ui/Skeleton";
import { Can } from "../../auth/Can";
import { formatQuantity, formatMoney, formatDate, formatDateTime } from "../../lib/format";
import { listContracts } from "../../api/contracts";
import { listRevisions, getRevision } from "../../api/boq";
import {
  listMeasurements,
  getMeasurement,
  createMeasurement,
  addMeasurementLine,
  deleteMeasurementLine,
  submitMeasurement,
  approveMeasurement,
  rejectMeasurement,
} from "../../api/measurements";
import { ApiError } from "../../api/client";
import type {
  BoqItem,
  BoqRevision,
  Contract,
  Measurement,
  MeasurementLine,
  MeasurementStatus,
  MeasurementWithLines,
} from "../../api/types";
import { useProjectContext } from "../context";
import { useTranslation } from "../../i18n/I18nProvider";

const statusTone: Record<MeasurementStatus, "neutral" | "success" | "warning" | "info" | "danger"> = {
  draft: "warning",
  submitted: "info",
  approved: "success",
  rejected: "danger",
};
const EDITABLE_STATUSES: MeasurementStatus[] = ["draft", "rejected"];

// Measurement / Progress (UI-04) — the frontend for the existing,
// fully-tested server/src/routes/measurements.ts. The backend owns every
// state transition, every line's frozen value, and the cumulative
// approved-quantity check at approval time; this screen only displays and
// reflects what it returns. Non-financial: never a certification or
// payment value — that is IPC's job, deliberately out of scope here.
export function ProgressSection() {
  const { t, locale } = useTranslation();
  const { projectId } = useProjectContext();
  const [measurements, setMeasurements] = useState<Measurement[] | null>(null);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [publishedRevisions, setPublishedRevisions] = useState<BoqRevision[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  function load() {
    setError(null);
    setMeasurements(null);
    Promise.all([listMeasurements(projectId), listContracts(projectId), listRevisions(projectId)])
      .then(([measurementRows, contractRows, revisionRows]) => {
        setMeasurements(measurementRows);
        setContracts(contractRows);
        setPublishedRevisions(revisionRows.filter((r) => r.status === "published"));
      })
      .catch((err) => setError(err instanceof Error ? err.message : t("progress.loadError")));
  }
  useEffect(load, [projectId]);

  const contractLabel = (id: string) => {
    const c = contracts.find((x) => x.id === id);
    return c ? (c.contractNumber ?? c.id.slice(0, 8)) : "—";
  };

  const columns: FinancialColumn<Measurement>[] = [
    { key: "measurementDate", header: t("progress.columns.measurementDate"), render: (m) => formatDate(m.measurementDate, locale) },
    { key: "contract", header: t("progress.columns.contract"), render: (m) => contractLabel(m.contractId) },
    { key: "description", header: t("progress.columns.description"), render: (m) => m.description ?? "—" },
    { key: "status", header: t("progress.columns.status"), render: (m) => <Badge tone={statusTone[m.status]}>{t(`progress.status.${m.status}`)}</Badge> },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("progress.title")}
        actions={
          <Button size="sm" onClick={() => setShowCreate((v) => !v)} disabled={contracts.length === 0}>
            {showCreate ? t("common.cancel") : t("progress.newMeasurement")}
          </Button>
        }
      />

      {contracts.length === 0 && measurements !== null && (
        <p className="text-sm text-stone-400">{t("progress.needsContractFirst")}</p>
      )}

      {showCreate && (
        <MeasurementCreateForm
          projectId={projectId}
          contracts={contracts}
          publishedRevisions={publishedRevisions}
          onCreated={(measurement) => {
            setShowCreate(false);
            setSelectedId(measurement.id);
            load();
          }}
        />
      )}

      <FinancialTable
        columns={columns}
        rows={measurements}
        rowKey={(m) => m.id}
        error={error}
        onRetry={load}
        emptyMessage={t("progress.emptyMessage")}
        rowActions={(m) => (
          <button type="button" onClick={() => setSelectedId(m.id)} className="text-sm text-primary hover:underline">
            {t("progress.view")}
          </button>
        )}
      />

      {selectedId && (
        <MeasurementDetail projectId={projectId} measurementId={selectedId} contracts={contracts} onChanged={load} />
      )}
    </div>
  );
}

function MeasurementCreateForm({
  projectId,
  contracts,
  publishedRevisions,
  onCreated,
}: {
  projectId: string;
  contracts: Contract[];
  publishedRevisions: BoqRevision[];
  onCreated: (measurement: Measurement) => void;
}) {
  const { t } = useTranslation();
  const [contractId, setContractId] = useState(contracts[0]?.id ?? "");
  const [measurementDate, setMeasurementDate] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // A contract can have at most one published BOQ revision at a time (see
  // boq.ts's publish route), so this is the single revision this
  // measurement will be taken against — never picked directly by the user.
  const revision = publishedRevisions.find((r) => r.contractId === contractId) ?? null;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!revision) return;
    setError(null);
    setSubmitting(true);
    try {
      const measurement = await createMeasurement(projectId, {
        contractId,
        boqRevisionId: revision.id,
        measurementDate,
        description: description || undefined,
      });
      onCreated(measurement);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("progress.createForm.genericError"));
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
          required
          type="date"
          value={measurementDate}
          onChange={(e) => setMeasurementDate(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <input
          placeholder={t("progress.createForm.descriptionPlaceholder")}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        {!revision && contractId && (
          <p className="text-sm text-danger-600 sm:col-span-3">{t("progress.createForm.noPublishedBoq")}</p>
        )}
        <Button type="submit" disabled={submitting || !revision} className="sm:col-span-3">
          {submitting ? t("progress.createForm.saving") : t("progress.createForm.create")}
        </Button>
      </form>
    </Card>
  );
}

type PendingAction = "submit" | "approve" | null;

function confirmCopyFor(t: (key: string) => string): Record<Exclude<PendingAction, null>, { title: string; message: string; confirmLabel: string }> {
  return {
    submit: {
      title: t("progress.confirm.submitTitle"),
      message: t("progress.confirm.submitMessage"),
      confirmLabel: t("progress.confirm.submitLabel"),
    },
    approve: {
      title: t("progress.confirm.approveTitle"),
      message: t("progress.confirm.approveMessage"),
      confirmLabel: t("progress.confirm.approveLabel"),
    },
  };
}

function MeasurementDetail({
  projectId,
  measurementId,
  contracts,
  onChanged,
}: {
  projectId: string;
  measurementId: string;
  contracts: Contract[];
  onChanged: () => void;
}) {
  const { t, locale } = useTranslation();
  const confirmCopy = confirmCopyFor(t);
  const [measurement, setMeasurement] = useState<MeasurementWithLines | null>(null);
  const [boqItems, setBoqItems] = useState<BoqItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showAddLine, setShowAddLine] = useState(false);
  const [showReject, setShowReject] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [actingBusy, setActingBusy] = useState(false);

  function load() {
    setError(null);
    setMeasurement(null);
    getMeasurement(projectId, measurementId)
      .then((m) => {
        setMeasurement(m);
        // Line picker must be scoped to THIS measurement's own
        // boqRevisionId exactly — stricter than Commitment's "any
        // published revision, any project item".
        return getRevision(projectId, m.boqRevisionId).then((rev) => {
          setBoqItems(rev.items.filter((i) => i.itemType === "item" && i.quantity !== null));
        });
      })
      .catch((err) => setError(err instanceof Error ? err.message : t("progress.detail.loadError")));
  }
  useEffect(load, [projectId, measurementId]);

  async function onConfirmAction() {
    if (!pendingAction) return;
    setActingBusy(true);
    try {
      if (pendingAction === "submit") await submitMeasurement(projectId, measurementId);
      else if (pendingAction === "approve") await approveMeasurement(projectId, measurementId);
      setPendingAction(null);
      load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("progress.detail.actionError"));
      setPendingAction(null);
    } finally {
      setActingBusy(false);
    }
  }

  async function onDeleteLine(lineId: string) {
    try {
      await deleteMeasurementLine(projectId, measurementId, lineId);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("progress.detail.deleteLineError"));
    }
  }

  if (error && !measurement) return <ErrorState message={error} onRetry={load} />;
  if (!measurement) return <Skeleton rows={5} />;

  const contractLabel = contracts.find((c) => c.id === measurement.contractId)?.contractNumber ?? measurement.contractId.slice(0, 8);
  const boqItemLabel = (id: string) => {
    const item = boqItems.find((x) => x.id === id);
    return item ? (item.code ? `${item.code} — ${item.description}` : item.description) : "—";
  };

  const isEditable = EDITABLE_STATUSES.includes(measurement.status);
  const isSubmitted = measurement.status === "submitted";

  const lineColumns: FinancialColumn<MeasurementLine>[] = [
    { key: "boqItem", header: t("progress.detail.lineColumns.boqItem"), render: (l) => boqItemLabel(l.boqItemId) },
    { key: "measuredQuantity", header: t("progress.detail.lineColumns.measuredQuantity"), align: "end", render: (l) => formatQuantity(l.measuredQuantity, null, locale) },
    { key: "value", header: t("progress.detail.lineColumns.value"), align: "end", render: (l) => (l.value !== null ? formatMoney(l.value, "SAR", locale) : "—") },
    { key: "notes", header: t("progress.detail.lineColumns.notes"), render: (l) => l.notes ?? "—" },
  ];

  return (
    <Card className="p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold text-stone-800">{t("progress.detail.title", { date: formatDate(measurement.measurementDate, locale) })}</h2>
          <Badge tone={statusTone[measurement.status]}>{t(`progress.status.${measurement.status}`)}</Badge>
        </div>
        <div className="flex flex-wrap gap-2">
          {/* Deliberately ungated (no <Can/>): create/add-line/remove-line/
              submit carry no requirePermission gate server-side — physical
              progress recording is operational site work, matching the
              posture already established for Actual Cost's expense CRUD. */}
          {isEditable && (
            <Button size="sm" variant="secondary" onClick={() => setShowAddLine((v) => !v)}>
              {showAddLine ? t("common.cancel") : t("progress.detail.addLine")}
            </Button>
          )}
          {isEditable && (
            <Button size="sm" disabled={measurement.lines.length === 0} onClick={() => setPendingAction("submit")}>
              {t("progress.detail.submitForApproval")}
            </Button>
          )}
          <Can permission="measurement.approve">
            {isSubmitted && (
              <Button size="sm" onClick={() => setPendingAction("approve")}>
                {t("progress.detail.approve")}
              </Button>
            )}
            {isSubmitted && (
              <Button size="sm" variant="danger" onClick={() => setShowReject((v) => !v)}>
                {showReject ? t("common.cancel") : t("progress.detail.reject")}
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

      <dl className="mb-5 grid grid-cols-1 gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
        <Field label={t("progress.detail.fields.contract")} value={contractLabel} />
        <Field label={t("progress.detail.fields.measurementDate")} value={formatDate(measurement.measurementDate, locale)} />
        <Field label={t("progress.detail.fields.description")} value={measurement.description ?? "—"} />
        <Field label={t("progress.detail.fields.submittedAt")} value={formatDateTime(measurement.submittedAt, locale)} />
        <Field label={t("progress.detail.fields.approvedAt")} value={formatDateTime(measurement.approvedAt, locale)} />
        {measurement.status === "rejected" && (
          <>
            <Field label={t("progress.detail.fields.rejectedAt")} value={formatDateTime(measurement.rejectedAt, locale)} />
            <Field label={t("progress.detail.fields.rejectionReason")} value={measurement.rejectionReason ?? "—"} />
          </>
        )}
      </dl>

      {showAddLine && isEditable && (
        <div className="mb-4">
          <MeasurementLineForm
            boqItems={boqItems}
            onSubmit={async (input) => {
              await addMeasurementLine(projectId, measurementId, input);
              setShowAddLine(false);
              load();
            }}
          />
        </div>
      )}

      {showReject && isSubmitted && (
        <div className="mb-4">
          <Can permission="measurement.approve">
            <RejectForm
              onReject={async (reason) => {
                await rejectMeasurement(projectId, measurementId, reason);
                setShowReject(false);
                load();
                onChanged();
              }}
            />
          </Can>
        </div>
      )}

      <FinancialTable
        columns={lineColumns}
        rows={measurement.lines}
        rowKey={(l) => l.id}
        emptyMessage={t("progress.detail.emptyLines")}
        rowActions={
          isEditable
            ? (line) => (
                <button type="button" onClick={() => onDeleteLine(line.id)} className="text-sm text-danger-600 hover:underline">
                  {t("common.delete")}
                </button>
              )
            : undefined
        }
      />

      <ConfirmDialog
        open={pendingAction !== null}
        title={pendingAction ? confirmCopy[pendingAction].title : ""}
        message={pendingAction ? confirmCopy[pendingAction].message : ""}
        confirmLabel={actingBusy ? t("progress.confirm.executing") : pendingAction ? confirmCopy[pendingAction].confirmLabel : ""}
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

function MeasurementLineForm({
  boqItems,
  onSubmit,
}: {
  boqItems: BoqItem[];
  onSubmit: (input: { boqItemId: string; measuredQuantity: number; notes?: string }) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [boqItemId, setBoqItemId] = useState(boqItems[0]?.id ?? "");
  const [measuredQuantity, setMeasuredQuantity] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit({ boqItemId, measuredQuantity: Number(measuredQuantity), notes: notes || undefined });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("progress.lineForm.genericError"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-2 rounded-md border border-stone-200 p-3 sm:grid-cols-4">
      {error && (
        <div className="sm:col-span-4">
          <ErrorState message={error} />
        </div>
      )}
      <select
        required
        value={boqItemId}
        onChange={(e) => setBoqItemId(e.target.value)}
        className="rounded-md border border-stone-300 px-3 py-2 text-sm sm:col-span-2"
      >
        {boqItems.length === 0 && <option value="">{t("progress.lineForm.noItems")}</option>}
        {boqItems.map((i) => (
          <option key={i.id} value={i.id}>
            {i.code ? `${i.code} — ${i.description}` : i.description}
          </option>
        ))}
      </select>
      <input
        required
        type="number"
        min="0"
        step="0.001"
        placeholder={t("progress.lineForm.quantityPlaceholder")}
        value={measuredQuantity}
        onChange={(e) => setMeasuredQuantity(e.target.value)}
        className="rounded-md border border-stone-300 px-3 py-2 text-sm"
      />
      <input
        placeholder={t("progress.lineForm.notesPlaceholder")}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        className="rounded-md border border-stone-300 px-3 py-2 text-sm"
      />
      <Button type="submit" size="sm" disabled={submitting || !boqItemId} className="sm:col-span-4">
        {submitting ? t("progress.lineForm.saving") : t("progress.lineForm.addItem")}
      </Button>
    </form>
  );
}

// Rejection requires a reason (server-enforced, non-empty) — a dedicated
// small form rather than ConfirmDialog's plain message, since this action
// needs to collect that text before it can be confirmed at all.
function RejectForm({ onReject }: { onReject: (reason: string) => Promise<void> }) {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await onReject(reason);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("progress.rejectForm.genericError"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-2 rounded-md border border-stone-200 p-3">
      {error && <ErrorState message={error} />}
      <textarea
        required
        placeholder={t("progress.rejectForm.reasonPlaceholder")}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        rows={2}
      />
      <Button type="submit" size="sm" variant="danger" disabled={submitting || !reason.trim()}>
        {submitting ? t("progress.rejectForm.rejecting") : t("progress.rejectForm.confirmReject")}
      </Button>
    </form>
  );
}
