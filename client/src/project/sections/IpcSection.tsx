import { useEffect, useState, type FormEvent } from "react";
import { PageHeader } from "../../ui/PageHeader";
import { Card } from "../../ui/Card";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { MetricCard } from "../../ui/MetricCard";
import { FinancialTable, type FinancialColumn } from "../../ui/FinancialTable";
import { ErrorState } from "../../ui/ErrorState";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Skeleton } from "../../ui/Skeleton";
import { Can } from "../../auth/Can";
import { formatQuantity, formatMoney, formatDate, formatDateTime } from "../../lib/format";
import { listContracts } from "../../api/contracts";
import { listRevisions, getRevision } from "../../api/boq";
import {
  listIpcs,
  getIpc,
  createIpc,
  addIpcLine,
  deleteIpcLine,
  submitIpc,
  approveIpc,
  rejectIpc,
  certifyIpc,
} from "../../api/ipcs";
import { ApiError } from "../../api/client";
import type { BoqItem, BoqRevision, Contract, Ipc, IpcLine, IpcStatus, IpcWithLines } from "../../api/types";
import { useProjectContext } from "../context";

const statusLabel: Record<IpcStatus, string> = {
  draft: "مسودة",
  submitted: "بانتظار الاعتماد",
  approved: "معتمدة (بانتظار التصديق)",
  certified: "مصدَّقة",
  rejected: "مرفوضة",
};
const statusTone: Record<IpcStatus, "neutral" | "success" | "warning" | "info" | "danger"> = {
  draft: "warning",
  submitted: "info",
  approved: "info",
  certified: "success",
  rejected: "danger",
};
const EDITABLE_STATUSES: IpcStatus[] = ["draft", "rejected"];

// IPC / Interim Payment Certificate (UI-07) — the frontend for the
// existing, fully-tested server/src/routes/ipcs.ts. The backend owns
// every state transition and every certified financial figure
// (grossValue/retentionAmount/netCertified and each line's
// currentValue/previousCertifiedQuantity/cumulativeQuantity); this
// screen only displays what it returns, never recomputes any of it.
// Unlike Measurement, EVERY mutation here (create, add/remove line,
// submit, approve, reject, certify) requires `ipc.manage` (owner-only) —
// a certified billing document carries real contractual consequence, so
// nothing about it is member-writable, only member-readable.
export function IpcSection() {
  const { projectId } = useProjectContext();
  const [ipcs, setIpcs] = useState<Ipc[] | null>(null);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [publishedRevisions, setPublishedRevisions] = useState<BoqRevision[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  function load() {
    setError(null);
    setIpcs(null);
    Promise.all([listIpcs(projectId), listContracts(projectId), listRevisions(projectId)])
      .then(([ipcRows, contractRows, revisionRows]) => {
        setIpcs(ipcRows);
        setContracts(contractRows);
        setPublishedRevisions(revisionRows.filter((r) => r.status === "published"));
      })
      .catch((err) => setError(err instanceof Error ? err.message : "تعذّر تحميل شهادات الدفع"));
  }
  useEffect(load, [projectId]);

  const contractLabel = (id: string) => {
    const c = contracts.find((x) => x.id === id);
    return c ? (c.contractNumber ?? c.id.slice(0, 8)) : "—";
  };

  const columns: FinancialColumn<Ipc>[] = [
    { key: "ipcNumber", header: "الرقم", render: (i) => `#${i.ipcNumber}` },
    { key: "contract", header: "العقد", render: (i) => contractLabel(i.contractId) },
    { key: "period", header: "الفترة", render: (i) => `${formatDate(i.periodStart)} — ${formatDate(i.periodEnd)}` },
    { key: "status", header: "الحالة", render: (i) => <Badge tone={statusTone[i.status]}>{statusLabel[i.status]}</Badge> },
    { key: "netCertified", header: "الصافي المصدَّق", align: "end", render: (i) => (i.netCertified !== null ? formatMoney(i.netCertified, i.currency) : "—") },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="شهادات الدفع (IPC)"
        actions={
          <Can permission="ipc.manage">
            <Button size="sm" onClick={() => setShowCreate((v) => !v)} disabled={contracts.length === 0}>
              {showCreate ? "إلغاء" : "+ شهادة جديدة"}
            </Button>
          </Can>
        }
      />

      {contracts.length === 0 && ipcs !== null && (
        <p className="text-sm text-stone-400">يجب إضافة عقد أولاً من قسم "العقد" قبل إنشاء شهادة دفع.</p>
      )}

      {showCreate && (
        <Can permission="ipc.manage">
          <IpcCreateForm
            projectId={projectId}
            contracts={contracts}
            publishedRevisions={publishedRevisions}
            onCreated={(created) => {
              setShowCreate(false);
              setSelectedId(created.id);
              load();
            }}
          />
        </Can>
      )}

      <FinancialTable
        columns={columns}
        rows={ipcs}
        rowKey={(i) => i.id}
        error={error}
        onRetry={load}
        emptyMessage="لا توجد شهادات دفع بعد"
        rowActions={(i) => (
          <button type="button" onClick={() => setSelectedId(i.id)} className="text-sm text-primary hover:underline">
            عرض
          </button>
        )}
      />

      {selectedId && <IpcDetail projectId={projectId} ipcId={selectedId} contracts={contracts} onChanged={load} />}
    </div>
  );
}

function IpcCreateForm({
  projectId,
  contracts,
  publishedRevisions,
  onCreated,
}: {
  projectId: string;
  contracts: Contract[];
  publishedRevisions: BoqRevision[];
  onCreated: (result: { id: string }) => void;
}) {
  const [contractId, setContractId] = useState(contracts[0]?.id ?? "");
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // A contract can have at most one published BOQ revision at a time (see
  // boq.ts's publish route) — same discipline as Measurement/Commitment.
  const revision = publishedRevisions.find((r) => r.contractId === contractId) ?? null;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!revision) return;
    setError(null);
    setSubmitting(true);
    try {
      const result = await createIpc(projectId, {
        contractId,
        boqRevisionId: revision.id,
        periodStart,
        periodEnd,
        notes: notes || undefined,
      });
      onCreated(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر إنشاء الشهادة");
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
        <label className="text-sm text-stone-600">
          بداية الفترة
          <input
            required
            type="date"
            value={periodStart}
            onChange={(e) => setPeriodStart(e.target.value)}
            className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="text-sm text-stone-600">
          نهاية الفترة
          <input
            required
            type="date"
            value={periodEnd}
            onChange={(e) => setPeriodEnd(e.target.value)}
            className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
          />
        </label>
        <input
          placeholder="ملاحظات (اختياري)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        {!revision && contractId && (
          <p className="text-sm text-danger-600 sm:col-span-4">
            هذا العقد لا يحتوي على نسخة منشورة من جدول الكميات — يجب نشر جدول الكميات أولاً قبل إنشاء شهادة دفع عليه.
          </p>
        )}
        <Button type="submit" disabled={submitting || !revision} className="sm:col-span-4">
          {submitting ? "جارٍ الحفظ..." : "إنشاء الشهادة"}
        </Button>
      </form>
    </Card>
  );
}

