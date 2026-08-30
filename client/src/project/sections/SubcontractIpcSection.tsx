import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { PageHeader } from "../../ui/PageHeader";
import { Card } from "../../ui/Card";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { FinancialTable, type FinancialColumn } from "../../ui/FinancialTable";
import { ErrorState } from "../../ui/ErrorState";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Skeleton } from "../../ui/Skeleton";
import { Can } from "../../auth/Can";
import { formatQuantity, formatMoney, formatDate, formatDateTime, formatFileSize } from "../../lib/format";
import { getCommitment } from "../../api/commitments";
import { listSuppliers } from "../../api/suppliers";
import {
  listSubcontractIpcs,
  getSubcontractIpc,
  createSubcontractIpc,
  addSubcontractIpcLine,
  deleteSubcontractIpcLine,
  submitSubcontractIpc,
  approveSubcontractIpc,
  rejectSubcontractIpc,
  certifySubcontractIpc,
} from "../../api/subcontractIpcs";
import {
  listSubcontractIpcDocuments,
  uploadSubcontractIpcDocument,
  downloadSubcontractIpcDocument,
} from "../../api/subcontractIpcDocuments";
import { ApiError } from "../../api/client";
import type {
  CommitmentLine,
  CommitmentWithLines,
  Supplier,
  SubcontractIpc,
  SubcontractIpcDocument,
  SubcontractIpcLine,
  SubcontractIpcStatus,
  SubcontractIpcWithLines,
} from "../../api/types";
import { useProjectContext } from "../context";

const statusLabel: Record<SubcontractIpcStatus, string> = {
  draft: "مسودة",
  submitted: "بانتظار الاعتماد",
  approved: "معتمدة (بانتظار التصديق)",
  certified: "مصدَّقة",
  rejected: "مرفوضة",
};
const statusTone: Record<SubcontractIpcStatus, "neutral" | "success" | "warning" | "info" | "danger"> = {
  draft: "warning",
  submitted: "info",
  approved: "info",
  certified: "success",
  rejected: "danger",
};
const EDITABLE_STATUSES: SubcontractIpcStatus[] = ["draft", "rejected"];

