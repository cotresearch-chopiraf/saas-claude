import { useTranslation } from "../i18n/I18nProvider";

export function Skeleton({ rows = 3 }: { rows?: number }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-2 rounded-lg border border-stone-200 bg-white p-4" role="status" aria-label={t("common.loadingAriaLabel")}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-4 animate-pulse rounded bg-stone-100" style={{ width: `${85 - i * 8}%` }} />
      ))}
    </div>
  );
}
