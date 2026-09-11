import { useEffect, useState, type FormEvent } from "react";
import { PageHeader } from "../../ui/PageHeader";
import { Card } from "../../ui/Card";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { FinancialTable, type FinancialColumn } from "../../ui/FinancialTable";
import { ErrorState } from "../../ui/ErrorState";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Can } from "../../auth/Can";
import { formatMoney, formatDate } from "../../lib/format";
import { listProjectInvoices, createInvoice, sendInvoice, markInvoicePaid } from "../../api/invoices";
import { listContracts } from "../../api/contracts";
import { ApiError } from "../../api/client";
import type { Contract, Invoice, InvoiceStatus } from "../../api/types";
import { useProjectContext } from "../context";
import { useTranslation } from "../../i18n/I18nProvider";

const statusTone: Record<InvoiceStatus, "warning" | "info" | "success"> = {
  draft: "warning",
  sent: "info",
  paid: "success",
};

// Invoices (UI-09) — project-scoped view over the existing, fully-tested
// invoice domain (server/src/routes/invoices.ts). The list comes verbatim
// from GET /projects/:projectId/invoices (server-side company+project
// filtering — this screen never fetches the company-wide list and never
// filters by projectId in JavaScript). subtotal/taxAmount/total are
// returned pre-computed by the backend's own computeTotals(); this screen
// never recomputes them. There is no currency column on invoices, so
// formatMoney's own "SAR" default is used, and there is no
// paid/outstanding-amount field anywhere in this domain — status is a
// strict draft/sent/paid enum, nothing more granular.
export function InvoicesSection() {
  const { t, locale } = useTranslation();
  const { projectId } = useProjectContext();
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [pendingAction, setPendingAction] = useState<{ type: "send" | "markPaid"; invoice: Invoice } | null>(null);
  const [actingBusy, setActingBusy] = useState(false);

  function load() {
    setError(null);
    setInvoices(null);
    Promise.all([listProjectInvoices(projectId), listContracts(projectId)])
      .then(([invoiceRows, contractRows]) => {
        setInvoices(invoiceRows);
        setContracts(contractRows);
      })
      .catch((err) => setError(err instanceof Error ? err.message : t("invoicesPage.loadError")));
  }
  useEffect(load, [projectId]);

  async function onConfirmAction() {
    // actingBusy guards against a second click firing a duplicate mutation
    // while the first request is still in flight — the dialog's own button
    // doesn't disable itself on label change alone.
    if (!pendingAction || actingBusy) return;
    setActingBusy(true);
    try {
      if (pendingAction.type === "send") await sendInvoice(pendingAction.invoice.id);
      else await markInvoicePaid(pendingAction.invoice.id);
      setPendingAction(null);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("invoicesPage.actionError"));
      setPendingAction(null);
    } finally {
      setActingBusy(false);
    }
  }

  const contractLabel = (id: string | null) => {
    if (!id) return "—";
    const c = contracts.find((x) => x.id === id);
    return c ? (c.contractNumber ?? c.id.slice(0, 8)) : "—";
  };

  const columns: FinancialColumn<Invoice>[] = [
    { key: "invoiceNumber", header: t("invoicesPage.columns.number"), render: (i) => i.invoiceNumber },
    { key: "contract", header: t("invoicesPage.columns.contract"), render: (i) => contractLabel(i.contractId) },
    { key: "status", header: t("invoicesPage.columns.status"), render: (i) => <Badge tone={statusTone[i.status]}>{t(`invoicesPage.status.${i.status}`)}</Badge> },
    { key: "issueDate", header: t("invoicesPage.columns.issueDate"), render: (i) => formatDate(i.issueDate, locale) },
    { key: "dueDate", header: t("invoicesPage.columns.dueDate"), render: (i) => formatDate(i.dueDate, locale) },
    { key: "subtotal", header: t("invoicesPage.columns.subtotal"), align: "end", render: (i) => formatMoney(i.subtotal, "SAR", locale) },
    { key: "taxAmount", header: t("invoicesPage.columns.taxAmount"), align: "end", render: (i) => formatMoney(i.taxAmount, "SAR", locale) },
    { key: "total", header: t("invoicesPage.columns.total"), align: "end", render: (i) => formatMoney(i.total, "SAR", locale) },
  ];

  const confirmCopy =
    pendingAction?.type === "send"
      ? { title: t("invoicesPage.confirm.sendTitle"), message: t("invoicesPage.confirm.sendMessage"), confirmLabel: t("invoicesPage.confirm.sendLabel") }
      : pendingAction?.type === "markPaid"
        ? { title: t("invoicesPage.confirm.markPaidTitle"), message: t("invoicesPage.confirm.markPaidMessage"), confirmLabel: t("invoicesPage.confirm.markPaidLabel"), destructive: true }
        : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("invoicesPage.title")}
        subtitle={t("invoicesPage.subtitle")}
        actions={
          // Creation carries no requirePermission gate on the backend (see
          // routes/invoices.ts — only an explicit manual taxRatePercent
          // requires owner, which this form never sends), so unlike
          // send/markPaid below, this control is open to any member, not
          // wrapped in <Can>.
          <Button size="sm" onClick={() => setShowCreate((v) => !v)}>
            {showCreate ? t("common.cancel") : t("invoicesPage.newInvoice")}
          </Button>
        }
      />

      {/* Only shown once data has already loaded (e.g. a mutation failed) —
          a load failure is handled by FinancialTable's own error state
          below, so this must never render alongside it. */}
      {error && invoices !== null && (
        <div>
          <ErrorState message={error} onRetry={load} />
        </div>
      )}

      {showCreate && (
        <InvoiceCreateForm
          projectId={projectId}
          contracts={contracts}
          onCreated={() => {
            setShowCreate(false);
            load();
          }}
        />
      )}

      <FinancialTable
        columns={columns}
        rows={invoices}
        rowKey={(i) => i.id}
        error={invoices === null ? error : null}
        onRetry={load}
        emptyMessage={t("invoicesPage.emptyMessage")}
        rowActions={(i) => (
          <div className="flex justify-end gap-2">
            {i.status === "draft" && (
              <Can permission="invoice.send">
                <button
                  type="button"
                  onClick={() => setPendingAction({ type: "send", invoice: i })}
                  className="text-sm text-primary hover:underline"
                >
                  {t("invoicesPage.send")}
                </button>
              </Can>
            )}
            {i.status === "sent" && (
              <Can permission="invoice.markPaid">
                <button
                  type="button"
                  onClick={() => setPendingAction({ type: "markPaid", invoice: i })}
                  className="text-sm text-primary hover:underline"
                >
                  {t("invoicesPage.markPaid")}
                </button>
              </Can>
            )}
          </div>
        )}
      />

      <ConfirmDialog
        open={pendingAction !== null}
        title={confirmCopy?.title ?? ""}
        message={confirmCopy?.message ?? ""}
        confirmLabel={actingBusy ? t("invoicesPage.confirm.executing") : (confirmCopy?.confirmLabel ?? "")}
        destructive={confirmCopy?.destructive}
        onConfirm={onConfirmAction}
        onCancel={() => setPendingAction(null)}
      />
    </div>
  );
}

