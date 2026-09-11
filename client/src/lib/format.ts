// Presentation-only formatters. NONE of these compute a financial value —
// they only format numbers/dates the backend already returned. Any actual
// calculation (totals, variance, remaining, ETC/EAC, cash position, etc.)
// must come from the backend response, never be derived here. See
// docs/MIDAD_FORECAST_MODEL.md / docs/MIDAD_CASHFLOW_MODEL.md for why: this
// codebase treats a second, independent calculation of a financial number
// as a second source of truth, which is never allowed.
//
// Every formatter takes an optional trailing `locale` (an Intl locale tag,
// e.g. i18n's Locale["intlTag"]) defaulting to "ar" so every existing call
// site elsewhere in the app keeps rendering exactly what it always has —
// only components migrated to the i18n system pass their current locale.
// Locale only changes presentation (digit script, separators, month names,
// unit words) — it never changes the underlying numeric value.

const DEFAULT_LOCALE = "ar";

const moneyFormatterCache = new Map<string, Intl.NumberFormat>();

function moneyFormatter(currency: string, locale: string): Intl.NumberFormat {
  const cacheKey = `${locale}:${currency}`;
  const cached = moneyFormatterCache.get(cacheKey);
  if (cached) return cached;
  const formatter = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    currencyDisplay: "symbol",
    maximumFractionDigits: 2,
  });
  moneyFormatterCache.set(cacheKey, formatter);
  return formatter;
}

// currency defaults to SAR only as a display fallback when a caller
// genuinely has no currency context yet — never invented as a conversion
// target. Every real amount in this app already carries (or can carry) its
// own currency from the backend response it came from.
export function formatMoney(amount: number | string, currency = "SAR", locale: string = DEFAULT_LOCALE): string {
  const n = typeof amount === "string" ? Number(amount) : amount;
  if (!Number.isFinite(n)) return "—";
  try {
    return moneyFormatter(currency, locale).format(n);
  } catch {
    // An unrecognized currency code would otherwise throw at format time —
    // fall back to a plain number with the raw code rather than crashing
    // the page over a display detail.
    return `${n.toLocaleString(locale, { maximumFractionDigits: 2 })} ${currency}`;
  }
}

export function formatQuantity(quantity: number | string, unit?: string | null, locale: string = DEFAULT_LOCALE): string {
  const n = typeof quantity === "string" ? Number(quantity) : quantity;
  if (!Number.isFinite(n)) return "—";
  const formatted = n.toLocaleString(locale, { maximumFractionDigits: 3 });
  return unit ? `${formatted} ${unit}` : formatted;
}

export function formatPercent(value: number | null | undefined, fractionDigits = 1, locale: string = DEFAULT_LOCALE): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value.toLocaleString(locale, { maximumFractionDigits: fractionDigits })}%`;
}

export function formatNumber(value: number | string, fractionDigits = 0, locale: string = DEFAULT_LOCALE): string {
  const n = typeof value === "string" ? Number(value) : value;
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString(locale, { maximumFractionDigits: fractionDigits });
}

const FILE_SIZE_UNITS: Record<string, { byte: string; kb: string; mb: string }> = {
  ar: { byte: "بايت", kb: "ك.ب", mb: "م.ب" },
  fr: { byte: "octets", kb: "Ko", mb: "Mo" },
  en: { byte: "bytes", kb: "KB", mb: "MB" },
};

// Bytes → a human-readable size (KB/MB), for Documents (UI-10) — never a
// financial value, purely a display detail over the backend's own `size`.
export function formatFileSize(bytes: number, locale: string = DEFAULT_LOCALE): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = FILE_SIZE_UNITS[locale] ?? FILE_SIZE_UNITS[DEFAULT_LOCALE];
  if (bytes < 1024) return `${bytes} ${units.byte}`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toLocaleString(locale, { maximumFractionDigits: 1 })} ${units.kb}`;
  const mb = kb / 1024;
  return `${mb.toLocaleString(locale, { maximumFractionDigits: 2 })} ${units.mb}`;
}

export function formatDate(date: string | null | undefined, locale: string = DEFAULT_LOCALE): string {
  if (!date) return "—";
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat(locale, { year: "numeric", month: "short", day: "numeric" }).format(d);
}

export function formatDateTime(date: string | null | undefined, locale: string = DEFAULT_LOCALE): string {
  if (!date) return "—";
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}
