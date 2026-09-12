import { useEffect, useState } from "react";
import { PlatformLayout } from "../components/PlatformLayout";
import { PageHeader, Card, Badge, ErrorState, EmptyState, Skeleton, MetricCard } from "../../ui";
import { ApiError } from "../../api/client";
import { formatDateTime } from "../../lib/format";
import { getPlatformZatcaSummary } from "../api/zatca";
import type { PlatformZatcaOnboardingStatus, PlatformZatcaSummary } from "../api/types";
import { useTranslation } from "../../i18n/I18nProvider";

// MIDAD Admin Dashboard — ZATCA operations (Slice 3). Read-only, real data
// only — every number here comes straight from GET /api/platform/zatca
// (server/src/routes/platformZatca.ts). This page never renders a
// secretRef, credential, or raw authorization header — the backend route
// never even selects those columns, so there is nothing here that could.

export function PlatformZatca() {
  const { t, locale } = useTranslation();
  const [summary, setSummary] = useState<PlatformZatcaSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setSummary(null);
    setError(null);
    getPlatformZatcaSummary()
      .then(setSummary)
      .catch((err) => setError(err instanceof ApiError ? err.message : t("platformZatcaPage.loadError")));
  }
  useEffect(load, []);

  return (
    <PlatformLayout>
      <PageHeader title={t("platformZatcaPage.title")} subtitle={t("platformZatcaPage.subtitle")} />

      {error && <ErrorState message={error} onRetry={load} />}
      {!error && !summary && <Skeleton rows={6} />}

      {!error && summary && (
        <div className="space-y-8">
          <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <MetricCard label={t("platformZatcaPage.metrics.totalEgsUnits")} value={String(summary.totalEgsUnits)} tone="default" />
            <MetricCard label={t("platformZatcaPage.metrics.activeUnits")} value={String(summary.byStatus.active ?? 0)} tone={summary.byStatus.active ? "success" : "default"} />
            <MetricCard
              label={t("platformZatcaPage.metrics.productionVsSimulation")}
              value={`${summary.byEnvironment.production ?? 0} / ${summary.byEnvironment.simulation ?? 0}`}
              tone="default"
              hint={t("platformZatcaPage.metrics.productionVsSimulationHint")}
            />
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold text-stone-700">{t("platformZatcaPage.onboardingDistributionHeading")}</h2>
            <div className="flex flex-wrap gap-2">
              {(Object.keys(summary.onboardingByStatus) as PlatformZatcaOnboardingStatus[]).map((status) => (
                <Badge key={status} tone={summary.onboardingByStatus[status] > 0 ? "info" : "neutral"}>
                  {t(`platformZatcaPage.onboardingStatus.${status}`)}: {summary.onboardingByStatus[status]}
                </Badge>
              ))}
            </div>
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold text-stone-700">{t("platformZatcaPage.submissionStatesHeading")}</h2>
            {Object.keys(summary.submissionsByState).length === 0 ? (
              <EmptyState message={t("platformZatcaPage.submissionsEmptyMessage")} />
            ) : (
              <div className="flex flex-wrap gap-2">
                {Object.entries(summary.submissionsByState).map(([state, count]) => (
                  <Badge key={state} tone={state === "rejected" || state === "compliance_failed" ? "danger" : state === "cleared" || state === "reported" ? "success" : "neutral"}>
                    {state}: {count}
                  </Badge>
                ))}
              </div>
            )}
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold text-stone-700">{t("platformZatcaPage.expiringCertificatesHeading")}</h2>
            {summary.expiringCertificates.length === 0 ? (
              <EmptyState message={t("platformZatcaPage.expiringCertificatesEmptyMessage")} />
            ) : (
              <Card className="divide-y divide-stone-100">
                {summary.expiringCertificates.map((c) => (
                  <div key={c.egsUnitId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                    <span className="font-medium text-stone-800">{c.companyName ?? t("platformSupportSessionsPage.unknownCompany")}</span>
                    <span className="text-xs text-stone-400">{c.environment}</span>
                    <Badge tone="warning">{t("platformZatcaPage.expiresLabel", { date: formatDateTime(c.certificateExpiresAt, locale) })}</Badge>
                  </div>
                ))}
              </Card>
            )}
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold text-stone-700">{t("platformZatcaPage.recentFailedChecksHeading")}</h2>
            {summary.recentFailedChecks.length === 0 ? (
              <EmptyState message={t("platformZatcaPage.recentFailedChecksEmptyMessage")} />
            ) : (
              <Card className="divide-y divide-stone-100">
                {summary.recentFailedChecks.map((e) => (
                  <div key={e.id} className="px-4 py-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium text-stone-800">{e.companyName ?? t("platformSupportSessionsPage.unknownCompany")}</span>
                      <span className="text-xs text-stone-400">{formatDateTime(e.createdAt, locale)}</span>
                    </div>
                    <p className="mt-1 text-xs text-stone-500">{e.action}</p>
                  </div>
                ))}
              </Card>
            )}
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold text-stone-700">{t("platformZatcaPage.recentSubmissionsHeading")}</h2>
            {summary.recentSubmissions.length === 0 ? (
              <EmptyState message={t("platformZatcaPage.recentSubmissionsEmptyMessage")} />
            ) : (
              <Card className="divide-y divide-stone-100">
                {summary.recentSubmissions.map((s) => (
                  <div key={s.id} className="px-4 py-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium text-stone-800">{s.companyName ?? t("platformSupportSessionsPage.unknownCompany")}</span>
                      <Badge tone={s.state === "rejected" ? "danger" : "neutral"}>{s.state}</Badge>
                    </div>
                    {s.zatcaErrorMessage && <p className="mt-1 text-xs text-danger-700">{s.zatcaErrorMessage}</p>}
                  </div>
                ))}
              </Card>
            )}
          </section>
        </div>
      )}
    </PlatformLayout>
  );
}
