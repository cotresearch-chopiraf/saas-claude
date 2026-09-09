import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { apiFetch } from "../api/client";
import { formatMoney, formatDate } from "../lib/format";

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

const money = (n: number) => formatMoney(n);

export function PublicInvoice() {
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
      <div dir="rtl" className="flex min-h-screen items-center justify-center bg-stone-50 px-6 text-center">
        <p className="text-stone-500">الفاتورة غير موجودة أو لم تعد متاحة.</p>
      </div>
    );
  }
  if (!invoice) return null;

  const subtotal = invoice.items.reduce((sum, i) => sum + Number(i.amount), 0);

  return (
    <div dir="rtl" className="min-h-screen bg-stone-50 px-6 py-12">
      <div className="mx-auto max-w-lg rounded-xl border border-stone-200 bg-white p-8 shadow-sm">
        <p className="text-sm text-stone-500">فاتورة من {invoice.companyName}</p>
        <h1 className="mb-1 text-xl font-bold text-primary">{invoice.invoiceNumber}</h1>
        <p className="mb-6 text-sm text-stone-500">
          إلى: {invoice.clientName} · تاريخ الإصدار: {formatDate(invoice.issueDate)}
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
            <span>المجموع الفرعي</span><span>{money(subtotal)}</span>
          </p>
          <p className="flex justify-between text-stone-500">
            <span>الضريبة ({invoice.taxRatePercent}%)</span><span>{money(invoice.total - subtotal)}</span>
          </p>
          <p className="flex justify-between text-lg font-bold text-stone-800">
            <span>الإجمالي</span><span>{money(invoice.total)}</span>
          </p>
        </div>

        <a
          href={`/api/public/invoices/${token}/pdf`}
          target="_blank"
          rel="noreferrer"
          className="block w-full rounded-md bg-primary py-2 text-center text-sm font-medium text-white"
        >
          تنزيل PDF
        </a>
      </div>
    </div>
  );
}
