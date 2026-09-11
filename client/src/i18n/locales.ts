// Central locale registry. Adding a language means adding one entry here
// and one translations/<code>.ts file — nothing else in this module needs
// to change (I18nProvider and useTranslation are locale-agnostic).
export type Locale = "ar" | "fr" | "en";
export type Direction = "rtl" | "ltr";

export interface LocaleMeta {
  code: Locale;
  /** Label shown in the language switcher, written in the language itself. */
  nativeLabel: string;
  direction: Direction;
  /** Passed to Intl.NumberFormat/DateTimeFormat and formatMoney/formatDate. */
  intlTag: string;
}

export const LOCALES: LocaleMeta[] = [
  { code: "ar", nativeLabel: "العربية", direction: "rtl", intlTag: "ar" },
  { code: "fr", nativeLabel: "Français", direction: "ltr", intlTag: "fr" },
  { code: "en", nativeLabel: "English", direction: "ltr", intlTag: "en" },
];

export const DEFAULT_LOCALE: Locale = "ar";

export function isLocale(value: string | null | undefined): value is Locale {
  return value === "ar" || value === "fr" || value === "en";
}

export function localeMeta(locale: Locale): LocaleMeta {
  return LOCALES.find((l) => l.code === locale) ?? LOCALES[0];
}
