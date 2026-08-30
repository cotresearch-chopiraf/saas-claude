import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { PageHeader } from "../../ui/PageHeader";
import { Card } from "../../ui/Card";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { FinancialTable, type FinancialColumn } from "../../ui/FinancialTable";
import { ErrorState } from "../../ui/ErrorState";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Skeleton } from "../../ui/Skeleton";
import { Can } from "../../auth/Can";
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

const typeLabel: Record<CommitmentType, string> = { purchase_order: "أمر شراء", subcontract: "عقد باطن" };
const statusLabel: Record<CommitmentStatus, string> = {
  draft: "مسودة",
  pending_approval: "بانتظار الاعتماد",
  active: "نشط",
  partially_fulfilled: "منفَّذ جزئياً",
  closed: "مغلق",
  cancelled: "ملغى",
};
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
      .catch((err) => setError(err instanceof Error ? err.message : "تعذّر تحميل المشتريات والالتزامات"));
  }
  useEffect(load, [projectId]);

  const supplierLabel = (id: string) => suppliers.find((s) => s.id === id)?.name ?? "—";
  const contractLabel = (id: string | null) => {
    if (!id) return "—";
    const c = contracts.find((x) => x.id === id);
    return c ? (c.contractNumber ?? c.id.slice(0, 8)) : "—";
  };

  const columns: FinancialColumn<Commitment>[] = [
    { key: "commitmentNumber", header: "الرقم", render: (c) => `#${c.commitmentNumber}` },
    { key: "type", header: "النوع", render: (c) => typeLabel[c.type] },
    { key: "supplier", header: "المورد", render: (c) => supplierLabel(c.supplierId) },
    { key: "description", header: "الوصف", render: (c) => c.description ?? "—" },
    { key: "status", header: "الحالة", render: (c) => <Badge tone={statusTone[c.status]}>{statusLabel[c.status]}</Badge> },
    { key: "originalAmount", header: "القيمة الأصلية", align: "end", render: (c) => (c.originalAmount !== null ? formatMoney(c.originalAmount, c.currency) : "—") },
    { key: "revisedAmount", header: "القيمة المعدَّلة", align: "end", render: (c) => (c.revisedAmount !== null ? formatMoney(c.revisedAmount, c.currency) : "—") },
    { key: "currency", header: "العملة", render: (c) => c.currency },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="المشتريات والالتزامات"
        actions={
          <Can permission="commitment.manage">
            <Button size="sm" onClick={() => setShowCreate((v) => !v)} disabled={suppliers.length === 0}>
              {showCreate ? "إلغاء" : "+ التزام جديد"}
            </Button>
          </Can>
        }
      />

      {suppliers.length === 0 && commitments !== null && (
        <p className="text-sm text-stone-400">يجب إضافة مورد أولاً من قسم "الموردون" قبل إنشاء التزام.</p>
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
        emptyMessage="لا توجد التزامات (مشتريات) بعد"
        rowActions={(c) => (
          <button type="button" onClick={() => setSelectedId(c.id)} className="text-sm text-primary hover:underline">
            عرض
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
  const [supplierId, setSupplierId] = useState(suppliers[0]?.id ?? "");
  const [type, setType] = useState<CommitmentType>("purchase_order");
  const [contractId, setContractId] = useState("");
  const [description, setDescription] = useState("");
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
      });
      onCreated(commitment);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر إنشاء الالتزام");
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
          <option value="purchase_order">أمر شراء</option>
          <option value="subcontract">عقد باطن</option>
        </select>
        <select
          value={contractId}
          onChange={(e) => setContractId(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        >
          <option value="">بدون عقد محدد</option>
          {contracts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.contractNumber ?? c.id.slice(0, 8)}
            </option>
          ))}
        </select>
        <input
          placeholder="الوصف (اختياري)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm sm:col-span-2"
        />
        <Button type="submit" disabled={submitting || !supplierId}>
          {submitting ? "جارٍ الحفظ..." : "إنشاء الالتزام"}
        </Button>
      </form>
    </Card>
  );
}

type PendingAction = "submit" | "approve" | "cancel" | null;

