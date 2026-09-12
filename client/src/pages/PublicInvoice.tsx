import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { apiFetch } from "../api/client";
import { formatMoney, formatDate } from "../lib/format";
import { useTranslation } from "../i18n/I18nProvider";

interface PublicInvoiceData {
  invoiceNumber: string;
  status: string;
  issueDate: string;
  dueDate: string | null;
  companyName: string;
  clientName: string;
  items: { id: string; description: string; amount: string }[];
  taxRatePercent: number;
  total: number;
}

export function PublicInvoice() {
  const { t, locale, direction } = useTranslation();
  const { token } = useParams<{ token: string }>();
  const [invoice, setInvoice] = useState<PublicInvoiceData | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!token) return;
    apiFetch<PublicInvoiceData>(`/public/invoices/${token}`)
      .then(setInvoice)
      .catch(() => setNotFound(true));
  }, [token]);

  if (notFound) {
    return (
      <div dir={direction} className="flex min-h-screen items-center justify-center bg-stone-50 px-6 text-center">
        <p className="text-stone-500">{t("publicInvoicePage.notFound")}</p>
      </div>
    );
  }
  if (!invoice) return null;

  const subtotal = invoice.items.reduce((sum, i) => sum + Number(i.amount), 0);
  const money = (n: number) => formatMoney(n, undefined, locale);

  return (
    <div dir={direction} className="min-h-screen bg-stone-50 px-6 py-12">
      <div className="mx-auto max-w-lg rounded-xl border border-stone-200 bg-white p-8 shadow-sm">
        <p className="text-sm text-stone-500">{t("publicInvoicePage.invoiceFrom", { company: invoice.companyName })}</p>
        <h1 className="mb-1 text-xl font-bold text-primary">{invoice.invoiceNumber}</h1>
        <p className="mb-6 text-sm text-stone-500">
          {t("publicInvoicePage.toAndIssueDate", { client: invoice.clientName, date: formatDate(invoice.issueDate, locale) })}
        </p>

        <ul className="mb-4 divide-y divide-stone-100 rounded-lg border border-stone-200">
          {invoice.items.map((item) => (
            <li key={item.id} className="flex justify-between p-3 text-sm">
              <span>{item.description}</span>
              <span className="font-medium">{money(Number(item.amount))}</span>
            </li>
          ))}
        </ul>

        <div className="mb-6 space-y-1 text-sm">
          <p className="flex justify-between text-stone-500">
            <span>{t("globalInvoicesPage.columns.subtotal")}</span><span>{money(subtotal)}</span>
          </p>
          <p className="flex justify-between text-stone-500">
            <span>{t("publicInvoicePage.taxWithPercent", { percent: invoice.taxRatePercent })}</span><span>{money(invoice.total - subtotal)}</span>
          </p>
          <p className="flex justify-between text-lg font-bold text-stone-800">
            <span>{t("globalInvoicesPage.columns.total")}</span><span>{money(invoice.total)}</span>
          </p>
        </div>

        <a
          href={`/api/public/invoices/${token}/pdf`}
          target="_blank"
          rel="noreferrer"
          className="block w-full rounded-md bg-primary py-2 text-center text-sm font-medium text-white"
        >
          {t("globalInvoicesPage.actions.downloadPdf")}
        </a>
      </div>
    </div>
  );
}
