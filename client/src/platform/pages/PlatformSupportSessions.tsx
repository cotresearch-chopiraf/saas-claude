import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PlatformLayout } from "../components/PlatformLayout";
import { PageHeader, Card, Badge, Button, EmptyState, ErrorState, Skeleton } from "../../ui";
import { ApiError } from "../../api/client";
import { formatDateTime } from "../../lib/format";
import { listMySupportSessions } from "../api/supportSessions";
import type { SupportSessionStatus, SupportSessionSummary } from "../api/types";
import { useTranslation } from "../../i18n/I18nProvider";

const PAGE_SIZE = 20;

const statusTone: Record<SupportSessionStatus, "success" | "warning" | "danger"> = {
  active: "success",
  expired: "warning",
  revoked: "danger",
};

// "My active sessions" — a pure read completion of D2's already-authorized
// support-session lifecycle (grant/activity/revoke, all pre-existing in
// PlatformOrganizations.tsx / PlatformSupportSession.tsx). This page adds
// no new mutation of its own — revoking still happens only on the existing
// session-detail page, reached here via a plain link, exactly the same way
// PlatformOrganizations' own row actions already navigate there.
export function PlatformSupportSessions() {
  const { t, locale } = useTranslation();
  const [sessions, setSessions] = useState<SupportSessionSummary[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  function load() {
    setSessions(null);
    setError(null);
    listMySupportSessions(PAGE_SIZE, 0)
      .then((page) => {
        setSessions(page.sessions);
        setHasMore(page.hasMore);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : t("platformSupportSessionsPage.loadError")));
  }
  useEffect(load, []);

  async function loadMore() {
    if (!sessions) return;
    setLoadingMore(true);
    try {
      const page = await listMySupportSessions(PAGE_SIZE, sessions.length);
      setSessions([...sessions, ...page.sessions]);
      setHasMore(page.hasMore);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("platformSupportSessionsPage.loadMoreError"));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <PlatformLayout>
      <PageHeader title={t("platformLayout.supportSessions")} subtitle={t("platformSupportSessionsPage.subtitle")} />

      {error && <ErrorState message={error} onRetry={load} />}
      {!error && !sessions && <Skeleton rows={6} />}
      {!error && sessions && sessions.length === 0 && <EmptyState message={t("platformSupportSessionsPage.emptyMessage")} />}

      {!error && sessions && sessions.length > 0 && (
        <div className="space-y-3">
          {sessions.map((session) => (
            <Card key={session.id} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm text-stone-800">
                    <span className="font-medium">{session.targetCompanyName ?? t("platformSupportSessionsPage.unknownCompany")}</span>
                  </p>
                  <p className="mt-1 text-xs text-stone-500">{session.reason}</p>
                  <p className="mt-1 text-xs text-stone-400">
                    {t("platformSupportSessionsPage.createdAndExpires", { createdAt: formatDateTime(session.createdAt, locale), expiresAt: formatDateTime(session.expiresAt, locale) })}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-2">
                  <Badge tone={statusTone[session.status]}>{t(`platformSupportSessionsPage.status.${session.status}`)}</Badge>
                  <Link to={`/platform/support-sessions/${session.id}`} className="text-sm text-primary hover:underline">
                    {t("platformSupportSessionsPage.open")}
                  </Link>
                </div>
              </div>
            </Card>
          ))}
          {hasMore && (
            <div className="pt-2 text-center">
              <Button variant="secondary" size="sm" disabled={loadingMore} onClick={loadMore}>
                {loadingMore ? t("quotesPage.loadingMore") : t("quotesPage.loadMore")}
              </Button>
            </div>
          )}
        </div>
      )}
    </PlatformLayout>
  );
}
