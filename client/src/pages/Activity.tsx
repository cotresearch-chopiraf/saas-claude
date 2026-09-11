import { useEffect, useState } from "react";
import { Layout } from "../components/Layout";
import { Card, PageHeader, EmptyState, ErrorState, Skeleton, Button } from "../ui";
import { ApiError } from "../api/client";
import { listActivity } from "../api/auditEvents";
import type { ActivityEvent } from "../api/types";
import { formatDateTime } from "../lib/format";
import { useTranslation } from "../i18n/I18nProvider";

// MIDAD Phase C — Activity Timeline. Reads the canonical audit_events
// table through GET /api/audit-events (server/src/routes/auditEvents.ts);
// this component never computes, totals, or reinterprets anything —
// purely a chronological, paginated display of what the backend already
// returns. Newest first, per the endpoint's own ordering contract.

// The real, verified set of entityType values this codebase's audit
// writers actually use (grepped from every recordAuditEvent call site) —
// never a guess, and never claims to be exhaustive of some future domain.
// Keys match activityPage.entityTypes.* in the translation dictionaries.
const ENTITY_TYPES = [
  "boq_revision",
  "budget_item",
  "budget_revision",
  "commitment",
  "commitment_line",
  "company_compliance_profile",
  "company_logo",
  "company_tax_override",
  "contract",
  "cost_code",
  "customer",
  "expense",
  "forecast_snapshot",
  "invoice",
  "ipc",
  "ipc_line",
  "measurement",
  "measurement_line",
  "subcontract_ipc",
  "subcontract_ipc_line",
  "supplier",
  "user",
] as const;

function entityTypeLabel(t: (key: string) => string, entityType: string): string {
  return ENTITY_TYPES.includes(entityType as (typeof ENTITY_TYPES)[number])
    ? t(`activityPage.entityTypes.${entityType}`)
    : entityType;
}

const PAGE_SIZE = 20;

export function Activity() {
  const { t, locale } = useTranslation();
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [entityType, setEntityType] = useState<string>("");

  function load(filterEntityType: string) {
    setEvents(null);
    setError(null);
    listActivity({ limit: PAGE_SIZE, offset: 0, entityType: filterEntityType || undefined })
      .then((page) => {
        setEvents(page.events);
        setHasMore(page.hasMore);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : t("activityPage.loadError")));
  }

  useEffect(() => load(entityType), [entityType]);

  async function loadMore() {
    if (!events) return;
    setLoadingMore(true);
    try {
      const page = await listActivity({ limit: PAGE_SIZE, offset: events.length, entityType: entityType || undefined });
      setEvents([...events, ...page.events]);
      setHasMore(page.hasMore);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("activityPage.loadMoreError"));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <Layout>
      <PageHeader
        title={t("activityPage.title")}
        subtitle={t("activityPage.subtitle")}
        actions={
          <select
            value={entityType}
            onChange={(e) => setEntityType(e.target.value)}
            className="rounded-md border border-stone-300 px-3 py-2 text-sm"
          >
            <option value="">{t("activityPage.allTypes")}</option>
            {ENTITY_TYPES.map((value) => (
              <option key={value} value={value}>{entityTypeLabel(t, value)}</option>
            ))}
          </select>
        }
      />

      {error && <ErrorState message={error} onRetry={() => load(entityType)} />}

      {!error && !events && <Skeleton rows={6} />}

      {!error && events && events.length === 0 && <EmptyState message={t("activityPage.emptyMessage")} />}

      {!error && events && events.length > 0 && (
        <div className="space-y-3">
          {events.map((event) => (
            <ActivityRow key={event.id} event={event} locale={locale} />
          ))}
          {hasMore && (
            <div className="pt-2 text-center">
              <Button variant="secondary" size="sm" disabled={loadingMore} onClick={loadMore}>
                {loadingMore ? t("activityPage.loadingMore") : t("activityPage.loadMore")}
              </Button>
            </div>
          )}
        </div>
      )}
    </Layout>
  );
}

function ActivityRow({ event, locale }: { event: ActivityEvent; locale: string }) {
  const { t } = useTranslation();
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm text-stone-800">
            <span className="font-medium">{event.actorName ?? t("activityPage.system")}</span>
            {" — "}
            <span className="font-mono text-stone-600">{event.action}</span>
          </p>
          <p className="mt-1 text-xs text-stone-500">
            {entityTypeLabel(t, event.entityType)} · {event.entityId.slice(0, 8)}
          </p>
          {event.reason && <p className="mt-1 text-xs text-stone-500">{t("activityPage.reasonLabel", { reason: event.reason })}</p>}
        </div>
        <span className="shrink-0 text-xs text-stone-400">{formatDateTime(event.createdAt, locale)}</span>
      </div>
    </Card>
  );
}
