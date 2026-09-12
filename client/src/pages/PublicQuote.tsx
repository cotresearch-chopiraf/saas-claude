import { FormEvent, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { apiFetch, ApiError } from "../api/client";
import { formatMoney } from "../lib/format";
import type { PublicQuote as PublicQuoteData } from "../api/types";
import { useTranslation } from "../i18n/I18nProvider";

export function PublicQuote() {
  const { t, locale, direction } = useTranslation();
  const money = (n: number) => formatMoney(n, undefined, locale);
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
        if (!name.trim()) return setError(t("publicQuotePage.nameRequiredError"));
        await apiFetch(`/public/quotes/${token}/accept`, {
          method: "POST",
          body: JSON.stringify({ acceptedByName: name }),
        });
      } else {
        await apiFetch(`/public/quotes/${token}/reject`, { method: "POST" });
      }
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("publicQuotePage.genericError"));
    }
  }

  if (notFound) {
    return (
      <div dir={direction} className="flex min-h-screen items-center justify-center bg-stone-50 px-6 text-center">
        <p className="text-stone-500">{t("publicQuotePage.notFound")}</p>
      </div>
    );
  }
  if (!quote) return null;

  return (
    <div dir={direction} className="min-h-screen bg-stone-50 px-6 py-12">
      <div className="mx-auto max-w-lg rounded-xl border border-stone-200 bg-white p-8 shadow-sm">
        <p className="text-sm text-stone-500">{t("publicQuotePage.quoteFrom", { company: quote.companyName })}</p>
        <h1 className="mb-1 text-xl font-bold text-primary">{quote.projectName}</h1>
        <p className="mb-6 text-sm text-stone-500">{t("publicQuotePage.toClient", { client: quote.clientName })}</p>

        <ul className="mb-4 divide-y divide-stone-100 rounded-lg border border-stone-200">
          {quote.items.map((item) => (
            <li key={item.id} className="flex justify-between p-3 text-sm">
              <span>{item.description}</span>
              <span className="font-medium">{money(Number(item.amount))}</span>
            </li>
          ))}
        </ul>
        <p className="mb-6 flex justify-between text-lg font-bold text-stone-800">
          <span>{t("quotesPage.columns.subtotal")}</span>
          <span>{money(quote.total)}</span>
        </p>

        {quote.status === "sent" && (
          <>
            {error && <div className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
            <input
              placeholder={t("publicQuotePage.namePlaceholder")}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mb-3 w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
            />
            <div className="flex gap-2">
              <button
                onClick={() => decide("accept")}
                className="flex-1 rounded-md bg-primary py-2 text-sm font-medium text-white"
              >
                {t("publicQuotePage.accept")}
              </button>
              <button
                onClick={() => decide("reject")}
                className="flex-1 rounded-md border border-stone-300 py-2 text-sm text-stone-600"
              >
                {t("publicQuotePage.reject")}
              </button>
            </div>
          </>
        )}
        {quote.status === "accepted" && (
          <p className="rounded-md bg-emerald-50 px-3 py-2 text-center text-sm text-emerald-700">
            {t("publicQuotePage.acceptedNotice")}
          </p>
        )}
        {quote.status === "rejected" && (
          <p className="rounded-md bg-stone-100 px-3 py-2 text-center text-sm text-stone-600">{t("publicQuotePage.rejectedNotice")}</p>
        )}
      </div>
    </div>
  );
}
