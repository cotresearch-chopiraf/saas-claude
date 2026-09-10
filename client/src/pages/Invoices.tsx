import { FormEvent, useEffect, useState } from "react";
import { Layout } from "../components/Layout";
import { LanguageSelect } from "../components/LanguageSelect";
import { apiFetch, ApiError, getToken } from "../api/client";
import { listInvoices } from "../api/invoices";
import { formatMoney } from "../lib/format";
import type { DocumentLanguage, Invoice } from "../api/types";
import { PageHeader } from "../ui/PageHeader";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { MetricCard } from "../ui/MetricCard";
import { FinancialTable, type FinancialColumn } from "../ui/FinancialTable";
import { ErrorState } from "../ui/ErrorState";
import { EmptyState } from "../ui/EmptyState";

// Slice AA Scope G — GET /api/invoices is now paginated server-side (a
// server-enforced max page size, closing the previous unbounded-query
// finding). This page's own paid-revenue/paid-tax summary cards are
// computed over the FULL invoice list (a real, pre-existing figure this
// slice must not silently make partial), so load() walks every page here
// rather than switching to a manual "load more" — each individual request
// is still bounded, this only changes one large query into several capped
// ones.
const PAGE_SIZE = 100;

const statusLabel: Record<Invoice["status"], string> = { draft: "مسودة", sent: "أُرسلت", paid: "مُسدَّدة" };
// Same neutral/warning/success vocabulary used everywhere else (Badge's
// own tone system), replacing this page's previous hand-mapped colors.
const statusTone: Record<Invoice["status"], "neutral" | "warning" | "success"> = {
  draft: "neutral",
  sent: "warning",
  paid: "success",
};
const money = (n: number) => formatMoney(n);

interface DraftItem {
  description: string;
  amount: string;
}

