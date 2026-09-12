import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PlatformLayout } from "../components/PlatformLayout";
import { PageHeader, Card, Badge, Button, EmptyState, ErrorState, Skeleton, MetricCard } from "../../ui";
import { ApiError } from "../../api/client";
import { formatDateTime } from "../../lib/format";
import { checkHealthLive, checkHealthReady, type HealthStatus } from "../api/health";
import { listOrganizations } from "../api/organizations";
import { listMySupportSessions } from "../api/supportSessions";
import { listPlatformActivity } from "../api/auditEvents";
import type { Organization, SupportSessionSummary, PlatformActivityEvent, SupportSessionStatus } from "../api/types";
import { useTranslation } from "../../i18n/I18nProvider";

// MIDAD Admin Dashboard — the real operational landing page for platform
// operators (per docs/MIDAD_MASTER_PROMPT.md Part XI). Every figure here
// comes from a real API call to infrastructure that already existed
// (health endpoints, organizations, support sessions, and the one new
// self-scoped platform activity endpoint) — nothing is computed, guessed,
// or hardcoded "healthy". Where a real signal genuinely doesn't exist yet
// (an error/incident store), this page says so explicitly rather than
// fabricating one — see the note at the bottom of the activity section.

const supportStatusTone: Record<SupportSessionStatus, "success" | "warning" | "danger"> = {
  active: "success",
  expired: "warning",
  revoked: "danger",
};

type Health = { value: HealthStatus | null; error: string | null; checkedAt: string | null };

