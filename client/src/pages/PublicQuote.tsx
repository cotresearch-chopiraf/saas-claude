import { FormEvent, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { apiFetch, ApiError } from "../api/client";
import { formatMoney } from "../lib/format";
import type { PublicQuote as PublicQuoteData } from "../api/types";

const money = (n: number) => formatMoney(n);

export function PublicQuote() {
  const { token } = useParams<{ token: string }>();
  const [quote, setQuote] = useState<PublicQuoteData | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);

  function load() {
    if (!token) return;
    apiFetch<PublicQuoteData>(`/public/quotes/${token}`)
      .then(setQuote)
      .catch(() => setNotFound(true));
  }
  useEffect(load, [token]);

  async function decide(action: "accept" | "reject") {
    setError(null);
    try {
      if (action === "accept") {
        if (!name.trim()) return setError("الرجاء إدخال اسمك للتأكيد");
        await apiFetch(`/public/quotes/${token}/accept`, {
          method: "POST",
          body: JSON.stringify({ acceptedByName: name }),
        });
      } else {
        await apiFetch(`/public/quotes/${token}/reject`, { method: "POST" });
      }
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر إتمام الإجراء");
    }
  }

  if (notFound) {
    return (
      <div dir="rtl" className="flex min-h-screen items-center justify-center bg-stone-50 px-6 text-center">
        <p className="text-stone-500">عرض السعر غير موجود أو لم يعد متاحاً.</p>
      </div>
    );
  }
  if (!quote) return null;

  return (
    <div dir="rtl" className="min-h-screen bg-stone-50 px-6 py-12">
      <div className="mx-auto max-w-lg rounded-xl border border-stone-200 bg-white p-8 shadow-sm">
        <p className="text-sm text-stone-500">عرض سعر من {quote.companyName}</p>
        <h1 className="mb-1 text-xl font-bold text-primary">{quote.projectName}</h1>
        <p className="mb-6 text-sm text-stone-500">إلى: {quote.clientName}</p>

        <ul className="mb-4 divide-y divide-stone-100 rounded-lg border border-stone-200">
          {quote.items.map((item) => (
            <li key={item.id} className="flex justify-between p-3 text-sm">
              <span>{item.description}</span>
              <span className="font-medium">{money(Number(item.amount))}</span>
            </li>
          ))}
        </ul>
        <p className="mb-6 flex justify-between text-lg font-bold text-stone-800">
          <span>الإجمالي</span>
          <span>{money(quote.total)}</span>
        </p>

        {quote.status === "sent" && (
          <>
            {error && <div className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
            <input
              placeholder="اكتب اسمك الكامل للتأكيد"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mb-3 w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
            />
            <div className="flex gap-2">
              <button
                onClick={() => decide("accept")}
                className="flex-1 rounded-md bg-primary py-2 text-sm font-medium text-white"
              >
                قبول العرض
              </button>
              <button
                onClick={() => decide("reject")}
                className="flex-1 rounded-md border border-stone-300 py-2 text-sm text-stone-600"
              >
                رفض
              </button>
            </div>
          </>
        )}
        {quote.status === "accepted" && (
          <p className="rounded-md bg-emerald-50 px-3 py-2 text-center text-sm text-emerald-700">
            تم قبول هذا العرض. سيتواصل معك المقاول قريباً.
          </p>
        )}
        {quote.status === "rejected" && (
          <p className="rounded-md bg-stone-100 px-3 py-2 text-center text-sm text-stone-600">تم رفض هذا العرض.</p>
        )}
      </div>
    </div>
  );
}
