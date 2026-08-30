// Presentation-only formatters. NONE of these compute a financial value —
// they only format numbers/dates the backend already returned. Any actual
// calculation (totals, variance, remaining, ETC/EAC, cash position, etc.)
// must come from the backend response, never be derived here. See
// docs/MIDAD_FORECAST_MODEL.md / docs/MIDAD_CASHFLOW_MODEL.md for why: this
// codebase treats a second, independent calculation of a financial number
// as a second source of truth, which is never allowed.

const moneyFormatterCache = new Map<string, Intl.NumberFormat>();

function moneyFormatter(currency: string): Intl.NumberFormat {
  const cached = moneyFormatterCache.get(currency);
  if (cached) return cached;
  const formatter = new Intl.NumberFormat("ar", {
    style: "currency",
    currency,
    currencyDisplay: "symbol",
    maximumFractionDigits: 2,
  });
  moneyFormatterCache.set(currency, formatter);
  return formatter;
}

// currency defaults to SAR only as a display fallback when a caller
// genuinely has no currency context yet — never invented as a conversion
// target. Every real amount in this app already carries (or can carry) its
// own currency from the backend response it came from.
export function formatMoney(amount: number | string, currency = "SAR"): string {
  const n = typeof amount === "string" ? Number(amount) : amount;
  if (!Number.isFinite(n)) return "—";
  try {
    return moneyFormatter(currency).format(n);
  } catch {
    // An unrecognized currency code would otherwise throw at format time —
    // fall back to a plain number with the raw code rather than crashing
    // the page over a display detail.
    return `${n.toLocaleString("ar", { maximumFractionDigits: 2 })} ${currency}`;
  }
}

export function formatQuantity(quantity: number | string, unit?: string | null): string {
  const n = typeof quantity === "string" ? Number(quantity) : quantity;
  if (!Number.isFinite(n)) return "—";
  const formatted = n.toLocaleString("ar", { maximumFractionDigits: 3 });
  return unit ? `${formatted} ${unit}` : formatted;
}

export function formatPercent(value: number | null | undefined, fractionDigits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value.toLocaleString("ar", { maximumFractionDigits: fractionDigits })}%`;
}

export function formatNumber(value: number | string, fractionDigits = 0): string {
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("ar", { maximumFractionDigits: fractionDigits });
}

// Bytes → a human-readable size (KB/MB), for Documents (UI-10) — never a
// financial value, purely a display detail over the backend's own `size`.
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} بايت`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toLocaleString("ar", { maximumFractionDigits: 1 })} ك.ب`;
  const mb = kb / 1024;
  return `${mb.toLocaleString("ar", { maximumFractionDigits: 2 })} م.ب`;
}

export function formatDate(date: string | null | undefined): string {
  if (!date) return "—";
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("ar", { year: "numeric", month: "short", day: "numeric" }).format(d);
}

export function formatDateTime(date: string | null | undefined): string {
  if (!date) return "—";
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("ar", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}
