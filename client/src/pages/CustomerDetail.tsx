import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Layout } from "../components/Layout";
import { PageHeader } from "../ui/PageHeader";
import { Card } from "../ui/Card";
import { Badge } from "../ui/Badge";
import { ErrorState } from "../ui/ErrorState";
import { Skeleton } from "../ui/Skeleton";
import { formatDate } from "../lib/format";
import { getCustomer } from "../api/customers";
import type { CustomerStatus, CustomerWithProjects, ProjectStatus } from "../api/types";
import { useTranslation } from "../i18n/I18nProvider";

const statusTone: Record<CustomerStatus, "success" | "neutral"> = { active: "success", inactive: "neutral" };
const projectStatusTone: Record<ProjectStatus, "success" | "warning" | "neutral"> = {
  active: "success",
  on_hold: "warning",
  completed: "neutral",
};

// MIDAD Phase A' — the "unified customer profile with related projects"
// requirement this domain exists to satisfy. Read-only: project fields
// shown here (id/name/status) come verbatim from GET /customers/:id, never
// recomputed — clicking a project navigates to its own real workspace,
// this page is never a second source of truth for it.
export function CustomerDetail() {
  const { t, locale } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const [customer, setCustomer] = useState<CustomerWithProjects | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    if (!id) return;
    setError(null);
    setCustomer(null);
    getCustomer(id)
      .then(setCustomer)
      .catch((err) => setError(err instanceof Error ? err.message : t("customerDetail.loadError")));
  }
  useEffect(load, [id]);

  if (!id) return null;

  return (
    <Layout>
      <div className="mb-4">
        <Link to="/customers" className="text-sm text-primary hover:underline">
          {t("customerDetail.backToCustomers")}
        </Link>
      </div>

      {error && <ErrorState message={error} onRetry={load} />}
      {!error && !customer && <Skeleton rows={6} />}

      {customer && (
        <>
          <PageHeader
            title={customer.name}
            subtitle={customer.contactName ?? undefined}
            actions={<Badge tone={statusTone[customer.status]}>{t(`customerDetail.status.${customer.status}`)}</Badge>}
          />

          <Card className="mb-6 p-5">
            <dl className="grid grid-cols-1 gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
              <Field label={t("customerDetail.fields.taxId")} value={customer.taxId ?? "—"} />
              <Field label={t("customerDetail.fields.email")} value={customer.email ?? "—"} />
              <Field label={t("customerDetail.fields.phone")} value={customer.phone ?? "—"} />
              <Field label={t("customerDetail.fields.address")} value={customer.address ?? "—"} />
              <Field label={t("customerDetail.fields.addedDate")} value={formatDate(customer.createdAt, locale)} />
            </dl>
            {customer.notes && (
              <div className="mt-4 border-t border-stone-100 pt-4">
                <p className="text-sm text-stone-500">{t("customerDetail.notes")}</p>
                <p className="mt-1 text-sm text-stone-700">{customer.notes}</p>
              </div>
            )}
          </Card>

          <Card className="p-5">
            <h2 className="mb-3 font-semibold text-stone-800">{t("customerDetail.relatedProjects")}</h2>
            {customer.projects.length === 0 ? (
              <p className="text-sm text-stone-500">{t("customerDetail.noProjects")}</p>
            ) : (
              <ul className="divide-y divide-stone-100">
                {customer.projects.map((p) => (
                  <li key={p.id} className="flex items-center justify-between py-2">
                    <Link to={`/projects/${p.id}`} className="text-sm text-primary hover:underline">
                      {p.name}
                    </Link>
                    <Badge tone={projectStatusTone[p.status]}>{t(`dashboard.status.${p.status}`)}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </Layout>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between border-b border-stone-100 pb-2">
      <dt className="text-stone-500">{label}</dt>
      <dd className="font-medium text-stone-800">{value}</dd>
    </div>
  );
}
