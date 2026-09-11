import { Button } from "./Button";
import { useTranslation } from "../i18n/I18nProvider";

// The one place a raw backend error message is allowed to surface — every
// page should route API failures through this component rather than
// inventing its own red box (the pattern this replaces existed ad hoc in
// NewProjectForm and nowhere else, inconsistently).
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-danger-200 bg-danger-50 px-4 py-3 text-sm text-danger-700">
      <span>{message}</span>
      {onRetry && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      )}
    </div>
  );
}
