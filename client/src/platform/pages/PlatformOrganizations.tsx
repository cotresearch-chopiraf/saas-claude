import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { PlatformLayout } from "../components/PlatformLayout";
import { PageHeader, Card, Button, ErrorState, FinancialTable, type FinancialColumn } from "../../ui";
import { ApiError } from "../../api/client";
import { formatDateTime } from "../../lib/format";
import { listOrganizations } from "../api/organizations";
import { createSupportSession } from "../api/supportSessions";
import type { Organization } from "../api/types";

const PAGE_SIZE = 20;

export function PlatformOrganizations() {
  const [search, setSearch] = useState("");
  const [organizations, setOrganizations] = useState<Organization[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [requestingFor, setRequestingFor] = useState<Organization | null>(null);

  function load(currentSearch: string) {
    setOrganizations(null);
    setError(null);
    listOrganizations(PAGE_SIZE, 0, currentSearch)
      .then((page) => {
        setOrganizations(page.organizations);
        setHasMore(page.hasMore);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "تعذّر تحميل قائمة الشركات"));
  }
  // search is the effect's own dependency — every change (including
  // clearing it back to "") re-fetches through the same real API call,
  // never a client-side filter over stale data.
  useEffect(() => load(search), [search]);

  async function loadMore() {
    if (!organizations) return;
    setLoadingMore(true);
    try {
      const page = await listOrganizations(PAGE_SIZE, organizations.length, search);
      setOrganizations([...organizations, ...page.organizations]);
      setHasMore(page.hasMore);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر تحميل المزيد");
    } finally {
      setLoadingMore(false);
    }
  }

  const columns: FinancialColumn<Organization>[] = [
    { key: "name", header: "الشركة", render: (o) => o.name },
    { key: "createdAt", header: "تاريخ الإنشاء", render: (o) => formatDateTime(o.createdAt) },
  ];

  return (
    <PlatformLayout>
      <PageHeader
        title="الشركات"
        subtitle="قائمة الشركات المسجّلة على المنصة (للقراءة فقط)."
        actions={
          <input
            type="search"
            placeholder="البحث باسم الشركة"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="rounded-md border border-stone-300 px-3 py-2 text-sm"
          />
        }
      />

      <FinancialTable
        columns={columns}
        rows={organizations}
        rowKey={(o) => o.id}
        error={error}
        onRetry={() => load(search)}
        emptyMessage={search ? "لا توجد شركات مطابقة للبحث" : "لا توجد شركات بعد"}
        rowActions={(o) => (
          <Button size="sm" variant="secondary" onClick={() => setRequestingFor(o)}>
            طلب وصول دعم
          </Button>
        )}
      />

      {organizations && organizations.length > 0 && hasMore && (
        <div className="mt-3 text-center">
          <Button variant="secondary" size="sm" disabled={loadingMore} onClick={loadMore}>
            {loadingMore ? "جارٍ التحميل..." : "تحميل المزيد"}
          </Button>
        </div>
      )}

      {requestingFor && <RequestAccessModal organization={requestingFor} onClose={() => setRequestingFor(null)} />}
    </PlatformLayout>
  );
}

function RequestAccessModal({ organization, onClose }: { organization: Organization; onClose: () => void }) {
  const navigate = useNavigate();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const session = await createSupportSession(organization.id, reason);
      navigate(`/platform/support-sessions/${session.id}`, { state: { organizationName: organization.name } });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر إنشاء جلسة الدعم");
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/40 px-4" dir="rtl">
      <Card className="w-full max-w-md p-5">
        <h2 className="mb-1 font-semibold text-stone-800">طلب وصول دعم — {organization.name}</h2>
        <p className="mb-4 text-sm text-stone-500">
          الوصول للقراءة فقط، مؤقت (30 دقيقة)، ويُسجَّل في سجل التدقيق باسمك.
        </p>
        <form onSubmit={onSubmit} className="space-y-3">
          {error && <ErrorState message={error} />}
          <textarea
            required
            minLength={3}
            placeholder="سبب طلب الوصول"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
              إلغاء
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? "جارٍ الإنشاء..." : "منح الوصول"}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}
