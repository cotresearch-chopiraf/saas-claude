import { useState, useRef, useEffect } from "react";
import { useI18n } from "./I18nProvider";
import { LOCALES } from "./locales";

// Compact language switcher for the app header. Shows the current language
// and a dropdown of the others; selecting one persists immediately via
// I18nProvider's setLocale (localStorage + <html dir/lang>) and re-renders
// every t()-consuming component in place — no page reload.
export function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  const current = LOCALES.find((l) => l.code === locale) ?? LOCALES[0];

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t("languageSwitcher.label")}
        className="flex items-center gap-1.5 rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-xs font-medium text-stone-700 hover:bg-stone-50"
      >
        <span>{current.nativeLabel}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <ul
          role="listbox"
          aria-label={t("languageSwitcher.label")}
          className="absolute end-0 z-20 mt-1 w-32 overflow-hidden rounded-md border border-stone-200 bg-white py-1 shadow-lg"
        >
          {LOCALES.map((l) => (
            <li key={l.code}>
              <button
                type="button"
                role="option"
                aria-selected={l.code === locale}
                onClick={() => {
                  setLocale(l.code);
                  setOpen(false);
                }}
                className={`block w-full px-3 py-1.5 text-start text-sm hover:bg-stone-50 ${
                  l.code === locale ? "font-semibold text-emerald-700" : "text-stone-700"
                }`}
              >
                {l.nativeLabel}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
