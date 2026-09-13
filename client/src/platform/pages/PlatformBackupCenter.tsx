import { useEffect, useState } from "react";
import { PlatformLayout } from "../components/PlatformLayout";
import { PageHeader, Card, Badge, ErrorState, Skeleton } from "../../ui";
import { ApiError } from "../../api/client";
import { formatDateTime } from "../../lib/format";
import { getBackupStatus } from "../api/backupCenter";
import type { BackupCenterStatus } from "../api/types";
import { useTranslation } from "../../i18n/I18nProvider";

// MIDAD Final Pre-Launch audit, Phase 22 (UX) — Phase 12's Backup Center
// (server/src/routes/platformBackupCenter.ts). Read-only, matching the
// backend's own scope exactly — no restore action lives here (restore is
// a manual, deliberately real procedure per docs/BACKUP_STRATEGY.md, never
// a one-click button over production data).
export function PlatformBackupCenter() {
  const { t, locale } = useTranslation();
  const [status, setStatus] = useState<BackupCenterStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setStatus(null);
    setError(null);
    getBackupStatus()
      .then(setStatus)
      .catch((err) => setError(err instanceof ApiError ? err.message : t("platformBackupCenterPage.loadError")));
  }

  useEffect(load, []);

  return (
    <PlatformLayout>
      <PageHeader title={t("platformBackupCenterPage.title")} subtitle={t("platformBackupCenterPage.subtitle")} />

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : !status ? (
        <Skeleton rows={5} />
      ) : !status.found ? (
        <Card className="p-5">
          <Badge tone="warning">{t("platformBackupCenterPage.notFound")}</Badge>
        </Card>
      ) : (
        <div className="space-y-4">
          <Card className="p-5">
            <div className="flex items-center justify-between">
              <Badge tone="success">{t("platformBackupCenterPage.found")}</Badge>
              {status.ageSeconds !== null && (
                <span className="text-xs text-stone-400">{t("platformBackupCenterPage.age", { seconds: status.ageSeconds })}</span>
              )}
            </div>
            {status.manifest && (
              <dl className="mt-4 grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
                <div>{t("platformBackupCenterPage.createdAt")}: {formatDateTime(status.manifest.createdAt, locale)}</div>
                <div>{t("platformBackupCenterPage.migrationCount")}: {status.manifest.schema.migrationCount}</div>
                <div>{t("platformBackupCenterPage.latestMigrationTag")}: {status.manifest.schema.latestMigrationTag}</div>
                <div>{t("platformBackupCenterPage.sizeBytes")}: {status.manifest.database.sizeBytes.toLocaleString(locale)}</div>
                <div>{t("platformBackupCenterPage.storageIncluded")}: {status.manifest.storage.included ? t("common.yes") : t("common.no")}</div>
              </dl>
            )}
          </Card>
          <Card className="p-4 text-xs text-stone-500">
            {t("platformBackupCenterPage.restoreDrillNote")}: {status.restoreDrillTrackedIn}
          </Card>
        </div>
      )}
    </PlatformLayout>
  );
}