export function PlatformDashboard() {
  const { t, locale } = useTranslation();
  const [live, setLive] = useState<Health>({ value: null, error: null, checkedAt: null });
  const [ready, setReady] = useState<Health>({ value: null, error: null, checkedAt: null });

  const [orgs, setOrgs] = useState<Organization[] | null>(null);
  const [orgsError, setOrgsError] = useState<string | null>(null);

  const [sessions, setSessions] = useState<SupportSessionSummary[] | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);

  const [activity, setActivity] = useState<PlatformActivityEvent[] | null>(null);
  const [activityHasMore, setActivityHasMore] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [loadingMoreActivity, setLoadingMoreActivity] = useState(false);

  function loadHealth() {
    const now = new Date().toISOString();
    checkHealthLive()
      .then((value) => setLive({ value, error: null, checkedAt: now }))
      .catch((err) => setLive({ value: null, error: err instanceof ApiError ? err.message : t("platformDashboardPage.connectionError"), checkedAt: now }));
    checkHealthReady()
      .then((value) => setReady({ value, error: null, checkedAt: now }))
      .catch((err) => setReady({ value: null, error: err instanceof ApiError ? err.message : t("platformDashboardPage.connectionError"), checkedAt: now }));
  }

  function loadOrgs() {
    setOrgs(null);
    setOrgsError(null);
    listOrganizations(5, 0)
      .then((page) => setOrgs(page.organizations))
      .catch((err) => setOrgsError(err instanceof ApiError ? err.message : t("platformDashboardPage.orgsLoadError")));
  }

  function loadSessions() {
    setSessions(null);
    setSessionsError(null);
    listMySupportSessions(5, 0)
      .then((page) => setSessions(page.sessions))
      .catch((err) => setSessionsError(err instanceof ApiError ? err.message : t("platformSupportSessionsPage.loadError")));
  }

  function loadActivity() {
    setActivity(null);
    setActivityError(null);
    listPlatformActivity(10, 0)
      .then((page) => {
        setActivity(page.events);
        setActivityHasMore(page.hasMore);
      })
      .catch((err) => setActivityError(err instanceof ApiError ? err.message : t("platformSupportSessionPage.loadError")));
  }

  async function loadMoreActivity() {
    if (!activity) return;
    setLoadingMoreActivity(true);
    try {
      const page = await listPlatformActivity(10, activity.length);
      setActivity([...activity, ...page.events]);
      setActivityHasMore(page.hasMore);
    } catch (err) {
      setActivityError(err instanceof ApiError ? err.message : t("platformSupportSessionsPage.loadMoreError"));
    } finally {
      setLoadingMoreActivity(false);
    }
  }

  useEffect(() => {
    loadHealth();
    loadOrgs();
    loadSessions();
    loadActivity();
  }, []);

  const activeSessionCount = sessions?.filter((s) => s.status === "active").length;

  const overallOk = live.value?.status === "ok" && ready.value?.status === "ok";
  const overallKnown = live.checkedAt !== null && ready.checkedAt !== null;

  return (
    <PlatformLayout>
      <PageHeader title={t("platformLayout.dashboard")} subtitle={t("platformDashboardPage.subtitle")} />

      <section className="mb-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-stone-700">{t("platformDashboardPage.healthHeading")}</h2>
          <Button variant="secondary" size="sm" onClick={loadHealth}>
            {t("platformDashboardPage.rerunCheck")}
          </Button>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <MetricCard
            label={t("platformDashboardPage.apiStatusLabel")}
            value={live.checkedAt === null ? t("platformDashboardPage.checking") : live.value?.status === "ok" ? t("platformDashboardPage.apiUp") : t("platformDashboardPage.apiDown")}
            tone={live.checkedAt === null ? "default" : live.value?.status === "ok" ? "success" : "danger"}
            hint={live.error ?? undefined}
          />
          <MetricCard
            label={t("platformDashboardPage.dbStatusLabel")}
            value={ready.checkedAt === null ? t("platformDashboardPage.checking") : ready.value?.status === "ok" ? t("platformDashboardPage.dbReady") : t("platformDashboardPage.dbNotReady")}
            tone={ready.checkedAt === null ? "default" : ready.value?.status === "ok" ? "success" : "danger"}
            hint={ready.error ?? undefined}
          />
          <MetricCard
            label={t("platformDashboardPage.overallStatusLabel")}
            value={!overallKnown ? t("platformDashboardPage.checking") : overallOk ? t("platformDashboardPage.overallHealthy") : t("platformDashboardPage.overallNeedsAttention")}
            tone={!overallKnown ? "default" : overallOk ? "success" : "danger"}
            hint={live.checkedAt ? t("platformDashboardPage.lastCheckedHint", { date: formatDateTime(live.checkedAt, locale) }) : undefined}
          />
        </div>
      </section>

      <section className="mb-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-stone-700">{t("platformLayout.organizations")}</h2>
          <Link to="/platform/organizations" className="text-sm text-primary hover:underline">
            {t("platformDashboardPage.viewAllOrganizations")}
          </Link>
        </div>
        {orgsError && <ErrorState message={orgsError} onRetry={loadOrgs} />}
        {!orgsError && !orgs && <Skeleton rows={3} />}
        {!orgsError && orgs && orgs.length === 0 && <EmptyState message={t("platformDashboardPage.orgsEmptyMessage")} />}
        {!orgsError && orgs && orgs.length > 0 && (
          <Card className="divide-y divide-stone-100">
            {orgs.map((org) => (
              <div key={org.id} className="flex items-center justify-between px-4 py-3 text-sm">
                <span className="font-medium text-stone-800">{org.name}</span>
                <span className="text-xs text-stone-400">{formatDateTime(org.createdAt, locale)}</span>
              </div>
            ))}
          </Card>
        )}
      </section>

      <section className="mb-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-stone-700">
            {t("platformDashboardPage.activeSupportSessionsHeading")} {sessions && activeSessionCount !== undefined ? `(${activeSessionCount})` : ""}
          </h2>
          <Link to="/platform/support-sessions" className="text-sm text-primary hover:underline">
            {t("platformDashboardPage.viewAllSessions")}
          </Link>
        </div>
        {sessionsError && <ErrorState message={sessionsError} onRetry={loadSessions} />}
        {!sessionsError && !sessions && <Skeleton rows={3} />}
        {!sessionsError && sessions && sessions.length === 0 && <EmptyState message={t("platformSupportSessionsPage.emptyMessage")} />}
        {!sessionsError && sessions && sessions.length > 0 && (
          <Card className="divide-y divide-stone-100">
            {sessions.map((session) => (
              <Link
                key={session.id}
                to={`/platform/support-sessions/${session.id}`}
                className="flex items-center justify-between px-4 py-3 text-sm hover:bg-stone-50"
              >
                <div className="min-w-0">
                  <p className="font-medium text-stone-800">{session.targetCompanyName ?? t("platformSupportSessionsPage.unknownCompany")}</p>
                  <p className="mt-0.5 text-xs text-stone-400">{t("platformDashboardPage.createdAt", { date: formatDateTime(session.createdAt, locale) })}</p>
                </div>
                <Badge tone={supportStatusTone[session.status]}>{t(`platformSupportSessionsPage.status.${session.status}`)}</Badge>
              </Link>
            ))}
          </Card>
        )}
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-stone-700">{t("platformDashboardPage.recentActivityHeading")}</h2>
        </div>
        {activityError && <ErrorState message={activityError} onRetry={loadActivity} />}
        {!activityError && !activity && <Skeleton rows={4} />}
        {!activityError && activity && activity.length === 0 && (
          <EmptyState message={t("platformDashboardPage.activityEmptyMessage")} />
        )}
        {!activityError && activity && activity.length > 0 && (
          <>
            <Card className="divide-y divide-stone-100">
              {activity.map((event) => (
                <div key={event.id} className="px-4 py-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-stone-800">
                      {event.action === "supportSession.granted" && t("platformDashboardPage.actionGranted")}
                      {event.action === "supportSession.revoked" && t("platformDashboardPage.actionRevoked")}
                      {event.action !== "supportSession.granted" && event.action !== "supportSession.revoked" && event.action}
                      {" — "}
                      {event.companyName ?? t("platformSupportSessionsPage.unknownCompany")}
                    </span>
                    <span className="text-xs text-stone-400">{formatDateTime(event.createdAt, locale)}</span>
                  </div>
                  {event.reason && <p className="mt-1 text-xs text-stone-500">{event.reason}</p>}
                </div>
              ))}
            </Card>
            {activityHasMore && (
              <div className="mt-3 text-center">
                <Button variant="secondary" size="sm" disabled={loadingMoreActivity} onClick={loadMoreActivity}>
                  {loadingMoreActivity ? t("quotesPage.loadingMore") : t("quotesPage.loadMore")}
                </Button>
              </div>
            )}
          </>
        )}
        <p className="mt-3 text-xs text-stone-400">
          {t("platformDashboardPage.diagnosticsNote")}
        </p>
      </section>
    </PlatformLayout>
  );
}