async function downloadInvoicePdf(id: string, invoiceNumber: string) {
  const res = await fetch(`/api/invoices/${id}/pdf`, { headers: { Authorization: `Bearer ${getToken()}` } });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${invoiceNumber}.pdf`;
  link.click();
  URL.revokeObjectURL(url);
}

// Phase F.2: rebuilt on the shared PageHeader/FinancialTable/Badge/
// MetricCard vocabulary (this page previously predated/bypassed the shared
// UI kit entirely, like Quotes.tsx). No behavior change — same endpoints,
// same pagination walk, same feature-flag-off handling, same per-status
// actions.
export function Invoices() {
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [disabled, setDisabled] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setInvoices(null);
    setError(null);
    setDisabled(false);
    try {
      const all: Invoice[] = [];
      let offset = 0;
      let hasMore = true;
      while (hasMore) {
        const page = await listInvoices({ limit: PAGE_SIZE, offset });
        all.push(...page.invoices);
        hasMore = page.hasMore;
        offset += page.invoices.length;
      }
      setInvoices(all);
    } catch (err) {
      // 403 from this specific route means exactly one thing — invoicing
      // is off in company settings (see server's invoicesRouter feature
      // -flag middleware, the only source of a 403 here). Any other
      // failure (network, 401, 500) is a real error, not that.
      if (err instanceof ApiError && err.status === 403) {
        setDisabled(true);
      } else {
        setError(err instanceof ApiError ? err.message : "تعذّر تحميل الفواتير");
      }
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function sendInvoice(invoice: Invoice) {
    await apiFetch(`/invoices/${invoice.id}/send`, { method: "PATCH" });
    load();
  }

  async function markPaid(invoice: Invoice) {
    await apiFetch(`/invoices/${invoice.id}/mark-paid`, { method: "PATCH" });
    load();
  }

  if (disabled) {
    return (
      <Layout>
        <PageHeader title="الفواتير" />
        <EmptyState message="ميزة الفوترة معطّلة حالياً لشركتك — فعّليها من صفحة الإعدادات لبدء إصدار الفواتير." />
      </Layout>
    );
  }

  const paidInvoices = (invoices ?? []).filter((inv) => inv.status === "paid");
  const paidTaxTotal = paidInvoices.reduce((sum, inv) => sum + inv.taxAmount, 0);
  const paidRevenueTotal = paidInvoices.reduce((sum, inv) => sum + inv.total, 0);

  const columns: FinancialColumn<Invoice>[] = [
    { key: "invoiceNumber", header: "رقم الفاتورة", render: (inv) => <span className="font-mono text-xs text-stone-500">{inv.invoiceNumber}</span> },
    { key: "clientName", header: "العميل", render: (inv) => inv.clientName },
    { key: "issueDate", header: "تاريخ الإصدار", render: (inv) => inv.issueDate },
    { key: "subtotal", header: "المجموع الفرعي", render: (inv) => money(inv.subtotal) },
    { key: "tax", header: "الضريبة", render: (inv) => `${money(inv.taxAmount)} (${inv.taxRatePercent}%)` },
    { key: "total", header: "الإجمالي", render: (inv) => <span className="font-medium text-stone-700">{money(inv.total)}</span> },
    { key: "status", header: "الحالة", render: (inv) => <Badge tone={statusTone[inv.status]}>{statusLabel[inv.status]}</Badge> },
  ];

  return (
    <Layout>
      <PageHeader
        title="الفواتير"
        actions={
          <Button size="sm" onClick={() => setShowForm((v) => !v)}>
            {showForm ? "إلغاء" : "+ فاتورة جديدة"}
          </Button>
        }
      />

      {!error && invoices !== null && paidInvoices.length > 0 && (
        <div className="mb-6 grid gap-4 sm:grid-cols-2">
          <MetricCard label="إجمالي المُحصَّل (فواتير مُسدَّدة)" value={money(paidRevenueTotal)} />
          <MetricCard label="إجمالي الضريبة من الفواتير المُسدَّدة" value={money(paidTaxTotal)} />
        </div>
      )}

      {showForm && (
        <div className="mb-6">
          <NewInvoiceForm
            onCreated={() => {
              setShowForm(false);
              load();
            }}
          />
        </div>
      )}

      <FinancialTable
        columns={columns}
        rows={invoices}
        rowKey={(inv) => inv.id}
        error={error}
        onRetry={load}
        emptyMessage="لا توجد فواتير بعد"
        rowActions={(inv) => (
          <div className="flex flex-wrap justify-end gap-2">
            {inv.status === "draft" && (
              <Button size="sm" onClick={() => sendInvoice(inv)}>
                إرسال للعميل
              </Button>
            )}
            {inv.status === "sent" && (
              <Button size="sm" onClick={() => markPaid(inv)}>
                تسجيل كمُسدَّدة
              </Button>
            )}
            <Button size="sm" variant="secondary" onClick={() => downloadInvoicePdf(inv.id, inv.invoiceNumber)}>
              تنزيل PDF
            </Button>
          </div>
        )}
      />
    </Layout>
  );
}

function NewInvoiceForm({ onCreated }: { onCreated: () => void }) {
  const [clientName, setClientName] = useState("");
  const [clientAddress, setClientAddress] = useState("");
  const [language, setLanguage] = useState<DocumentLanguage>("ar");
  const [items, setItems] = useState<DraftItem[]>([{ description: "", amount: "" }]);
  const [error, setError] = useState<string | null>(null);

  function updateItem(index: number, patch: Partial<DraftItem>) {
    setItems((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch("/invoices", {
        method: "POST",
        body: JSON.stringify({
          clientName,
          clientAddress: clientAddress || undefined,
          language,
          items: items
            .filter((item) => item.description && item.amount)
            .map((item) => ({ description: item.description, amount: item.amount })),
        }),
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر إنشاء الفاتورة");
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-lg border border-stone-200 bg-white p-5">
      {error && <ErrorState message={error} />}
      <div className="grid gap-3 sm:grid-cols-2">
        <input
          required
          placeholder="اسم العميل"
          value={clientName}
          onChange={(e) => setClientName(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <input
          placeholder="عنوان العميل (اختياري)"
          value={clientAddress}
          onChange={(e) => setClientAddress(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
      </div>

      <LanguageSelect value={language} onChange={setLanguage} />

      <div className="space-y-2">
        {items.map((item, i) => (
          <div key={i} className="flex gap-2">
            <input
              placeholder="بند (مثال: أجور تركيب)"
              value={item.description}
              onChange={(e) => updateItem(i, { description: e.target.value })}
              className="flex-1 rounded-md border border-stone-300 px-3 py-2 text-sm"
            />
            <input
              type="number"
              min="0"
              placeholder="المبلغ"
              value={item.amount}
              onChange={(e) => updateItem(i, { amount: e.target.value })}
              className="w-40 rounded-md border border-stone-300 px-3 py-2 text-sm"
            />
          </div>
        ))}
        <button
          type="button"
          onClick={() => setItems((prev) => [...prev, { description: "", amount: "" }])}
          className="text-sm text-primary underline decoration-dotted"
        >
          + إضافة بند آخر
        </button>
      </div>

      <p className="text-xs text-stone-400">الترقيم ونسبة الضريبة ومعلومات الشركة تُملأ تلقائياً من الإعدادات.</p>
      <Button type="submit">حفظ كمسودة</Button>
    </form>
  );
}
