import type { Locale } from "../locales";
import ar from "./ar";
import fr from "./fr";
import en from "./en";

export type TranslationValue = string | { [key: string]: TranslationValue };

export const translations: Record<Locale, Record<string, TranslationValue>> = {
  ar,
  fr,
  en,
};
