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
import { useTranslation } from "../../i18n/I18nProvider";

const statusTone: Record<ContractStatus, "neutral" | "success" | "info" | "danger"> = {
  draft: "neutral",
  active: "success",
  completed: "info",
  terminated: "danger",
};

export function ContractSection() {
  const { t, locale } = useTranslation();
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
      .catch((err) => setError(err instanceof Error ? err.message : t("contract.loadError")));
  }

  useEffect(load, [projectId]);

  const selected = contracts?.find((c) => c.id === selectedId) ?? null;
  const amendments = selected ? (contracts ?? []).filter((c) => c.parentContractId === selected.id) : [];

  const columns: FinancialColumn<Contract>[] = [
    { key: "contractNumber", header: t("contract.columns.number"), render: (c) => c.contractNumber ?? "—" },
    { key: "contractType", header: t("contract.columns.type"), render: (c) => t(`contract.type.${c.contractType === "main" ? "main" : "amendment"}`) },
    { key: "clientName", header: t("contract.columns.client"), render: (c) => c.clientName ?? "—" },
    { key: "originalValue", header: t("contract.columns.originalValue"), align: "end", render: (c) => formatMoney(c.originalValue, c.currency, locale) },
    { key: "revisedValue", header: t("contract.columns.revisedValue"), align: "end", render: (c) => formatMoney(c.revisedValue, c.currency, locale) },
    { key: "status", header: t("contract.columns.status"), render: (c) => <Badge tone={statusTone[c.status]}>{t(`contract.status.${c.status}`)}</Badge> },
    { key: "startDate", header: t("contract.columns.startDate"), render: (c) => formatDate(c.startDate, locale) },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("contract.title")}
        actions={
          <Can permission="contract.manage">
            <Button size="sm" onClick={() => setShowCreate((v) => !v)}>
              {showCreate ? t("common.cancel") : t("contract.newContract")}
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
        emptyMessage={t("contract.emptyMessage")}
        rowActions={(c) => (
          <button type="button" onClick={() => setSelectedId(c.id)} className="text-sm text-primary hover:underline">
            {t("contract.view")}
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
  const { t, locale } = useTranslation();
  const [showAmend, setShowAmend] = useState(false);

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-semibold text-stone-800">
          {t("contract.detailsTitle")} {contract.contractNumber ? `— ${contract.contractNumber}` : ""}
        </h2>
        {contract.contractType === "main" && (
          <Can permission="contract.manage">
            <Button size="sm" variant="secondary" onClick={() => setShowAmend((v) => !v)}>
              {showAmend ? t("common.cancel") : t("contract.amendContract")}
            </Button>
          </Can>
        )}
      </div>

      <dl className="grid grid-cols-1 gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
        <Field label={t("contract.fields.originalValue")} value={formatMoney(contract.originalValue, contract.currency, locale)} />
        <Field label={t("contract.fields.revisedValue")} value={formatMoney(contract.revisedValue, contract.currency, locale)} />
        <Field label={t("contract.fields.advancePercent")} value={formatPercent(contract.advancePercent === null ? null : Number(contract.advancePercent), 1, locale)} />
        <Field label={t("contract.fields.retentionPercent")} value={formatPercent(contract.retentionPercent === null ? null : Number(contract.retentionPercent), 1, locale)} />
        <Field label={t("contract.fields.paymentTerms")} value={contract.paymentTerms ?? "—"} />
        <Field label={t("contract.fields.currency")} value={contract.currency} />
        <Field label={t("contract.fields.startDate")} value={formatDate(contract.startDate, locale)} />
        <Field label={t("contract.fields.endDate")} value={formatDate(contract.endDate, locale)} />
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
          <h3 className="mb-2 text-sm font-semibold text-stone-700">{t("contract.amendmentsTitle")}</h3>
          <ul className="space-y-1 text-sm text-stone-600">
            {amendments.map((a) => (
              <li key={a.id} className="flex items-center justify-between rounded-md border border-stone-100 px-3 py-2">
                <span>{a.contractNumber ?? a.id.slice(0, 8)}</span>
                <span>{formatMoney(a.revisedValue, a.currency, locale)}</span>
                <Badge tone={statusTone[a.status]}>{t(`contract.status.${a.status}`)}</Badge>
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
  const { t } = useTranslation();
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
      setError(err instanceof ApiError ? err.message : t("contract.genericError"));
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
          placeholder={t("contract.form.contractNumberPlaceholder")}
          value={contractNumber}
          onChange={(e) => setContractNumber(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <input
          placeholder={t("contract.form.clientNamePlaceholder")}
          value={clientName}
          onChange={(e) => setClientName(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <input
          required
          type="number"
          min="0"
          step="0.01"
          placeholder={parentContractId ? t("contract.form.amendmentValuePlaceholder") : t("contract.form.originalValuePlaceholder")}
          value={originalValue}
          onChange={(e) => setOriginalValue(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <input
          placeholder={t("contract.form.currencyPlaceholder")}
          value={currency}
          onChange={(e) => setCurrency(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <input
          type="number"
          min="0"
          max="100"
          step="0.01"
          placeholder={t("contract.form.advancePercentPlaceholder")}
          value={advancePercent}
          onChange={(e) => setAdvancePercent(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <input
          type="number"
          min="0"
          max="100"
          step="0.01"
          placeholder={t("contract.form.retentionPercentPlaceholder")}
          value={retentionPercent}
          onChange={(e) => setRetentionPercent(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <input
          placeholder={t("contract.form.paymentTermsPlaceholder")}
          value={paymentTerms}
          onChange={(e) => setPaymentTerms(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm sm:col-span-2"
        />
        <Button type="submit" disabled={submitting}>
          {submitting ? t("contract.form.saving") : parentContractId ? t("contract.form.saveAmendment") : t("contract.form.saveContract")}
        </Button>
      </form>
    </Card>
  );
}
