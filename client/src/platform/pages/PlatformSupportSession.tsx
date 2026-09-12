import { useEffect, useState } from "react";
import { useLocation, useParams } from "react-router-dom";
import { PlatformLayout } from "../components/PlatformLayout";
import { PageHeader, Card, Button, EmptyState, ErrorState, Skeleton } from "../../ui";
import { ApiError } from "../../api/client";
import { formatDateTime } from "../../lib/format";
import { readSupportSessionActivity, revokeSupportSession } from "../api/supportSessions";
import type { SupportActivityEvent } from "../api/types";
import { useTranslation } from "../../i18n/I18nProvider";

const PAGE_SIZE = 20;

// Reachable only from PlatformOrganizations' "طلب وصول دعم" flow (which
// creates the session first) or a direct link/bookmark to an id already
// granted — there is no "list my sessions" screen in this slice (no
// backend route for it either; see the Phase D2 report's own explicit
// deferral). organizationName arrives via router state from the page that
// already had it, with a neutral fallback for a bare refresh/direct visit
// — never re-fetched or guessed.
export function PlatformSupportSession() {
  const { t, locale } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const organizationName = (location.state as { organizationName?: string } | null)?.organizationName;

  const [events, setEvents] = useState<SupportActivityEvent[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [revoked, setRevoked] = useState(false);
  const [revoking, setRevoking] = useState(false);

  function load() {
    if (!id) return;
    setEvents(null);
    setError(null);
    readSupportSessionActivity(id, PAGE_SIZE, 0)
      .then((page) => {
        setEvents(page.events);
        setHasMore(page.hasMore);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : t("platformSupportSessionPage.loadError")));
  }
  useEffect(load, [id]);

  async function loadMore() {
    if (!id || !events) return;
    setLoadingMore(true);
    try {
      const page = await readSupportSessionActivity(id, PAGE_SIZE, events.length);
      setEvents([...events, ...page.events]);
      setHasMore(page.hasMore);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("platformSupportSessionsPage.loadMoreError"));
    } finally {
      setLoadingMore(false);
    }
  }

  async function onRevoke() {
    if (!id) return;
    setRevoking(true);
    try {
      await revokeSupportSession(id);
      setRevoked(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("platformSupportSessionPage.revokeError"));
    } finally {
      setRevoking(false);
    }
  }

  return (
    <PlatformLayout>
      <PageHeader
        title={organizationName ? t("platformSupportSessionPage.titleWithOrg", { organizationName }) : t("platformSupportSessionPage.titleDefault")}
        subtitle={t("platformSupportSessionPage.subtitle")}
        actions={
          !revoked && (
            <Button variant="danger" size="sm" disabled={revoking} onClick={onRevoke}>
              {revoking ? t("platformSupportSessionPage.revoking") : t("platformSupportSessionPage.revokeAccess")}
            </Button>
          )
        }
      />

      {revoked && (
        <div className="mb-4">
          <ErrorState message={t("platformSupportSessionPage.revokedNotice")} />
        </div>
      )}

      {error && <ErrorState message={error} onRetry={load} />}
      {!error && !events && <Skeleton rows={6} />}
      {!error && events && events.length === 0 && <EmptyState message={t("platformSupportSessionPage.emptyMessage")} />}

      {!error && events && events.length > 0 && (
        <div className="space-y-3">
          {events.map((event) => (
            <Card key={event.id} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm text-stone-800">
                    <span className="font-medium">{event.actorName ?? t("platformSupportSessionPage.systemActor")}</span>
                    {" — "}
                    <span className="font-mono text-stone-600">{event.action}</span>
                  </p>
                  <p className="mt-1 text-xs text-stone-500">
                    {event.entityType} · {event.entityId.slice(0, 8)}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-stone-400">{formatDateTime(event.createdAt, locale)}</span>
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