// Subcontractor IPC (MIDAD Phase 2) — the payment-direction twin of Owner
// IPC (IpcSection.tsx), certifying against a subcontract Commitment's own
// committed quantity/amount, never against a BOQ item or Owner IPC's own
// ledger. The backend owns every state transition and every certified
// financial figure; this screen only displays what it returns. Entered
// only from an eligible active subcontract commitment in Procurement —
// this is not a second subcontract-management workflow, commitment
// creation/editing stays owned by ProcurementSection.
export function SubcontractIpcSection() {
  const { projectId } = useProjectContext();
  const { commitmentId } = useParams<{ commitmentId: string }>();
  const [commitment, setCommitment] = useState<CommitmentWithLines | null>(null);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [ipcs, setIpcs] = useState<SubcontractIpc[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  function load() {
    if (!commitmentId) return;
    setError(null);
    setIpcs(null);
    Promise.all([getCommitment(projectId, commitmentId), listSuppliers(), listSubcontractIpcs(projectId)])
      .then(([commitmentRow, supplierRows, ipcRows]) => {
        setCommitment(commitmentRow);
        setSuppliers(supplierRows);
        setIpcs(ipcRows.filter((i) => i.commitmentId === commitmentId));
      })
      .catch((err) => setError(err instanceof Error ? err.message : "تعذّر تحميل شهادات الدفع للمقاول الباطن"));
  }
  useEffect(load, [projectId, commitmentId]);

  if (!commitmentId) return null;

  const supplierName = commitment ? (suppliers.find((s) => s.id === commitment.supplierId)?.name ?? "—") : "—";

  const columns: FinancialColumn<SubcontractIpc>[] = [
    { key: "ipcNumber", header: "الرقم", render: (i) => `#${i.ipcNumber}` },
    { key: "period", header: "الفترة", render: (i) => `${formatDate(i.periodStart)} — ${formatDate(i.periodEnd)}` },
    { key: "status", header: "الحالة", render: (i) => <Badge tone={statusTone[i.status]}>{statusLabel[i.status]}</Badge> },
    { key: "grossValue", header: "الإجمالي", align: "end", render: (i) => (i.grossValue !== null ? formatMoney(i.grossValue, commitment?.currency) : "—") },
    { key: "retentionAmount", header: "الضمان المحتجز", align: "end", render: (i) => (i.retentionAmount !== null ? formatMoney(i.retentionAmount, commitment?.currency) : "—") },
    { key: "netCertified", header: "الصافي المصدَّق", align: "end", render: (i) => (i.netCertified !== null ? formatMoney(i.netCertified, commitment?.currency) : "—") },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="شهادات الدفع للمقاول الباطن"
        subtitle={commitment ? `عقد الباطن #${commitment.commitmentNumber} — ${supplierName}` : undefined}
        actions={
          <div className="flex items-center gap-2">
            <Link to={`/projects/${projectId}/procurement`} className="text-sm text-primary hover:underline">
              العودة إلى المشتريات
            </Link>
            <Can permission="subcontractIpc.manage">
              <Button size="sm" onClick={() => setShowCreate((v) => !v)}>
                {showCreate ? "إلغاء" : "+ شهادة جديدة"}
              </Button>
            </Can>
          </div>
        }
      />

      {showCreate && (
        <Can permission="subcontractIpc.manage">
          <SubcontractIpcCreateForm
            projectId={projectId}
            commitmentId={commitmentId}
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
        emptyMessage="لا توجد شهادات دفع لهذا العقد بعد"
        rowActions={(i) => (
          <button type="button" onClick={() => setSelectedId(i.id)} className="text-sm text-primary hover:underline">
            عرض
          </button>
        )}
      />

      {selectedId && commitment && (
        <SubcontractIpcDetail projectId={projectId} ipcId={selectedId} commitment={commitment} onChanged={load} />
      )}
    </div>
  );
}

function SubcontractIpcCreateForm({
  projectId,
  commitmentId,
  onCreated,
}: {
  projectId: string;
  commitmentId: string;
  onCreated: (result: { id: string }) => void;
}) {
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await createSubcontractIpc(projectId, { commitmentId, periodStart, periodEnd, notes: notes || undefined });
      onCreated(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر إنشاء الشهادة");
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
        <Button type="submit" disabled={submitting} className="sm:col-span-3">
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
    message: "هذه مراجعة تحريرية أولية فقط، ولا تُصدِّق القيم بعد — التصديق الفعلي خطوة منفصلة لاحقة. هل تريد المتابعة؟",
    confirmLabel: "اعتماد",
  },
  certify: {
    title: "تصديق الشهادة",
    message:
      "بعد التصديق تصبح القيم المالية لهذه الشهادة (الإجمالي والاستقطاع والصافي) نهائية ومجمَّدة، ولا يمكن التراجع عن هذا الإجراء.",
    confirmLabel: "تصديق",
    destructive: true,
  },
};

function SubcontractIpcDetail({
  projectId,
  ipcId,
  commitment,
  onChanged,
}: {
  projectId: string;
  ipcId: string;
  commitment: CommitmentWithLines;
  onChanged: () => void;
}) {
  const [ipc, setIpc] = useState<SubcontractIpcWithLines | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAddLine, setShowAddLine] = useState(false);
  const [showReject, setShowReject] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [actingBusy, setActingBusy] = useState(false);

  function load() {
    setError(null);
    setIpc(null);
    getSubcontractIpc(projectId, ipcId)
      .then(setIpc)
      .catch((err) => setError(err instanceof Error ? err.message : "تعذّر تحميل تفاصيل الشهادة"));
  }
  useEffect(load, [projectId, ipcId]);

  async function onConfirmAction() {
    // actingBusy guards against a second click firing a duplicate mutation
    // while the first request is still in flight.
    if (!pendingAction || actingBusy) return;
    setActingBusy(true);
    try {
      if (pendingAction === "submit") await submitSubcontractIpc(projectId, ipcId);
      else if (pendingAction === "approve") await approveSubcontractIpc(projectId, ipcId);
      else if (pendingAction === "certify") await certifySubcontractIpc(projectId, ipcId);
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
      await deleteSubcontractIpcLine(projectId, ipcId, lineId);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر حذف البند");
    }
  }

  if (error && !ipc) return <ErrorState message={error} onRetry={load} />;
  if (!ipc) return <Skeleton rows={6} />;

  const commitmentLineLabel = (id: string) => {
    const line = commitment.lines.find((l) => l.id === id);
    return line ? line.description : "—";
  };

  const isEditable = EDITABLE_STATUSES.includes(ipc.status);
  const isSubmitted = ipc.status === "submitted";
  const isApproved = ipc.status === "approved";

  const lineColumns: FinancialColumn<SubcontractIpcLine>[] = [
    { key: "commitmentLine", header: "بند الالتزام", render: (l) => commitmentLineLabel(l.commitmentLineId) },
    { key: "currentQuantity", header: "الكمية الحالية", align: "end", render: (l) => (l.currentQuantity !== null ? formatQuantity(l.currentQuantity) : "—") },
    { key: "rate", header: "السعر", align: "end", render: (l) => (l.rate !== null ? formatMoney(l.rate, commitment.currency) : "—") },
    { key: "currentValue", header: "القيمة الحالية", align: "end", render: (l) => formatMoney(l.currentValue, commitment.currency) },
    { key: "cumulativeQuantity", header: "الكمية التراكمية", align: "end", render: (l) => (l.cumulativeQuantity !== null ? formatQuantity(l.cumulativeQuantity) : "—") },
    { key: "cumulativeValue", header: "القيمة التراكمية", align: "end", render: (l) => (l.cumulativeValue !== null ? formatMoney(l.cumulativeValue, commitment.currency) : "—") },
  ];

  return (
    <Card className="p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold text-stone-800">شهادة #{ipc.ipcNumber}</h2>
          <Badge tone={statusTone[ipc.status]}>{statusLabel[ipc.status]}</Badge>
        </div>
        {/* Every mutation here requires subcontractIpc.manage (owner-only). */}
        <Can permission="subcontractIpc.manage">
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
        <Field label="الإجمالي (Gross)" value={ipc.grossValue !== null ? formatMoney(ipc.grossValue, ipc.currency) : "—"} />
        <Field label="نسبة الضمان" value={ipc.retentionPercent !== null ? `${ipc.retentionPercent}%` : "—"} />
        <Field label="الضمان المحتجز" value={ipc.retentionAmount !== null ? formatMoney(ipc.retentionAmount, ipc.currency) : "—"} />
        <Field label="خصومات أخرى" value={ipc.otherDeductions !== null ? formatMoney(ipc.otherDeductions, ipc.currency) : "—"} />
        <Field label="الصافي المصدَّق" value={ipc.netCertified !== null ? formatMoney(ipc.netCertified, ipc.currency) : "—"} />
      </div>

      {showAddLine && isEditable && (
        <div className="mb-4">
          <Can permission="subcontractIpc.manage">
            <SubcontractIpcLineForm
              commitmentLines={commitment.lines}
              onSubmit={async (input) => {
                await addSubcontractIpcLine(projectId, ipcId, input);
                setShowAddLine(false);
                load();
              }}
            />
          </Can>
        </div>
      )}

      {showReject && isSubmitted && (
        <div className="mb-4">
          <Can permission="subcontractIpc.manage">
            <RejectForm
              onReject={async (reason) => {
                await rejectSubcontractIpc(projectId, ipcId, reason);
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
                <Can permission="subcontractIpc.manage">
                  <button type="button" onClick={() => onDeleteLine(line.id)} className="text-sm text-danger-600 hover:underline">
                    حذف
                  </button>
                </Can>
              )
            : undefined
        }
      />

      <div className="mt-5">
        <SubcontractIpcEvidence projectId={projectId} ipcId={ipcId} />
      </div>

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

// MIDAD Phase 3 — Subcontractor IPC Evidence. Purely additive attachments
// for this IPC (site photos, delivery notes, subcontractor invoices) —
// never a financial figure, never affects grossValue/retentionAmount/
// netCertified, and available regardless of the IPC's status (evidence can
// legitimately be attached before, during, or after certification). Read
// (list/download) is member-open; upload requires subcontractIpc.manage,
// the same permission every other mutation on this IPC already requires.
// No delete — the storage layer has no delete capability at all.
const EVIDENCE_ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);
const EVIDENCE_MAX_SIZE = 10 * 1024 * 1024;
const EVIDENCE_ACCEPT_ATTR = ".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.xls,.xlsx";

function SubcontractIpcEvidence({ projectId, ipcId }: { projectId: string; ipcId: string }) {
  const [documents, setDocuments] = useState<SubcontractIpcDocument[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function load() {
    setError(null);
    setDocuments(null);
    listSubcontractIpcDocuments(projectId, ipcId)
      .then(setDocuments)
      .catch((err) => setError(err instanceof Error ? err.message : "تعذّر تحميل مرفقات الشهادة"));
  }
  useEffect(load, [projectId, ipcId]);

  function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    setUploadError(null);
    const file = e.target.files?.[0] ?? null;
    setSelectedFile(file);
    if (!file) {
      setValidationError(null);
      return;
    }
    if (!EVIDENCE_ALLOWED_MIME_TYPES.has(file.type)) {
      setValidationError("نوع الملف غير مسموح به. الأنواع المسموحة: PDF، صور (PNG, JPEG, WEBP)، مستندات Word أو Excel");
      return;
    }
    if (file.size > EVIDENCE_MAX_SIZE) {
      setValidationError("حجم الملف يتجاوز الحد الأقصى المسموح به (10 ميجابايت)");
      return;
    }
    setValidationError(null);
  }

  async function onUpload() {
    if (!selectedFile || validationError || uploading) return;
    setUploading(true);
    setUploadError(null);
    try {
      await uploadSubcontractIpcDocument(projectId, ipcId, selectedFile);
      setSelectedFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      load();
    } catch (err) {
      setUploadError(err instanceof ApiError ? err.message : "تعذّر رفع الملف");
    } finally {
      setUploading(false);
    }
  }

  const columns: FinancialColumn<SubcontractIpcDocument>[] = [
    {
      key: "fileName",
      header: "اسم الملف",
      render: (d) => (
        <span className="block max-w-xs truncate" title={d.fileName}>
          {d.fileName}
        </span>
      ),
    },
    { key: "size", header: "الحجم", align: "end", render: (d) => formatFileSize(d.size) },
    { key: "uploadedAt", header: "تاريخ الرفع", render: (d) => formatDate(d.uploadedAt) },
    { key: "uploadedByName", header: "بواسطة", render: (d) => d.uploadedByName ?? "—" },
  ];

  return (
    <div>
      <h3 className="mb-3 font-semibold text-stone-800">مرفقات الشهادة</h3>

      <Can permission="subcontractIpc.manage">
        <div className="mb-4 rounded-md border border-stone-200 p-3">
          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={fileInputRef}
              type="file"
              accept={EVIDENCE_ACCEPT_ATTR}
              onChange={onFileChange}
              className="text-sm text-stone-600 file:mr-3 file:rounded-md file:border-0 file:bg-stone-100 file:px-3 file:py-1.5 file:text-sm file:text-stone-700"
            />
            <Button size="sm" onClick={onUpload} disabled={!selectedFile || !!validationError || uploading}>
              {uploading ? "جارٍ الرفع..." : "رفع مرفق"}
            </Button>
          </div>
          {validationError && <p className="mt-2 text-xs text-danger-600">{validationError}</p>}
          {uploadError && (
            <div className="mt-3">
              <ErrorState message={uploadError} />
            </div>
          )}
        </div>
      </Can>

      <FinancialTable
        columns={columns}
        rows={documents}
        rowKey={(d) => d.id}
        error={documents === null ? error : null}
        onRetry={load}
        emptyMessage="لا توجد مرفقات لهذه الشهادة بعد"
        rowActions={(d) => (
          <button
            type="button"
            onClick={() => downloadSubcontractIpcDocument(projectId, ipcId, d.id, d.fileName)}
            className="text-sm text-primary hover:underline"
          >
            تنزيل
          </button>
        )}
      />
    </div>
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

// A commitment line is either quantity/rate-typed or amount-only — the
// form shows exactly the fields that apply and sends exactly one of
// currentQuantity/currentValue, never inventing the other.
function SubcontractIpcLineForm({
  commitmentLines,
  onSubmit,
}: {
  commitmentLines: CommitmentLine[];
  onSubmit: (input: { commitmentLineId: string; currentQuantity?: number; currentValue?: number; description?: string }) => Promise<void>;
}) {
  const [commitmentLineId, setCommitmentLineId] = useState(commitmentLines[0]?.id ?? "");
  const [currentQuantity, setCurrentQuantity] = useState("");
  const [currentValue, setCurrentValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const selectedLine = commitmentLines.find((l) => l.id === commitmentLineId) ?? null;
  const isQuantityRateLine = selectedLine !== null && selectedLine.quantity !== null && selectedLine.rate !== null;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit({
        commitmentLineId,
        currentQuantity: isQuantityRateLine ? Number(currentQuantity) : undefined,
        currentValue: !isQuantityRateLine ? Number(currentValue) : undefined,
      });
      setCurrentQuantity("");
      setCurrentValue("");
    } catch (err) {
      // Surfaces the backend's own message verbatim — e.g. an overrun
      // against the commitment line's own remaining ceiling. This form
      // never recreates that check itself.
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
        value={commitmentLineId}
        onChange={(e) => setCommitmentLineId(e.target.value)}
        className="rounded-md border border-stone-300 px-3 py-2 text-sm sm:col-span-2"
      >
        {commitmentLines.length === 0 && <option value="">لا توجد بنود في هذا الالتزام</option>}
        {commitmentLines.map((l) => (
          <option key={l.id} value={l.id}>
            {l.description}
          </option>
        ))}
      </select>

      {selectedLine && isQuantityRateLine && (
        <>
          <div className="text-sm text-stone-500 sm:col-span-1">
            الكمية المتعاقد عليها: {formatQuantity(selectedLine.quantity!)} — السعر: {formatMoney(selectedLine.rate!)}
          </div>
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
        </>
      )}

      {selectedLine && !isQuantityRateLine && (
        <>
          <div className="text-sm text-stone-500 sm:col-span-1">المبلغ المتعاقد عليه: {formatMoney(selectedLine.amount)}</div>
          <input
            required
            type="number"
            min="0"
            step="0.01"
            placeholder="قيمة التصديق الحالية"
            value={currentValue}
            onChange={(e) => setCurrentValue(e.target.value)}
            className="rounded-md border border-stone-300 px-3 py-2 text-sm"
          />
        </>
      )}

      <Button type="submit" size="sm" disabled={submitting || !commitmentLineId} className="sm:col-span-4">
        {submitting ? "جارٍ الحفظ..." : "إضافة البند"}
      </Button>
    </form>
  );
}

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
