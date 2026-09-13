import { useEffect, useState } from "react";
import { PlatformLayout } from "../components/PlatformLayout";
import { PageHeader, Card, Badge, ErrorState, Skeleton, EmptyState, MetricCard, Tabs, type TabItem } from "../../ui";
import { ApiError } from "../../api/client";
import { formatDateTime } from "../../lib/format";
import { getSecurityOverview, listAdminSessions, listSensitiveActions } from "../api/security";
import type { SecurityOverview, AdminSessionSummary, SensitiveActionEvent, SupportSessionStatus } from "../api/types";
import { useTranslation } from "../../i18n/I18nProvider";

// MIDAD Final Pre-Launch audit, Phase 22 (UX) — Phase 7's Security Center
// + Phase 8's hardened audit trail (server/src/routes/platformSecurity.ts).
// "Sensitive actions" doubles as this product's Audit Center — a separate
// page was not built for that, since this global feed is exactly what an
// audit center means here (see that route's own header comment).
const statusTone: Record<SupportSessionStatus, "success" | "warning" | "danger"> = {
  active: "success",
  expired: "warning",
  revoked: "danger",
};

export function PlatformSecurity() {
  const { t, locale } = useTranslation();
  const [tab, setTab] = useState("overview");

  const tabs: TabItem[] = [
    { key: "overview", label: t("platformSecurityPage.tabs.overview") },
    { key: "adminSessions", label: t("platformSecurityPage.tabs.adminSessions") },
    { key: "sensitiveActions", label: t("platformSecurityPage.tabs.sensitiveActions") },
  ];

  return (
    <PlatformLayout>
      <PageHeader title={t("platformSecurityPage.title")} subtitle={t("platformSecurityPage.subtitle")} />
      <div className="mb-4">
        <Tabs items={tabs} active={tab} onChange={setTab} />
      </div>
      {tab === "overview" && <OverviewTab />}
      {tab === "adminSessions" && <AdminSessionsTab />}
      {tab === "sensitiveActions" && <SensitiveActionsTab />}
    </PlatformLayout>
  );
}

function OverviewTab() {
  const { t } = useTranslation();
  const [overview, setOverview] = useState<SecurityOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setOverview(null);
    setError(null);
    getSecurityOverview()
      .then(setOverview)
      .catch((err) => setError(err instanceof ApiError ? err.message : t("platformSecurityPage.loadError")));
  }

  useEffect(load, []);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!overview) return <Skeleton rows={4} />;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <MetricCard label={t("platformSecurityPage.overview.activeAdminSessions")} value={String(overview.adminSessions.active)} />
        <MetricCard label={t("platformSecurityPage.overview.revokedAdminSessions")} value={String(overview.adminSessions.revoked)} />
        <MetricCard label={t("platformSecurityPage.overview.activeTenantSessions")} value={String(overview.tenantSessions.activeCount)} />
      </div>
      <Card className="p-4 text-xs text-stone-500">
        {t("platformSecurityPage.overview.notAvailableNote")}: {overview.notAvailable.join(", ")}
      </Card>
    </div>
  );
}

function AdminSessionsTab() {
  const { t, locale } = useTranslation();
  const [sessions, setSessions] = useState<AdminSessionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  function load() {
    setSessions(null);
    setError(null);
    listAdminSessions(20, 0)
      .then((page) => {
        setSessions(page.sessions);
        setHasMore(page.hasMore);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : t("platformSecurityPage.loadError")));
  }

  useEffect(load, []);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!sessions) return <Skeleton rows={4} />;
  if (sessions.length === 0) return <EmptyState message={t("platformSecurityPage.adminSessions.emptyMessage")} />;

  return (
    <div>
      <Card className="divide-y divide-stone-100">
        {sessions.map((s) => (
          <div key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
            <div className="min-w-0">
              <p className="font-medium text-stone-800">
                {s.platformOperatorName ?? t("platformSecurityPage.unknownOperator")} → {s.targetCompanyName ?? t("platformSupportSessionsPage.unknownCompany")}
              </p>
              <p className="text-xs text-stone-400">{s.reason}</p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-stone-400">{formatDateTime(s.createdAt, locale)}</span>
              <Badge tone={statusTone[s.status]}>{t(`platformSupportSessionsPage.status.${s.status}`)}</Badge>
            </div>
          </div>
        ))}
      </Card>
      {hasMore && <p className="mt-3 text-center text-xs text-stone-400">{t("platformSecurityPage.moreAvailable")}</p>}
    </div>
  );
}

function SensitiveActionsTab() {
  const { t, locale } = useTranslation();
  const [events, setEvents] = useState<SensitiveActionEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  function load() {
    setEvents(null);
    setError(null);
    listSensitiveActions(20, 0)
      .then((page) => {
        setEvents(page.events);
        setHasMore(page.hasMore);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : t("platformSecurityPage.loadError")));
  }

  useEffect(load, []);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!events) return <Skeleton rows={4} />;
  if (events.length === 0) return <EmptyState message={t("platformSecurityPage.sensitiveActions.emptyMessage")} />;

  return (
    <div>
      <Card className="divide-y divide-stone-100">
        {events.map((e) => (
          <div key={e.id} className="px-4 py-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium text-stone-800">
                {e.action} — {e.companyName ?? t("platformSupportSessionsPage.unknownCompany")}
              </span>
              <span className="text-xs text-stone-400">{formatDateTime(e.createdAt, locale)}</span>
            </div>
            {e.reason && <p className="mt-1 text-xs text-stone-500">{e.reason}</p>}
            {e.platformOperatorName && <p className="mt-0.5 text-xs text-stone-400">{t("platformSecurityPage.byOperator", { name: e.platformOperatorName })}</p>}
          </div>
        ))}
      </Card>
      {hasMore && <p className="mt-3 text-center text-xs text-stone-400">{t("platformSecurityPage.moreAvailable")}</p>}
    </div>
  );
}
