import { FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Layout } from "../components/Layout";
import { LanguageSelect } from "../components/LanguageSelect";
import { apiFetch, ApiError, getToken } from "../api/client";
import { listQuotes } from "../api/quotes";
import { formatMoney } from "../lib/format";
import type { DocumentLanguage, Quote } from "../api/types";
import { PageHeader } from "../ui/PageHeader";
import { Card } from "../ui/Card";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { FinancialTable, type FinancialColumn } from "../ui/FinancialTable";
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

// Same neutral/warning/success/danger vocabulary used by every other
// status field in the app (Badge's own tone system), replacing this page's
// previous hand-mapped color classes.
const statusTone: Record<Quote["status"], "neutral" | "warning" | "success" | "danger"> = {
  draft: "neutral",
  sent: "warning",
  accepted: "success",
  rejected: "danger",
};

interface DraftItem {
  description: string;
  amount: string;
}

// Global nav page (not project-scoped) — company-wide quote list. Phase F.2:
// rebuilt on the shared PageHeader/FinancialTable/Badge vocabulary (this
// page previously predated/bypassed the shared UI kit entirely); no
// behavior change — same endpoints, same pagination, same per-status
// actions.
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
  }

  const columns: FinancialColumn<Quote>[] = [
    { key: "quoteNumber", header: "رقم العرض", render: (q) => <span className="font-mono text-xs text-stone-500">{q.quoteNumber}</span> },
    {
      key: "project",
      header: "المشروع",
      render: (q) => (
        <div>
          <p className="font-medium text-stone-800">{q.projectName}</p>
          {q.acceptedByName && (
            <p className="mt-0.5 text-xs text-success-600">
              قبِله {q.acceptedByName} بتاريخ {q.acceptedAt?.slice(0, 10)}
            </p>
          )}
        </div>
      ),
    },
    { key: "clientName", header: "العميل", render: (q) => q.clientName },
    { key: "subtotal", header: "الإجمالي", render: (q) => money(q.subtotal) },
    { key: "status", header: "الحالة", render: (q) => <Badge tone={statusTone[q.status]}>{statusLabel[q.status]}</Badge> },
  ];

  return (
    <Layout>
      <PageHeader
        title="عروض الأسعار"
        actions={
          <Button size="sm" onClick={() => setShowForm((v) => !v)}>
            {showForm ? "إلغاء" : "+ عرض سعر جديد"}
          </Button>
        }
      />

      {showForm && (
        <div className="mb-6">
          <NewQuoteForm
            onCreated={() => {
              setShowForm(false);
              load();
            }}
          />
        </div>
      )}

      <FinancialTable
        columns={columns}
        rows={quotes}
        rowKey={(q) => q.id}
        error={error}
        onRetry={load}
        emptyMessage="لا توجد عروض أسعار بعد"
        rowActions={(quote) => (
          <QuoteRowActions
            quote={quote}
            onSend={() => sendQuote(quote)}
            onCopyLink={() => copyLink(quote)}
            onDownload={() => downloadQuotePdf(quote.id, quote.quoteNumber)}
            onConvert={() => convertToInvoice(quote)}
          />
        )}
      />

      {!error && quotes !== null && hasMore && (
        <div className="pt-4 text-center">
          <Button variant="secondary" size="sm" disabled={loadingMore} onClick={loadMore}>
            {loadingMore ? "جارٍ التحميل..." : "تحميل المزيد"}
          </Button>
        </div>
      )}
    </Layout>
  );
}

// Isolates each row's own convert-to-invoice error (previously a jarring
// native alert()) so it appears next to the action that caused it, without
// disturbing every other row — same pattern SupplierRowActions already
// uses for its own per-row error state.
function QuoteRowActions({
  quote,
  onSend,
  onCopyLink,
  onDownload,
  onConvert,
}: {
  quote: Quote;
  onSend: () => Promise<void>;
  onCopyLink: () => void;
  onDownload: () => Promise<void>;
  onConvert: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<void>, fallbackMessage: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : fallbackMessage);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      {error && <span className="text-xs text-danger-600">{error}</span>}
      <div className="flex flex-wrap justify-end gap-2">
        {quote.status === "draft" && (
          <Button size="sm" disabled={busy} onClick={() => run(onSend, "تعذّر إرسال عرض السعر")}>
            إرسال للعميل
          </Button>
        )}
        {quote.status !== "draft" && (
          <>
            <Button size="sm" variant="secondary" onClick={onCopyLink}>
              نسخ رابط العميل
            </Button>
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => run(onDownload, "تعذّر تنزيل الملف")}>
              تنزيل PDF
            </Button>
          </>
        )}
        {quote.status === "accepted" && (
          <Button size="sm" disabled={busy} onClick={() => run(onConvert, "تعذّر إنشاء الفاتورة")}>
            تحويل إلى فاتورة
          </Button>
        )}
      </div>
    </div>
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
    <Card className="p-5">
      <form onSubmit={onSubmit} className="space-y-3">
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

        <Button type="submit">حفظ كمسودة</Button>
      </form>
    </Card>
  );
}
