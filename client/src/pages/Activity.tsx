import { useEffect, useState } from "react";
import { Layout } from "../components/Layout";
import { Card, PageHeader, EmptyState, ErrorState, Skeleton, Button } from "../ui";
import { ApiError } from "../api/client";
import { listActivity } from "../api/auditEvents";
import type { ActivityEvent } from "../api/types";
import { formatDateTime } from "../lib/format";

// MIDAD Phase C — Activity Timeline. Reads the canonical audit_events
// table through GET /api/audit-events (server/src/routes/auditEvents.ts);
// this component never computes, totals, or reinterprets anything —
// purely a chronological, paginated display of what the backend already
// returns. Newest first, per the endpoint's own ordering contract.

// The real, verified set of entityType values this codebase's audit
// writers actually use (grepped from every recordAuditEvent call site) —
// never a guess, and never claims to be exhaustive of some future domain.
const ENTITY_TYPE_LABELS: Record<string, string> = {
  boq_revision: "نسخة جدول الكميات",
  budget_item: "بند ميزانية",
  budget_revision: "مراجعة ميزانية",
  commitment: "التزام تعاقدي",
  commitment_line: "بند التزام",
  company_compliance_profile: "الملف الضريبي",
  company_logo: "شعار الشركة",
  company_tax_override: "استثناء ضريبي",
  contract: "عقد",
  cost_code: "بند تكلفة",
  customer: "عميل",
  expense: "مصروف",
  forecast_snapshot: "لقطة توقع مالي",
  invoice: "فاتورة",
  ipc: "شهادة دفعة (مالك)",
  ipc_line: "بند شهادة دفعة",
  measurement: "كشف حصر",
  measurement_line: "بند كشف حصر",
  subcontract_ipc: "شهادة دفعة (مقاول باطن)",
  subcontract_ipc_line: "بند شهادة دفعة مقاول باطن",
  supplier: "مورد",
  user: "مستخدم",
};

function entityTypeLabel(entityType: string): string {
  return ENTITY_TYPE_LABELS[entityType] ?? entityType;
}

const PAGE_SIZE = 20;

export function Activity() {
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
      .catch((err) => setError(err instanceof ApiError ? err.message : "تعذّر تحميل سجل النشاط"));
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
      setError(err instanceof ApiError ? err.message : "تعذّر تحميل المزيد");
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <Layout>
      <PageHeader
        title="سجل النشاط"
        subtitle="من قام بماذا، وعلى ماذا، ومتى — لكل الشركة"
        actions={
          <select
            value={entityType}
            onChange={(e) => setEntityType(e.target.value)}
            className="rounded-md border border-stone-300 px-3 py-2 text-sm"
          >
            <option value="">كل الأنواع</option>
            {Object.entries(ENTITY_TYPE_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        }
      />

      {error && <ErrorState message={error} onRetry={() => load(entityType)} />}

      {!error && !events && <Skeleton rows={6} />}

      {!error && events && events.length === 0 && <EmptyState message="لا يوجد نشاط بعد." />}

      {!error && events && events.length > 0 && (
        <div className="space-y-3">
          {events.map((event) => (
            <ActivityRow key={event.id} event={event} />
          ))}
          {hasMore && (
            <div className="pt-2 text-center">
              <Button variant="secondary" size="sm" disabled={loadingMore} onClick={loadMore}>
                {loadingMore ? "جارٍ التحميل..." : "تحميل المزيد"}
              </Button>
            </div>
          )}
        </div>
      )}
    </Layout>
  );
}

function ActivityRow({ event }: { event: ActivityEvent }) {
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm text-stone-800">
            <span className="font-medium">{event.actorName ?? "النظام"}</span>
            {" — "}
            <span className="font-mono text-stone-600">{event.action}</span>
          </p>
          <p className="mt-1 text-xs text-stone-500">
            {entityTypeLabel(event.entityType)} · {event.entityId.slice(0, 8)}
          </p>
          {event.reason && <p className="mt-1 text-xs text-stone-500">السبب: {event.reason}</p>}
        </div>
        <span className="shrink-0 text-xs text-stone-400">{formatDateTime(event.createdAt)}</span>
      </div>
    </Card>
  );
}
