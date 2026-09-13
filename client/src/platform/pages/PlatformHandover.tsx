import { useEffect, useState } from "react";
import { PlatformLayout } from "../components/PlatformLayout";
import { PageHeader, Card, MetricCard, ErrorState, Skeleton } from "../../ui";
import { ApiError } from "../../api/client";
import { getHandoverSummary } from "../api/handover";
import type { HandoverSummary } from "../api/types";
import { useTranslation } from "../../i18n/I18nProvider";

// MIDAD Final Pre-Launch audit, Phase 22 (UX) — Phase 17's Sale/Handover
// Center (server/src/routes/platformHandover.ts). Every figure here is a
// real aggregate the backend computed; `notAvailable` is rendered exactly
// as returned — never silently dropped — so a buyer's technical review
// sees the same honesty the API itself commits to.
export function PlatformHandover() {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<HandoverSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setSummary(null);
    setError(null);
    getHandoverSummary()
      .then(setSummary)
      .catch((err) => setError(err instanceof ApiError ? err.message : t("platformHandoverPage.loadError")));
  }

  useEffect(load, []);

  return (
    <PlatformLayout>
      <PageHeader title={t("platformHandoverPage.title")} subtitle={t("platformHandoverPage.subtitle")} />

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : !summary ? (
        <Skeleton rows={6} />
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <MetricCard label={t("platformHandoverPage.organizations")} value={`${summary.organizations.active} / ${summary.organizations.total}`} hint={t("platformHandoverPage.activeOfTotal")} />
            <MetricCard label={t("platformHandoverPage.platformOperators")} value={String(summary.platformOperators.total)} />
            <MetricCard label={t("platformHandoverPage.openIncidents")} value={String(summary.openIncidents.open + summary.openIncidents.investigating)} tone={summary.openIncidents.open > 0 ? "danger" : "default"} />
            <MetricCard label={t("platformHandoverPage.featureFlags")} value={`${summary.featureFlags.globallyEnabled} / ${summary.featureFlags.total}`} />
            <MetricCard label={t("platformHandoverPage.plans")} value={`${summary.plans.active} / ${summary.plans.total}`} />
            <MetricCard label={t("platformHandoverPage.schemaMigrations")} value={String(summary.schema.migrationCount)} hint={summary.schema.latestMigrationTag} />
          </div>

          <Card className="p-4">
            <p className="text-sm font-semibold text-stone-700">{t("platformHandoverPage.backupHeading")}</p>
            <p className="mt-1 text-sm text-stone-600">
              {summary.backup.found ? t("platformHandoverPage.backupFound", { seconds: summary.backup.ageSeconds ?? 0 }) : t("platformHandoverPage.backupNotFound")}
            </p>
            <p className="mt-1 text-xs text-stone-400">{summary.backup.restoreDrillTrackedIn}</p>
          </Card>

          <Card className="p-4">
            <p className="text-sm font-semibold text-stone-700">{t("platformHandoverPage.zatcaHeading")}</p>
            <p className="mt-1 text-sm text-stone-600">{t("platformHandoverPage.zatcaNotVerified")}</p>
            <p className="mt-1 text-xs text-stone-400">{summary.zatca.statusDocument}</p>
          </Card>

          <Card className="p-4">
            <p className="text-sm font-semibold text-stone-700">{t("platformHandoverPage.notAvailableHeading")}</p>
            <ul className="mt-1 list-inside list-disc text-sm text-stone-600">
              {summary.notAvailable.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-stone-400">{summary.launchChecklistDocument}</p>
          </Card>
        </div>
      )}
    </PlatformLayout>
  );
}
