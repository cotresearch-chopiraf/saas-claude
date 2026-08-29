import { computeTotals } from "./money.js";

export type DocumentLanguage = "ar" | "fr" | "en";
export type DocumentKind = "quote" | "invoice";

export interface DocumentLineItem {
  description: string;
  amount: number;
}

export interface DocumentData {
  kind: DocumentKind;
  language: DocumentLanguage;
  number: string;
  date: string;
  company: {
    name: string;
    logoDataUri: string | null;
    address: string | null;
    taxId: string | null;
    phone: string | null;
  };
  client: {
    name: string;
    address: string | null;
    taxId: string | null;
  };
  items: DocumentLineItem[];
  taxRatePercent: number;
}

interface Labels {
  dir: "rtl" | "ltr";
  locale: string;
  title: Record<DocumentKind, string>;
  to: string;
  taxIdLabel: string;
  description: string;
  amount: string;
  subtotal: string;
  tax: string;
  total: string;
  footer: string;
}

// One template, three fully independent label sets and directions — a
// client picks their language per document, not the company as a whole.
const LABELS: Record<DocumentLanguage, Labels> = {
  ar: {
    dir: "rtl",
    locale: "ar",
    title: { quote: "عرض سعر", invoice: "فاتورة" },
    to: "إلى",
    taxIdLabel: "الرقم الضريبي",
    description: "البيان",
    amount: "المبلغ",
    subtotal: "المجموع الفرعي",
    tax: "الضريبة",
    total: "الإجمالي",
    footer: "تم إنشاؤه تلقائياً عبر نظام تشغيل المقاولين",
  },
  fr: {
    dir: "ltr",
    locale: "fr-FR",
    title: { quote: "Devis", invoice: "Facture" },
    to: "À",
    taxIdLabel: "N° fiscal",
    description: "Désignation",
    amount: "Montant",
    subtotal: "Sous-total",
    tax: "Taxe",
    total: "Total",
    footer: "Généré automatiquement via le système de gestion des entrepreneurs",
  },
  en: {
    dir: "ltr",
    locale: "en-US",
    title: { quote: "Quote", invoice: "Invoice" },
    to: "To",
    taxIdLabel: "Tax ID",
    description: "Description",
    amount: "Amount",
    subtotal: "Subtotal",
    tax: "Tax",
    total: "Total",
    footer: "Automatically generated via the contractor operations system",
  },
};

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// One letterhead template drives every language/kind combination — same
// company branding, numbering, and layout, only the labels and direction
// change. Amounts render LTR even inside an RTL document (financial figures
// always read left-to-right regardless of surrounding language).
export function buildDocumentHtml(data: DocumentData): string {
  const t = LABELS[data.language];
  const money = (n: number) => n.toLocaleString(t.locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const { subtotal, taxAmount, total } = computeTotals(
    data.items.map((item) => item.amount),
    data.taxRatePercent,
  );

  const itemRows = data.items
    .map(
      (item) => `
        <tr>
          <td class="cell desc">${escapeHtml(item.description)}</td>
          <td class="cell amount">${money(item.amount)}</td>
        </tr>`,
    )
    .join("");

  return `<!doctype html>
<html lang="${data.language}" dir="${t.dir}">
<head>
<meta charset="UTF-8">
<style>
  @font-face {
    font-family: "Doc Sans";
    src: local("Noto Sans Arabic"), local("Tahoma"), local("Arial");
  }
  * { box-sizing: border-box; }
  body {
    font-family: "Doc Sans", "Tahoma", "Noto Sans Arabic", "Helvetica", "Arial", sans-serif;
    color: #211d17;
    margin: 0;
    padding: 48px 56px;
    font-size: 13px;
  }
  .letterhead {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    border-bottom: 3px solid #20423f;
    padding-bottom: 20px;
    margin-bottom: 28px;
  }
  .company-name { font-size: 20px; font-weight: 700; color: #20423f; margin: 0 0 6px; }
  .company-meta { font-size: 11.5px; color: #6b675c; line-height: 1.6; }
  .logo { max-height: 64px; max-width: 180px; }
  .doc-title { text-align: ${t.dir === "rtl" ? "left" : "right"}; }
  .doc-title h1 { font-size: 22px; margin: 0; color: #20423f; }
  .doc-meta { font-size: 12px; color: #6b675c; margin-top: 6px; direction: ltr; text-align: ${t.dir === "rtl" ? "left" : "right"}; }
  .parties { display: flex; justify-content: space-between; margin-bottom: 28px; gap: 24px; }
  .party h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #b3852a; margin: 0 0 6px; }
  .party p { margin: 0; font-size: 13px; line-height: 1.6; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
  thead th {
    background: #f1ede3; text-align: start; font-size: 11px; text-transform: uppercase;
    color: #6b675c; padding: 10px 14px; letter-spacing: .03em;
  }
  thead th.amount { text-align: end; }
  .cell { padding: 10px 14px; border-bottom: 1px solid #e2dbc9; font-size: 13px; }
  .cell.amount { text-align: end; direction: ltr; font-variant-numeric: tabular-nums; }
  .totals { width: 280px; margin-inline-start: auto; }
  .totals-row { display: flex; justify-content: space-between; padding: 6px 0; font-size: 13px; }
  .totals-row.total { border-top: 2px solid #20423f; margin-top: 6px; padding-top: 12px; font-weight: 700; font-size: 16px; color: #20423f; }
  .totals-row .val { direction: ltr; font-variant-numeric: tabular-nums; }
  footer { margin-top: 48px; font-size: 11px; color: #a6a095; text-align: center; }
</style>
</head>
<body>
  <div class="letterhead">
    <div>
      <p class="company-name">${escapeHtml(data.company.name)}</p>
      <div class="company-meta">
        ${data.company.address ? `<div>${escapeHtml(data.company.address)}</div>` : ""}
        ${data.company.phone ? `<div>${escapeHtml(data.company.phone)}</div>` : ""}
        ${data.company.taxId ? `<div>${t.taxIdLabel}: ${escapeHtml(data.company.taxId)}</div>` : ""}
      </div>
    </div>
    ${data.company.logoDataUri ? `<img class="logo" src="${data.company.logoDataUri}" />` : ""}
  </div>

  <div class="doc-title">
    <h1>${t.title[data.kind]}</h1>
    <div class="doc-meta">${data.number} &nbsp;·&nbsp; ${data.date}</div>
  </div>

  <div class="parties">
    <div class="party">
      <h3>${t.to}</h3>
      <p>${escapeHtml(data.client.name)}</p>
      ${data.client.address ? `<p>${escapeHtml(data.client.address)}</p>` : ""}
      ${data.client.taxId ? `<p>${t.taxIdLabel}: ${escapeHtml(data.client.taxId)}</p>` : ""}
    </div>
  </div>

  <table>
    <thead><tr><th>${t.description}</th><th class="amount">${t.amount}</th></tr></thead>
    <tbody>${itemRows}</tbody>
  </table>

  <div class="totals">
    <div class="totals-row"><span>${t.subtotal}</span><span class="val">${money(subtotal)}</span></div>
    <div class="totals-row"><span>${t.tax} (${data.taxRatePercent}%)</span><span class="val">${money(taxAmount)}</span></div>
    <div class="totals-row total"><span>${t.total}</span><span class="val">${money(total)}</span></div>
  </div>

  <footer>${t.footer}</footer>
</body>
</html>`;
}
