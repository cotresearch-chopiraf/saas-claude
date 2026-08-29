import { useEffect, useState, type FormEvent } from "react";
import { PageHeader } from "../../ui/PageHeader";
import { Card } from "../../ui/Card";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { FinancialTable, type FinancialColumn } from "../../ui/FinancialTable";
import { ErrorState } from "../../ui/ErrorState";
import { Can } from "../../auth/Can";
import { formatMoney, formatPercent, formatDate } from "../../lib/format";
import { listContracts, createContract } from "../../api/contracts";
import { ApiError } from "../../api/client";
import type { Contract, ContractStatus } from "../../api/types";
import { useProjectContext } from "../context";

const statusLabel: Record<ContractStatus, string> = {
  draft: "مسودة",
  active: "نشط",
  completed: "مكتمل",
  terminated: "منتهٍ",
};
const statusTone: Record<ContractStatus, "neutral" | "success" | "info" | "danger"> = {
  draft: "neutral",
  active: "success",
  completed: "info",
  terminated: "danger",
};

export function ContractSection() {
  const { projectId } = useProjectContext();
  const [contracts, setContracts] = useState<Contract[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  function load() {
    setError(null);
    setContracts(null);
    listContracts(projectId)
      .then((rows) => {
        setContracts(rows);
        // Keep or default the selection to the main contract, if any.
        setSelectedId((current) => current ?? rows.find((c) => c.contractType === "main")?.id ?? rows[0]?.id ?? null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "تعذّر تحميل العقود"));
  }

  useEffect(load, [projectId]);

  const selected = contracts?.find((c) => c.id === selectedId) ?? null;
  const amendments = selected ? (contracts ?? []).filter((c) => c.parentContractId === selected.id) : [];

  const columns: FinancialColumn<Contract>[] = [
    { key: "contractNumber", header: "رقم العقد", render: (c) => c.contractNumber ?? "—" },
    { key: "contractType", header: "النوع", render: (c) => (c.contractType === "main" ? "رئيسي" : "تعديل") },
    { key: "clientName", header: "العميل", render: (c) => c.clientName ?? "—" },
    { key: "originalValue", header: "القيمة الأصلية", align: "end", render: (c) => formatMoney(c.originalValue, c.currency) },
    { key: "revisedValue", header: "القيمة الحالية", align: "end", render: (c) => formatMoney(c.revisedValue, c.currency) },
    { key: "status", header: "الحالة", render: (c) => <Badge tone={statusTone[c.status]}>{statusLabel[c.status]}</Badge> },
    { key: "startDate", header: "تاريخ البدء", render: (c) => formatDate(c.startDate) },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="العقد"
        actions={
          <Can permission="contract.manage">
            <Button size="sm" onClick={() => setShowCreate((v) => !v)}>
              {showCreate ? "إلغاء" : "+ عقد جديد"}
            </Button>
          </Can>
        }
      />

      {showCreate && (
        <Can permission="contract.manage">
          <ContractForm
            projectId={projectId}
            onCreated={(contract) => {
              setShowCreate(false);
              setSelectedId(contract.id);
              load();
            }}
          />
        </Can>
      )}

      <FinancialTable
        columns={columns}
        rows={contracts}
        rowKey={(c) => c.id}
        error={error}
        onRetry={load}
        emptyMessage="لا توجد عقود بعد"
        rowActions={(c) => (
          <button type="button" onClick={() => setSelectedId(c.id)} className="text-sm text-primary hover:underline">
            عرض
          </button>
        )}
      />

      {selected && <ContractDetail contract={selected} amendments={amendments} projectId={projectId} onAmended={load} />}
    </div>
  );
}

function ContractDetail({
  contract,
  amendments,
  projectId,
  onAmended,
}: {
  contract: Contract;
  amendments: Contract[];
  projectId: string;
  onAmended: (contract: Contract) => void;
}) {
  const [showAmend, setShowAmend] = useState(false);

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-semibold text-stone-800">
          تفاصيل العقد {contract.contractNumber ? `— ${contract.contractNumber}` : ""}
        </h2>
        {contract.contractType === "main" && (
          <Can permission="contract.manage">
            <Button size="sm" variant="secondary" onClick={() => setShowAmend((v) => !v)}>
              {showAmend ? "إلغاء" : "+ تعديل على العقد"}
            </Button>
          </Can>
        )}
      </div>

      <dl className="grid grid-cols-1 gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
        <Field label="القيمة الأصلية" value={formatMoney(contract.originalValue, contract.currency)} />
        <Field label="القيمة الحالية (المعدَّلة)" value={formatMoney(contract.revisedValue, contract.currency)} />
        <Field label="نسبة الدفعة المقدَّمة" value={formatPercent(contract.advancePercent === null ? null : Number(contract.advancePercent))} />
        <Field label="نسبة الاستقطاع (الضمان)" value={formatPercent(contract.retentionPercent === null ? null : Number(contract.retentionPercent))} />
        <Field label="شروط الدفع" value={contract.paymentTerms ?? "—"} />
        <Field label="العملة" value={contract.currency} />
        <Field label="تاريخ البدء" value={formatDate(contract.startDate)} />
        <Field label="تاريخ الانتهاء" value={formatDate(contract.endDate)} />
      </dl>

      {showAmend && (
        <div className="mt-5 border-t border-stone-200 pt-5">
          <ContractForm
            projectId={projectId}
            parentContractId={contract.id}
            onCreated={(created) => {
              setShowAmend(false);
              onAmended(created);
            }}
          />
        </div>
      )}

      {amendments.length > 0 && (
        <div className="mt-5 border-t border-stone-200 pt-5">
          <h3 className="mb-2 text-sm font-semibold text-stone-700">التعديلات على هذا العقد</h3>
          <ul className="space-y-1 text-sm text-stone-600">
            {amendments.map((a) => (
              <li key={a.id} className="flex items-center justify-between rounded-md border border-stone-100 px-3 py-2">
                <span>{a.contractNumber ?? a.id.slice(0, 8)}</span>
                <span>{formatMoney(a.revisedValue, a.currency)}</span>
                <Badge tone={statusTone[a.status]}>{statusLabel[a.status]}</Badge>
              </li>
            ))}
          </ul>
        </div>
      )}
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

// Shared by both "create the main contract" and "create an amendment" —
// the only difference is whether parentContractId is supplied, exactly
// matching the backend's own createSchema branching.
function ContractForm({
  projectId,
  parentContractId,
  onCreated,
}: {
  projectId: string;
  parentContractId?: string;
  onCreated: (contract: Contract) => void;
}) {
  const [contractNumber, setContractNumber] = useState("");
  const [clientName, setClientName] = useState("");
  const [originalValue, setOriginalValue] = useState("");
  const [currency, setCurrency] = useState("SAR");
  const [advancePercent, setAdvancePercent] = useState("");
  const [retentionPercent, setRetentionPercent] = useState("");
  const [paymentTerms, setPaymentTerms] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const contract = await createContract(projectId, {
        contractType: parentContractId ? "amendment" : "main",
        parentContractId,
        contractNumber: contractNumber || undefined,
        clientName: clientName || undefined,
        originalValue: Number(originalValue),
        currency,
        advancePercent: advancePercent ? Number(advancePercent) : undefined,
        retentionPercent: retentionPercent ? Number(retentionPercent) : undefined,
        paymentTerms: paymentTerms || undefined,
      });
      onCreated(contract);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر إنشاء العقد");
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
          placeholder="رقم العقد (اختياري)"
          value={contractNumber}
          onChange={(e) => setContractNumber(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <input
          placeholder="اسم العميل (اختياري)"
          value={clientName}
          onChange={(e) => setClientName(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <input
          required
          type="number"
          min="0"
          step="0.01"
          placeholder={parentContractId ? "قيمة التعديل" : "القيمة الأصلية"}
          value={originalValue}
          onChange={(e) => setOriginalValue(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <input
          placeholder="العملة"
          value={currency}
          onChange={(e) => setCurrency(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <input
          type="number"
          min="0"
          max="100"
          step="0.01"
          placeholder="نسبة الدفعة المقدَّمة % (اختياري)"
          value={advancePercent}
          onChange={(e) => setAdvancePercent(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <input
          type="number"
          min="0"
          max="100"
          step="0.01"
          placeholder="نسبة الاستقطاع % (اختياري)"
          value={retentionPercent}
          onChange={(e) => setRetentionPercent(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <input
          placeholder="شروط الدفع (اختياري)"
          value={paymentTerms}
          onChange={(e) => setPaymentTerms(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm sm:col-span-2"
        />
        <Button type="submit" disabled={submitting}>
          {submitting ? "جارٍ الحفظ..." : parentContractId ? "حفظ التعديل" : "حفظ العقد"}
        </Button>
      </form>
    </Card>
  );
}
