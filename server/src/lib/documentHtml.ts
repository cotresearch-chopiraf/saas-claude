export interface DocumentLineItem {
  description: string;
  amount: number;
}

export interface DocumentData {
  docType: "عرض سعر" | "فاتورة";
  docTypeFr: "Devis" | "Facture";
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

const money = (n: number) => n.toLocaleString("ar", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// One letterhead template drives both "devis" and "facture" — same company
// branding, numbering, and layout, only the title and totals differ.
export function buildDocumentHtml(data: DocumentData): string {
  const subtotal = data.items.reduce((sum, item) => sum + item.amount, 0);
  const taxAmount = subtotal * (data.taxRatePercent / 100);
  const total = subtotal + taxAmount;

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
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<style>
  @font-face {
    font-family: "Doc Arabic";
    src: local("Noto Sans Arabic"), local("Tahoma"), local("Arial");
  }
  * { box-sizing: border-box; }
  body {
    font-family: "Doc Arabic", "Tahoma", "Noto Sans Arabic", sans-serif;
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
  .doc-title { text-align: left; }
  .doc-title h1 { font-size: 22px; margin: 0; color: #20423f; }
  .doc-title .fr { font-size: 12px; color: #b3852a; font-weight: 600; }
  .doc-meta { font-size: 12px; color: #6b675c; margin-top: 6px; direction: ltr; text-align: left; }
  .parties { display: flex; justify-content: space-between; margin-bottom: 28px; gap: 24px; }
  .party h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #b3852a; margin: 0 0 6px; }
  .party p { margin: 0; font-size: 13px; line-height: 1.6; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
  thead th {
    background: #f1ede3; text-align: right; font-size: 11px; text-transform: uppercase;
    color: #6b675c; padding: 10px 14px; letter-spacing: .03em;
  }
  thead th.amount { text-align: left; }
  .cell { padding: 10px 14px; border-bottom: 1px solid #e2dbc9; font-size: 13px; }
  .cell.amount { text-align: left; direction: ltr; font-variant-numeric: tabular-nums; }
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
        ${data.company.taxId ? `<div>الرقم الضريبي: ${escapeHtml(data.company.taxId)}</div>` : ""}
      </div>
    </div>
    ${data.company.logoDataUri ? `<img class="logo" src="${data.company.logoDataUri}" />` : ""}
  </div>

  <div class="doc-title">
    <h1>${data.docType} <span class="fr">/ ${data.docTypeFr}</span></h1>
    <div class="doc-meta">${data.number} &nbsp;·&nbsp; ${data.date}</div>
  </div>

  <div class="parties">
    <div class="party">
      <h3>إلى</h3>
      <p>${escapeHtml(data.client.name)}</p>
      ${data.client.address ? `<p>${escapeHtml(data.client.address)}</p>` : ""}
      ${data.client.taxId ? `<p>الرقم الضريبي: ${escapeHtml(data.client.taxId)}</p>` : ""}
    </div>
  </div>

  <table>
    <thead><tr><th>البيان</th><th class="amount">المبلغ</th></tr></thead>
    <tbody>${itemRows}</tbody>
  </table>

  <div class="totals">
    <div class="totals-row"><span>المجموع الفرعي</span><span class="val">${money(subtotal)}</span></div>
    <div class="totals-row"><span>الضريبة (${data.taxRatePercent}%)</span><span class="val">${money(taxAmount)}</span></div>
    <div class="totals-row total"><span>الإجمالي</span><span class="val">${money(total)}</span></div>
  </div>

  <footer>تم إنشاؤه تلقائياً عبر نظام تشغيل المقاولين</footer>
</body>
</html>`;
}
