import { useEffect, useState } from "react";
import { PlatformLayout } from "../components/PlatformLayout";
import { PageHeader, Card, Badge, ErrorState, EmptyState, Skeleton, MetricCard } from "../../ui";
import { ApiError } from "../../api/client";
import { formatDateTime } from "../../lib/format";
import { getPlatformZatcaSummary } from "../api/zatca";
import type { PlatformZatcaOnboardingStatus, PlatformZatcaSummary } from "../api/types";

// Slice 4 — mirrors client/src/pages/ZatcaSettings.tsx's tenant-facing
// labels for the SAME server-computed status
// (server/src/lib/zatca/domain/onboarding.ts), never "compliant".
const onboardingStatusLabel: Record<PlatformZatcaOnboardingStatus, string> = {
  not_configured: "لم يبدأ الإعداد",
  configuration_incomplete: "الإعداد غير مكتمل",
  ready_for_simulation: "جاهزة للمحاكاة",
  simulation_connected: "متصلة بالمحاكاة",
  simulation_failed: "فشل الاتصال بالمحاكاة",
  production_not_enabled: "الإنتاج غير مفعّل",
};

// MIDAD Admin Dashboard — ZATCA operations (Slice 3). Read-only, real data
// only — every number here comes straight from GET /api/platform/zatca
// (server/src/routes/platformZatca.ts). This page never renders a
// secretRef, credential, or raw authorization header — the backend route
// never even selects those columns, so there is nothing here that could.

export function PlatformZatca() {
  const [summary, setSummary] = useState<PlatformZatcaSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setSummary(null);
    setError(null);
    getPlatformZatcaSummary()
      .then(setSummary)
      .catch((err) => setError(err instanceof ApiError ? err.message : "تعذّر تحميل بيانات ZATCA"));
  }
  useEffect(load, []);

  return (
    <PlatformLayout>
      <PageHeader title="عمليات الفوترة الإلكترونية (ZATCA)" subtitle="نظرة تشغيلية عبر جميع الشركات — كل رقم هنا مصدره API فعلي، بلا أي بيانات اعتماد أو أسرار." />

      {error && <ErrorState message={error} onRetry={load} />}
      {!error && !summary && <Skeleton rows={6} />}

      {!error && summary && (
        <div className="space-y-8">
          <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <MetricCard label="إجمالي وحدات EGS" value={String(summary.totalEgsUnits)} tone="default" />
            <MetricCard label="وحدات نشطة (متصلة)" value={String(summary.byStatus.active ?? 0)} tone={summary.byStatus.active ? "success" : "default"} />
            <MetricCard
              label="بيئة الإنتاج مقابل المحاكاة"
              value={`${summary.byEnvironment.production ?? 0} / ${summary.byEnvironment.simulation ?? 0}`}
              tone="default"
              hint="إنتاج / محاكاة"
            />
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold text-stone-700">توزيع حالة الإعداد عبر الشركات</h2>
            <div className="flex flex-wrap gap-2">
              {(Object.keys(summary.onboardingByStatus) as PlatformZatcaOnboardingStatus[]).map((status) => (
                <Badge key={status} tone={summary.onboardingByStatus[status] > 0 ? "info" : "neutral"}>
                  {onboardingStatusLabel[status]}: {summary.onboardingByStatus[status]}
                </Badge>
              ))}
            </div>
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold text-stone-700">حالات إرسالات ZATCA (Simulation)</h2>
            {Object.keys(summary.submissionsByState).length === 0 ? (
              <EmptyState message="لا توجد إرسالات مسجّلة بعد." />
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
            <h2 className="mb-3 text-sm font-semibold text-stone-700">شهادات قريبة من الانتهاء (خلال ٣٠ يوماً)</h2>
            {summary.expiringCertificates.length === 0 ? (
              <EmptyState message="لا توجد شهادات قريبة من الانتهاء." />
            ) : (
              <Card className="divide-y divide-stone-100">
                {summary.expiringCertificates.map((c) => (
                  <div key={c.egsUnitId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                    <span className="font-medium text-stone-800">{c.companyName ?? "شركة غير معروفة"}</span>
                    <span className="text-xs text-stone-400">{c.environment}</span>
                    <Badge tone="warning">تنتهي: {formatDateTime(c.certificateExpiresAt)}</Badge>
                  </div>
                ))}
              </Card>
            )}
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold text-stone-700">آخر محاولات تحقق فاشلة</h2>
            {summary.recentFailedChecks.length === 0 ? (
              <EmptyState message="لا توجد محاولات فاشلة مسجّلة." />
            ) : (
              <Card className="divide-y divide-stone-100">
                {summary.recentFailedChecks.map((e) => (
                  <div key={e.id} className="px-4 py-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium text-stone-800">{e.companyName ?? "شركة غير معروفة"}</span>
                      <span className="text-xs text-stone-400">{formatDateTime(e.createdAt)}</span>
                    </div>
                    <p className="mt-1 text-xs text-stone-500">{e.action}</p>
                  </div>
                ))}
              </Card>
            )}
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold text-stone-700">آخر عمليات الإرسال إلى ZATCA</h2>
            {summary.recentSubmissions.length === 0 ? (
              <EmptyState message="لا توجد عمليات إرسال بعد — هذه الشريحة لا تُفعّل الإرسال التلقائي من الفواتير." />
            ) : (
              <Card className="divide-y divide-stone-100">
                {summary.recentSubmissions.map((s) => (
                  <div key={s.id} className="px-4 py-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium text-stone-800">{s.companyName ?? "شركة غير معروفة"}</span>
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