type PendingAction = "submit" | "approve" | "certify" | null;

const confirmCopy: Record<Exclude<PendingAction, null>, { title: string; message: string; confirmLabel: string; destructive?: boolean }> = {
  submit: {
    title: "إرسال الشهادة للاعتماد",
    message: "بعد الإرسال لن يمكن إضافة أو حذف بنود هذه الشهادة إلا إذا تم رفضها. هل تريد المتابعة؟",
    confirmLabel: "إرسال",
  },
  approve: {
    title: "اعتماد الشهادة",
    message: "هذه مراجعة تحريرية أولية فقط، ولا تُصدِّق الكميات بعد — التصديق الفعلي خطوة منفصلة لاحقة. هل تريد المتابعة؟",
    confirmLabel: "اعتماد",
  },
  certify: {
    title: "تصديق الشهادة",
    message:
      "بعد التصديق تصبح القيم المالية لهذه الشهادة (الإجمالي والاستقطاع والصافي) نهائية ومجمَّدة، وتُحتسب كمياتها بشكل نهائي ضمن السقف المعتمد لبنود جدول الكميات المرتبطة. لا يمكن التراجع عن هذا الإجراء.",
    confirmLabel: "تصديق",
    destructive: true,
  },
};

function IpcDetail({
  projectId,
  ipcId,
  contracts,
  onChanged,
}: {
  projectId: string;
  ipcId: string;
  contracts: Contract[];
  onChanged: () => void;
}) {
  const [ipc, setIpc] = useState<IpcWithLines | null>(null);
  const [boqItems, setBoqItems] = useState<BoqItem[]>([]);
  const [revisionNumber, setRevisionNumber] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAddLine, setShowAddLine] = useState(false);
  const [showReject, setShowReject] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [actingBusy, setActingBusy] = useState(false);

  function load() {
    setError(null);
    setIpc(null);
    getIpc(projectId, ipcId)
      .then((i) => {
        setIpc(i);
        // Line picker must be scoped to THIS IPC's own boqRevisionId
        // exactly — same discipline as Measurement's own line picker.
        return getRevision(projectId, i.boqRevisionId).then((rev) => {
          setRevisionNumber(rev.revisionNumber);
          setBoqItems(rev.items.filter((it) => it.itemType === "item" && it.rate !== null));
        });
      })
      .catch((err) => setError(err instanceof Error ? err.message : "تعذّر تحميل تفاصيل الشهادة"));
  }
  useEffect(load, [projectId, ipcId]);

  async function onConfirmAction() {
    if (!pendingAction) return;
    setActingBusy(true);
    try {
      if (pendingAction === "submit") await submitIpc(projectId, ipcId);
      else if (pendingAction === "approve") await approveIpc(projectId, ipcId);
      else if (pendingAction === "certify") await certifyIpc(projectId, ipcId);
      setPendingAction(null);
      load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر تنفيذ الإجراء");
      setPendingAction(null);
    } finally {
      setActingBusy(false);
    }
  }

  async function onDeleteLine(lineId: string) {
    try {
      await deleteIpcLine(projectId, ipcId, lineId);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر حذف البند");
    }
  }

  if (error && !ipc) return <ErrorState message={error} onRetry={load} />;
  if (!ipc) return <Skeleton rows={6} />;

  const contractLabel = contracts.find((c) => c.id === ipc.contractId)?.contractNumber ?? ipc.contractId.slice(0, 8);
  const boqItemLabel = (id: string) => {
    const item = boqItems.find((x) => x.id === id);
    return item ? (item.code ? `${item.code} — ${item.description}` : item.description) : "—";
  };

  const isEditable = EDITABLE_STATUSES.includes(ipc.status);
  const isSubmitted = ipc.status === "submitted";
  const isApproved = ipc.status === "approved";

  const lineColumns: FinancialColumn<IpcLine>[] = [
    { key: "boqItem", header: "بند جدول الكميات", render: (l) => boqItemLabel(l.boqItemId) },
    { key: "currentQuantity", header: "الكمية الحالية", align: "end", render: (l) => formatQuantity(l.currentQuantity) },
    { key: "rate", header: "السعر", align: "end", render: (l) => formatMoney(l.rate, ipc.currency) },
    { key: "currentValue", header: "القيمة الحالية", align: "end", render: (l) => formatMoney(l.currentValue, ipc.currency) },
    { key: "previousCertifiedQuantity", header: "الكمية المصدَّقة سابقاً", align: "end", render: (l) => (l.previousCertifiedQuantity !== null ? formatQuantity(l.previousCertifiedQuantity) : "—") },
    { key: "cumulativeQuantity", header: "الكمية التراكمية", align: "end", render: (l) => (l.cumulativeQuantity !== null ? formatQuantity(l.cumulativeQuantity) : "—") },
  ];

  return (
    <Card className="p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold text-stone-800">شهادة #{ipc.ipcNumber}</h2>
          <Badge tone={statusTone[ipc.status]}>{statusLabel[ipc.status]}</Badge>
        </div>
        {/* Every mutation on this screen requires ipc.manage (owner-only) —
            unlike Measurement, nothing here is member-writable. */}
        <Can permission="ipc.manage">
          <div className="flex flex-wrap gap-2">
            {isEditable && (
              <Button size="sm" variant="secondary" onClick={() => setShowAddLine((v) => !v)}>
                {showAddLine ? "إلغاء" : "+ بند"}
              </Button>
            )}
            {isEditable && (
              <Button size="sm" disabled={ipc.lines.length === 0} onClick={() => setPendingAction("submit")}>
                إرسال للاعتماد
              </Button>
            )}
            {isSubmitted && (
              <Button size="sm" onClick={() => setPendingAction("approve")}>
                اعتماد
              </Button>
            )}
            {isSubmitted && (
              <Button size="sm" variant="danger" onClick={() => setShowReject((v) => !v)}>
                {showReject ? "إلغاء" : "رفض"}
              </Button>
            )}
            {isApproved && (
              <Button size="sm" variant="danger" onClick={() => setPendingAction("certify")}>
                تصديق
              </Button>
            )}
          </div>
        </Can>
      </div>

      {error && (
        <div className="mb-4">
          <ErrorState message={error} />
        </div>
      )}

      <dl className="mb-5 grid grid-cols-1 gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
        <Field label="العقد" value={contractLabel} />
        <Field label="نسخة جدول الكميات" value={revisionNumber !== null ? `النسخة #${revisionNumber}` : "—"} />
        <Field label="بداية الفترة" value={formatDate(ipc.periodStart)} />
        <Field label="نهاية الفترة" value={formatDate(ipc.periodEnd)} />
        <Field label="ملاحظات" value={ipc.notes ?? "—"} />
        <Field label="العملة" value={ipc.currency} />
        <Field label="تاريخ الإرسال للاعتماد" value={formatDateTime(ipc.submittedAt)} />
        <Field label="تاريخ الاعتماد" value={formatDateTime(ipc.approvedAt)} />
        <Field label="تاريخ التصديق" value={formatDateTime(ipc.certifiedAt)} />
        {ipc.status === "rejected" && (
          <>
            <Field label="تاريخ الرفض" value={formatDateTime(ipc.rejectedAt)} />
            <Field label="سبب الرفض" value={ipc.rejectionReason ?? "—"} />
          </>
        )}
      </dl>

      <div className="mb-5 grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <MetricCard label="الإجمالي (Gross)" value={ipc.grossValue !== null ? formatMoney(ipc.grossValue, ipc.currency) : "—"} />
        <MetricCard label="استقطاع الضمان" value={ipc.retentionAmount !== null ? formatMoney(ipc.retentionAmount, ipc.currency) : "—"} />
        <MetricCard label="استرداد الدفعة المقدَّمة" value={ipc.advanceRecoveryAmount !== null ? formatMoney(ipc.advanceRecoveryAmount, ipc.currency) : "—"} />
        <MetricCard label="خصومات أخرى" value={ipc.otherDeductions !== null ? formatMoney(ipc.otherDeductions, ipc.currency) : "—"} />
        <MetricCard label="الصافي المصدَّق" value={ipc.netCertified !== null ? formatMoney(ipc.netCertified, ipc.currency) : "—"} tone={ipc.netCertified !== null ? "success" : "default"} />
      </div>

      {showAddLine && isEditable && (
        <div className="mb-4">
          <Can permission="ipc.manage">
            <IpcLineForm
              boqItems={boqItems}
              onSubmit={async (input) => {
                await addIpcLine(projectId, ipcId, input);
                setShowAddLine(false);
                load();
              }}
            />
          </Can>
        </div>
      )}

      {showReject && isSubmitted && (
        <div className="mb-4">
          <Can permission="ipc.manage">
            <RejectForm
              onReject={async (reason) => {
                await rejectIpc(projectId, ipcId, reason);
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
        rows={ipc.lines}
        rowKey={(l) => l.id}
        emptyMessage="لا توجد بنود في هذه الشهادة بعد"
        rowActions={
          isEditable
            ? (line) => (
                <Can permission="ipc.manage">
                  <button type="button" onClick={() => onDeleteLine(line.id)} className="text-sm text-danger-600 hover:underline">
                    حذف
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
        confirmLabel={actingBusy ? "جارٍ التنفيذ..." : pendingAction ? confirmCopy[pendingAction].confirmLabel : ""}
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

function IpcLineForm({
  boqItems,
  onSubmit,
}: {
  boqItems: BoqItem[];
  onSubmit: (input: { boqItemId: string; currentQuantity: number; description?: string }) => Promise<void>;
}) {
  const [boqItemId, setBoqItemId] = useState(boqItems[0]?.id ?? "");
  const [currentQuantity, setCurrentQuantity] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit({ boqItemId, currentQuantity: Number(currentQuantity), description: description || undefined });
    } catch (err) {
      // Surfaces the backend's own message verbatim — e.g. "الكمية
      // المطلوبة تتجاوز الكمية المعتمدة القابلة للتصديق لهذا البند" — the
      // backend remains the sole authority on certifiable-quantity limits;
      // this form never recreates that check.
      setError(err instanceof ApiError ? err.message : "تعذّر حفظ البند");
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
        {boqItems.length === 0 && <option value="">لا توجد بنود قابلة للتصديق</option>}
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
        placeholder="الكمية الحالية"
        value={currentQuantity}
        onChange={(e) => setCurrentQuantity(e.target.value)}
        className="rounded-md border border-stone-300 px-3 py-2 text-sm"
      />
      <input
        placeholder="وصف (اختياري)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        className="rounded-md border border-stone-300 px-3 py-2 text-sm"
      />
      <Button type="submit" size="sm" disabled={submitting || !boqItemId} className="sm:col-span-4">
        {submitting ? "جارٍ الحفظ..." : "إضافة البند"}
      </Button>
    </form>
  );
}

// Rejection requires a reason (server-enforced, non-empty) — same
// dedicated small-form pattern already proven in ProgressSection.tsx.
function RejectForm({ onReject }: { onReject: (reason: string) => Promise<void> }) {
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
      setError(err instanceof ApiError ? err.message : "تعذّر رفض الشهادة");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-2 rounded-md border border-stone-200 p-3">
      {error && <ErrorState message={error} />}
      <textarea
        required
        placeholder="سبب الرفض"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        rows={2}
      />
      <Button type="submit" size="sm" variant="danger" disabled={submitting || !reason.trim()}>
        {submitting ? "جارٍ الرفض..." : "تأكيد الرفض"}
      </Button>
    </form>
  );
}
