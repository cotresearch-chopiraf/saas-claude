import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { DEFAULT_LOCALE, isLocale, localeMeta, type Locale } from "./locales";
import { translations, type TranslationValue } from "./translations";

const STORAGE_KEY = "midad_locale";

function readStoredLocale(): Locale {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    // localStorage can throw in private-browsing/blocked-storage contexts —
    // fall back to the default locale rather than crashing the app over a
    // display preference.
  }
  return DEFAULT_LOCALE;
}

function resolveDotPath(dict: Record<string, TranslationValue>, key: string): string | undefined {
  const parts = key.split(".");
  let node: TranslationValue = dict;
  for (const part of parts) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, TranslationValue>)[part];
  }
  return typeof node === "string" ? node : undefined;
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    const value = vars[name];
    return value === undefined ? match : String(value);
  });
}

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  direction: "rtl" | "ltr";
  /**
   * Translation lookup by dot-path key (e.g. "dashboard.health.title"),
   * with optional {{var}} interpolation. Missing-key fallback order:
   * current locale -> Arabic (the app's original, always-complete
   * dictionary) -> the key itself (visibly wrong, but never blank/
   * "undefined", so a missing translation is obvious in the UI rather
   * than silently empty).
   */
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(readStoredLocale);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Same rationale as readStoredLocale: persistence is a nice-to-have,
      // never a reason to break the language switch itself.
    }
  }, []);

  const meta = localeMeta(locale);

  // Sync <html dir/lang> — every page in the app inherits direction from
  // the document root instead of a hardcoded dir="rtl" on each component.
  useEffect(() => {
    document.documentElement.dir = meta.direction;
    document.documentElement.lang = locale;
  }, [locale, meta.direction]);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      const current = resolveDotPath(translations[locale], key);
      if (current !== undefined) return interpolate(current, vars);
      const fallback = resolveDotPath(translations[DEFAULT_LOCALE], key);
      if (fallback !== undefined) return interpolate(fallback, vars);
      return key;
    },
    [locale],
  );

  const value = useMemo<I18nContextValue>(
    () => ({ locale, setLocale, direction: meta.direction, t }),
    [locale, setLocale, meta.direction, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within an I18nProvider");
  return ctx;
}

// For the rare non-component module (e.g. api/client.ts's generic HTTP
// error fallback) that needs a translated string but has no React context
// of its own — reads the same persisted locale preference useTranslation()
// does, with the same locale -> Arabic -> key fallback chain. Never use
// this from a component; use useTranslation() there instead, since this
// reads localStorage fresh on every call and won't reactively update on a
// language switch mid-render.
export function translateStatic(key: string, vars?: Record<string, string | number>): string {
  const locale = readStoredLocale();
  const current = resolveDotPath(translations[locale], key);
  if (current !== undefined) return interpolate(current, vars);
  const fallback = resolveDotPath(translations[DEFAULT_LOCALE], key);
  if (fallback !== undefined) return interpolate(fallback, vars);
  return key;
}

// Convenience alias matching the common `useTranslation()` naming other
// localization libraries use, so call sites read naturally: `const { t } =
// useTranslation();`
export function useTranslation() {
  const { t, locale, direction } = useI18n();
  return { t, locale, direction };
}
