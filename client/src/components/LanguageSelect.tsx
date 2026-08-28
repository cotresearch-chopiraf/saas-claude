import type { DocumentLanguage } from "../api/types";

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
  return (
    <label className="text-sm text-stone-600">
      لغة المستند
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
