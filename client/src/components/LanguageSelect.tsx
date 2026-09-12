import type { DocumentLanguage } from "../api/types";
import { useTranslation } from "../i18n/I18nProvider";

// The options here are the document's own language names, always shown in
// their own language regardless of the app's interface locale — this is a
// business-data field (the output language of a generated invoice/quote
// PDF), never the app's session-locale switcher, so it is never translated.
export const languageLabel: Record<DocumentLanguage, string> = {
  ar: "العربية",
  fr: "Français",
  en: "English",
};

export function LanguageSelect({
  value,
  onChange,
}: {
  value: DocumentLanguage;
  onChange: (language: DocumentLanguage) => void;
}) {
  const { t } = useTranslation();
  return (
    <label className="text-sm text-stone-600">
      {t("languageSelect.label")}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as DocumentLanguage)}
        className="mt-1 block rounded-md border border-stone-300 px-3 py-2 text-sm"
      >
        {(Object.keys(languageLabel) as DocumentLanguage[]).map((lang) => (
          <option key={lang} value={lang}>
            {languageLabel[lang]}
          </option>
        ))}
      </select>
    </label>
  );
}