function InvoiceCreateForm({
  projectId,
  contracts,
  onCreated,
}: {
  projectId: string;
  contracts: Contract[];
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const [contractId, setContractId] = useState("");
  const [clientName, setClientName] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [itemDescription, setItemDescription] = useState("");
  const [itemAmount, setItemAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      // The current project is always pre-filled and never editable here —
      // this form can only ever create an invoice for THIS project. If a
      // contract is chosen, its own project (validated server-side) is
      // what actually gets stored; no conflicting projectId is ever sent
      // alongside a contractId.
      await createInvoice({
        projectId: contractId ? undefined : projectId,
        contractId: contractId || undefined,
        clientName,
        dueDate: dueDate || undefined,
        items: [{ description: itemDescription, amount: Number(itemAmount) }],
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("invoicesPage.createForm.genericError"));
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
          value={contractId}
          onChange={(e) => setContractId(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        >
          <option value="">{t("invoicesPage.createForm.noContract")}</option>
          {contracts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.contractNumber ?? c.id.slice(0, 8)}
            </option>
          ))}
        </select>
        <input
          required
          placeholder={t("invoicesPage.createForm.clientNamePlaceholder")}
          value={clientName}
          onChange={(e) => setClientName(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <label className="text-sm text-stone-600">
          {t("invoicesPage.createForm.dueDateLabel")}
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
          />
        </label>
        <input
          required
          placeholder={t("invoicesPage.createForm.itemDescriptionPlaceholder")}
          value={itemDescription}
          onChange={(e) => setItemDescription(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <input
          required
          type="number"
          min="0"
          step="0.01"
          placeholder={t("invoicesPage.createForm.amountPlaceholder")}
          value={itemAmount}
          onChange={(e) => setItemAmount(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <Button type="submit" disabled={submitting} className="sm:col-span-4">
          {submitting ? t("invoicesPage.createForm.saving") : t("invoicesPage.createForm.create")}
        </Button>
      </form>
    </Card>
  );
}
