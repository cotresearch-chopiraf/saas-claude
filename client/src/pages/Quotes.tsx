import { FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Layout } from "../components/Layout";
import { LanguageSelect } from "../components/LanguageSelect";
import { apiFetch, ApiError, getToken } from "../api/client";
import { listQuotes } from "../api/quotes";
import { formatMoney } from "../lib/format";
import type { DocumentLanguage, Quote } from "../api/types";
import { Skeleton } from "../ui/Skeleton";
import { ErrorState } from "../ui/ErrorState";

const PAGE_SIZE = 20;

const money = (n: number) => formatMoney(n);

async function downloadQuotePdf(id: string, quoteNumber: string | null) {
  const res = await fetch(`/api/quotes/${id}/pdf`, { headers: { Authorization: `Bearer ${getToken()}` } });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${quoteNumber ?? "quote"}.pdf`;
  link.click();
  URL.revokeObjectURL(url);
}

const statusLabel: Record<Quote["status"], string> = {
  draft: "مسودة",
  sent: "أُرسل",
  accepted: "مقبول",
  rejected: "مرفوض",
};

const statusColor: Record<Quote["status"], string> = {
  draft: "bg-stone-200 text-stone-600",
  sent: "bg-amber-100 text-amber-700",
  accepted: "bg-emerald-100 text-emerald-700",
  rejected: "bg-red-100 text-red-700",
};

interface DraftItem {
  description: string;
  amount: string;
}

export function Quotes() {
  const [quotes, setQuotes] = useState<Quote[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const navigate = useNavigate();

  function load() {
    setQuotes(null);
    setError(null);
    listQuotes({ limit: PAGE_SIZE, offset: 0 })
      .then((page) => {
        setQuotes(page.quotes);
        setHasMore(page.hasMore);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "تعذّر تحميل عروض الأسعار"));
  }
  useEffect(load, []);

  async function loadMore() {
    setLoadingMore(true);
    try {
      const page = await listQuotes({ limit: PAGE_SIZE, offset: quotes?.length ?? 0 });
      setQuotes((prev) => [...(prev ?? []), ...page.quotes]);
      setHasMore(page.hasMore);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر تحميل المزيد من عروض الأسعار");
    } finally {
      setLoadingMore(false);
    }
  }

  async function sendQuote(quote: Quote) {
    await apiFetch(`/quotes/${quote.id}/send`, { method: "PATCH" });
    load();
  }

  function copyLink(quote: Quote) {
    const url = `${window.location.origin}/q/${quote.publicToken}`;
    navigator.clipboard.writeText(url);
  }

  async function convertToInvoice(quote: Quote) {
    const full = await apiFetch<Quote & { items: { description: string; amount: string }[] }>(`/quotes/${quote.id}`);
    try {
      await apiFetch("/invoices", {
        method: "POST",
        body: JSON.stringify({
          quoteId: quote.id,
          clientName: quote.clientName,
          language: quote.language,
          items: full.items.map((i) => ({ description: i.description, amount: i.amount })),
        }),
      });
      navigate("/invoices");
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "تعذّر إنشاء الفاتورة");
    }
  }

  return (
    <Layout>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-stone-800">عروض الأسعار</h1>
        <button onClick={() => setShowForm((v) => !v)} className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white">
          {showForm ? "إلغاء" : "+ عرض سعر جديد"}
        </button>
      </div>

      {showForm && (
        <NewQuoteForm
          onCreated={() => {
            setShowForm(false);
            load();
          }}
        />
      )}

      {error && <ErrorState message={error} onRetry={load} />}
      {!error && quotes === null && <Skeleton rows={3} />}
      {!error && quotes !== null && (
      <ul className="space-y-2">
        {quotes.map((quote) => (
          <li key={quote.id} className="rounded-lg border border-stone-200 bg-white p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-mono text-xs text-stone-400">{quote.quoteNumber}</p>
                <p className="font-semibold text-stone-800">{quote.projectName}</p>
                <p className="text-sm text-stone-500">
                  العميل: {quote.clientName} · {money(quote.subtotal)}
                </p>
                {quote.acceptedByName && (
                  <p className="text-sm text-emerald-600">قبِله {quote.acceptedByName} بتاريخ {quote.acceptedAt?.slice(0, 10)}</p>
                )}
              </div>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${statusColor[quote.status]}`}>
                {statusLabel[quote.status]}
              </span>
            </div>
            <div className="mt-3 flex gap-2">
              {quote.status === "draft" && (
                <button onClick={() => sendQuote(quote)} className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-white">
                  إرسال للعميل
                </button>
              )}
              {quote.status !== "draft" && (
                <>
                  <button
                    onClick={() => copyLink(quote)}
                    className="rounded-md border border-stone-300 px-3 py-1 text-xs text-stone-600"
                  >
                    نسخ رابط العميل
                  </button>
                  <button
                    onClick={() => downloadQuotePdf(quote.id, quote.quoteNumber)}
                    className="rounded-md border border-stone-300 px-3 py-1 text-xs text-stone-600"
                  >
                    تنزيل PDF
                  </button>
                </>
              )}
              {quote.status === "accepted" && (
                <button
                  onClick={() => convertToInvoice(quote)}
                  className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-white"
                >
                  تحويل إلى فاتورة
                </button>
              )}
            </div>
          </li>
        ))}
        {quotes.length === 0 && (
          <li className="rounded-lg border border-dashed border-stone-300 p-8 text-center text-stone-500">
            لا توجد عروض أسعار بعد
          </li>
        )}
      </ul>
      )}
      {!error && quotes !== null && hasMore && (
        <div className="pt-4 text-center">
          <button
            disabled={loadingMore}
            onClick={loadMore}
            className="rounded-md border border-stone-300 px-4 py-2 text-sm text-stone-600 disabled:opacity-50"
          >
            {loadingMore ? "جارٍ التحميل..." : "تحميل المزيد"}
          </button>
        </div>
      )}
    </Layout>
  );
}

function NewQuoteForm({ onCreated }: { onCreated: () => void }) {
  const [clientName, setClientName] = useState("");
  const [projectName, setProjectName] = useState("");
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
      await apiFetch("/quotes", {
        method: "POST",
        body: JSON.stringify({
          clientName,
          projectName,
          language,
          items: items
            .filter((item) => item.description && item.amount)
            .map((item) => ({ description: item.description, amount: item.amount })),
        }),
      });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر إنشاء عرض السعر");
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
          required
          placeholder="اسم المشروع"
          value={projectName}
          onChange={(e) => setProjectName(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
      </div>

      <LanguageSelect value={language} onChange={setLanguage} />

      <div className="space-y-2">
        {items.map((item, i) => (
          <div key={i} className="flex gap-2">
            <input
              placeholder="بند (مثال: تركيب بلاط)"
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

      <button className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white">حفظ كمسودة</button>
    </form>
  );
}
