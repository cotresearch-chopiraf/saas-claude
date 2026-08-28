import { FormEvent, useEffect, useState } from "react";
import { Layout } from "../components/Layout";
import { LanguageSelect } from "../components/LanguageSelect";
import { apiFetch, ApiError, getToken } from "../api/client";
import type { DocumentLanguage, Invoice } from "../api/types";

const statusLabel: Record<Invoice["status"], string> = { draft: "مسودة", sent: "أُرسلت", paid: "مُسدَّدة" };
const statusColor: Record<Invoice["status"], string> = {
  draft: "bg-stone-200 text-stone-600",
  sent: "bg-amber-100 text-amber-700",
  paid: "bg-emerald-100 text-emerald-700",
};
const money = (n: number) => n.toLocaleString("ar", { maximumFractionDigits: 2 }) + " $";

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

export function Invoices() {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [disabled, setDisabled] = useState(false);

  function load() {
    apiFetch<Invoice[]>("/invoices")
      .then(setInvoices)
      .catch((err) => {
        if (err instanceof ApiError) setDisabled(true);
      });
  }
  useEffect(load, []);

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
        <h1 className="mb-4 text-2xl font-bold text-stone-800">الفواتير</h1>
        <p className="rounded-lg border border-dashed border-stone-300 p-8 text-center text-stone-500">
          ميزة الفوترة معطّلة حالياً لشركتك — فعّليها من صفحة الإعدادات لبدء إصدار الفواتير.
        </p>
      </Layout>
    );
  }

  const paidInvoices = invoices.filter((inv) => inv.status === "paid");
  const paidTaxTotal = paidInvoices.reduce((sum, inv) => sum + inv.taxAmount, 0);
  const paidRevenueTotal = paidInvoices.reduce((sum, inv) => sum + inv.total, 0);

  return (
    <Layout>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-stone-800">الفواتير</h1>
        <button onClick={() => setShowForm((v) => !v)} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white">
          {showForm ? "إلغاء" : "+ فاتورة جديدة"}
        </button>
      </div>

      {paidInvoices.length > 0 && (
        <div className="mb-6 grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg border border-stone-200 bg-white p-4">
            <p className="text-xs text-stone-500">إجمالي المُحصَّل (فواتير مُسدَّدة)</p>
            <p className="mt-1 text-lg font-bold text-stone-800">{money(paidRevenueTotal)}</p>
          </div>
          <div className="rounded-lg border border-stone-200 bg-white p-4">
            <p className="text-xs text-stone-500">إجمالي الضريبة من الفواتير المُسدَّدة</p>
            <p className="mt-1 text-lg font-bold text-primary">{money(paidTaxTotal)}</p>
          </div>
        </div>
      )}

      {showForm && (
        <NewInvoiceForm
          onCreated={() => {
            setShowForm(false);
            load();
          }}
        />
      )}

      <ul className="space-y-2">
        {invoices.map((inv) => (
          <li key={inv.id} className="rounded-lg border border-stone-200 bg-white p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-mono text-sm text-stone-500">{inv.invoiceNumber}</p>
                <p className="font-semibold text-stone-800">{inv.clientName}</p>
                <p className="text-xs text-stone-400">{inv.issueDate}</p>
              </div>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${statusColor[inv.status]}`}>
                {statusLabel[inv.status]}
              </span>
            </div>
            <div className="mt-2 flex gap-4 text-xs text-stone-500">
              <span>المجموع الفرعي: {money(inv.subtotal)}</span>
              <span>الضريبة ({inv.taxRatePercent}%): {money(inv.taxAmount)}</span>
              <span className="font-medium text-stone-700">الإجمالي: {money(inv.total)}</span>
            </div>
            <div className="mt-3 flex gap-2">
              {inv.status === "draft" && (
                <button onClick={() => sendInvoice(inv)} className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-white">
                  إرسال للعميل
                </button>
              )}
              {inv.status === "sent" && (
                <button onClick={() => markPaid(inv)} className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white">
                  تسجيل كمُسدَّدة
                </button>
              )}
              <button
                onClick={() => downloadInvoicePdf(inv.id, inv.invoiceNumber)}
                className="rounded-md border border-stone-300 px-3 py-1 text-xs text-stone-600"
              >
                تنزيل PDF
              </button>
            </div>
          </li>
        ))}
        {invoices.length === 0 && (
          <li className="rounded-lg border border-dashed border-stone-300 p-8 text-center text-stone-500">لا توجد فواتير بعد</li>
        )}
      </ul>
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
    <form onSubmit={onSubmit} className="mb-6 space-y-3 rounded-lg border border-stone-200 bg-white p-5">
      {error && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
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
              placeholder="المبلغ ($)"
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
      <button className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white">حفظ كمسودة</button>
    </form>
  );
}