const confirmCopy: Record<Exclude<PendingAction, null>, { title: string; message: string; confirmLabel: string; destructive?: boolean }> = {
  submit: {
    title: "إرسال الالتزام للاعتماد",
    message: "بعد الإرسال لن يمكن إضافة أو حذف بنود هذا الالتزام إلا بعد اعتماده. هل تريد المتابعة؟",
    confirmLabel: "إرسال",
  },
  approve: {
    title: "اعتماد الالتزام",
    message: "بعد الاعتماد يصبح هذا الالتزام نشطاً وملزِماً تجاه المورد. هل تريد المتابعة؟",
    confirmLabel: "اعتماد",
  },
  cancel: {
    title: "إلغاء الالتزام",
    message: "سيتم إلغاء هذا الالتزام. لا يمكن التراجع عن هذا الإجراء. هل تريد المتابعة؟",
    confirmLabel: "إلغاء الالتزام",
    destructive: true,
  },
};

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
  const [commitment, setCommitment] = useState<CommitmentWithLines | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAddLine, setShowAddLine] = useState(false);
  const [showAmend, setShowAmend] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [actingBusy, setActingBusy] = useState(false);

  function load() {
    setError(null);
    setCommitment(null);
    getCommitment(projectId, commitmentId)
      .then(setCommitment)
      .catch((err) => setError(err instanceof Error ? err.message : "تعذّر تحميل تفاصيل الالتزام"));
  }
  useEffect(load, [projectId, commitmentId]);

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
      setError(err instanceof ApiError ? err.message : "تعذّر تنفيذ الإجراء");
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
      setError(err instanceof ApiError ? err.message : "تعذّر حذف البند");
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
    { key: "description", header: "الوصف", render: (l) => l.description },
    { key: "quantity", header: "الكمية", align: "end", render: (l) => (l.quantity !== null ? formatQuantity(l.quantity) : "—") },
    { key: "rate", header: "السعر", align: "end", render: (l) => (l.rate !== null ? formatMoney(l.rate, commitment.currency) : "—") },
    { key: "amount", header: "المبلغ", align: "end", render: (l) => formatMoney(l.amount, commitment.currency) },
    { key: "costCode", header: "بند التكلفة", render: (l) => costCodeLabel(l.costCodeId) },
    { key: "boqItem", header: "بند جدول الكميات", render: (l) => boqItemLabel(l.boqItemId) },
  ];

  return (
    <Card className="p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold text-stone-800">التزام #{commitment.commitmentNumber}</h2>
          <Badge tone={statusTone[commitment.status]}>{statusLabel[commitment.status]}</Badge>
          <span className="text-sm text-stone-500">{typeLabel[commitment.type]}</span>
        </div>
        <Can permission="commitment.manage">
          <div className="flex flex-wrap gap-2">
            {isDraft && (
              <Button size="sm" variant="secondary" onClick={() => setShowAddLine((v) => !v)}>
                {showAddLine ? "إلغاء" : "+ بند"}
              </Button>
            )}
            {isDraft && (
              <Button size="sm" onClick={() => setPendingAction("submit")}>
                إرسال للاعتماد
              </Button>
            )}
            {isPendingApproval && (
              <Button size="sm" onClick={() => setPendingAction("approve")}>
                اعتماد
              </Button>
            )}
            {(isDraft || isPendingApproval) && (
              <Button size="sm" variant="danger" onClick={() => setPendingAction("cancel")}>
                إلغاء الالتزام
              </Button>
            )}
            {canAmend && (
              <Button size="sm" variant="secondary" onClick={() => setShowAmend((v) => !v)}>
                {showAmend ? "إلغاء" : "+ تعديل (أمر تغيير)"}
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
            شهادات الدفع للمقاول الباطن
          </Link>
        )}
      </div>

      {error && (
        <div className="mb-4">
          <ErrorState message={error} />
        </div>
      )}

      <dl className="mb-5 grid grid-cols-1 gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
        <Field label="المورد" value={supplierName} />
        <Field label="العقد" value={contractLabel} />
        <Field label="الوصف" value={commitment.description ?? "—"} />
        <Field label="العملة" value={commitment.currency} />
        <Field label="القيمة الأصلية" value={commitment.originalAmount !== null ? formatMoney(commitment.originalAmount, commitment.currency) : "—"} />
        <Field label="القيمة المعدَّلة" value={commitment.revisedAmount !== null ? formatMoney(commitment.revisedAmount, commitment.currency) : "—"} />
        <Field label="تاريخ الإرسال للاعتماد" value={formatDateTime(commitment.submittedAt)} />
        <Field label="تاريخ الاعتماد" value={formatDateTime(commitment.approvedAt)} />
        {commitment.cancelledAt && <Field label="تاريخ الإلغاء" value={formatDateTime(commitment.cancelledAt)} />}
      </dl>

      {showAddLine && isDraft && (
        <div className="mb-4">
          <Can permission="commitment.manage">
            <CommitmentLineForm
              costCodes={costCodes}
              boqItems={boqItems}
              submitLabel="إضافة البند"
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
        emptyMessage="لا توجد بنود في هذا الالتزام بعد"
        rowActions={
          isDraft
            ? (line) => (
                <Can permission="commitment.manage">
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
  return (
    <>
      <input
        required
        placeholder="الوصف"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        className="rounded-md border border-stone-300 px-3 py-2 text-sm sm:col-span-2"
      />
      <input
        type="number"
        min="0"
        step="0.001"
        placeholder="الكمية"
        value={quantity}
        onChange={(e) => setQuantity(e.target.value)}
        className="rounded-md border border-stone-300 px-3 py-2 text-sm"
      />
      <input
        type="number"
        min="0"
        step="0.01"
        placeholder="السعر"
        value={rate}
        onChange={(e) => setRate(e.target.value)}
        className="rounded-md border border-stone-300 px-3 py-2 text-sm"
      />
      <select
        value={costCodeId}
        onChange={(e) => setCostCodeId(e.target.value)}
        className="rounded-md border border-stone-300 px-3 py-2 text-sm"
      >
        <option value="">بدون بند تكلفة</option>
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
        <option value="">بدون بند جدول كميات</option>
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
      setError(err instanceof ApiError ? err.message : "تعذّر حفظ البند");
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
        {submitting ? "جارٍ الحفظ..." : submitLabel}
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
      setError(err instanceof ApiError ? err.message : "تعذّر حفظ التعديل");
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
        إضافة تعديل
      </Button>

      <ConfirmDialog
        open={confirming}
        title="إضافة تعديل على الالتزام"
        message="سيتم إضافة هذا البند وإعادة احتساب القيمة المعدَّلة لهذا الالتزام من إجمالي البنود الفعلي على الخادم. هل تريد المتابعة؟"
        confirmLabel={submitting ? "جارٍ الحفظ..." : "تأكيد التعديل"}
        onConfirm={onConfirmAmend}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
