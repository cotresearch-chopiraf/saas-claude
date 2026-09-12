import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { PortalLayout } from "../components/PortalLayout";
import { Card, Badge, EmptyState, ErrorState, Skeleton } from "../../ui";
import { ApiError } from "../../api/client";
import { formatDate } from "../../lib/format";
import { listPortalProjects } from "../api/portalProjects";
import { useClientPortalAuth } from "../auth/ClientPortalAuthContext";
import { portalStatusLabel, portalStatusTone } from "../lib/projectStatus";
import type { PortalProject } from "../api/types";
import { useTranslation } from "../../i18n/I18nProvider";

// MIDAD Phase B2 — Client Portal Dashboard: the project list a Client
// Portal User currently has an active, explicit grant for (see
// server/src/routes/clientPortalProjects.ts's own GET / — access is never
// inferred from customerId/email/naming, only from client_project_access
// rows the server already resolved). No progress percentage, no
// financial figure, no chart — exactly the fields the API returns.
export function PortalDashboard() {
  const { t, locale } = useTranslation();
  const { portalUser, logout } = useClientPortalAuth();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<PortalProject[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setError(null);
    setProjects(null);
    listPortalProjects()
      .then(setProjects)
      .catch((err) => {
        // A revoked session or a disabled account is rejected by
        // clientPortalAuth on this very request (401) — the UI must react
        // by ending the local session immediately, not by showing a raw
        // error the client can't act on. Any other failure (network,
        // 500, rate limit) is a failed *check*, not proof of an invalid
        // session — see auth/AuthContext.tsx's identical 401-only
        // classification for the tenant app.
        if (err instanceof ApiError && err.status === 401) {
          logout();
          navigate("/portal/login", { replace: true });
          return;
        }
        setError(err instanceof ApiError ? err.message : t("portalDashboardPage.loadError"));
      });
  }
  useEffect(load, []);

  return (
    <PortalLayout>
      <p className="mb-1 text-sm text-stone-500">{t("portalDashboardPage.greeting")}</p>
      <h1 className="mb-6 text-xl font-bold text-stone-800">{portalUser?.name}</h1>

      <h2 className="mb-3 font-semibold text-stone-800">{t("portalDashboardPage.yourProjects")}</h2>

      {error && <ErrorState message={error} onRetry={load} />}
      {!error && !projects && <Skeleton rows={3} />}
      {!error && projects && projects.length === 0 && (
        <EmptyState message={t("portalDashboardPage.emptyMessage")} />
      )}
      {!error && projects && projects.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {projects.map((project) => (
            <Link key={project.id} to={`/portal/projects/${project.id}`} className="block">
              <Card className="h-full p-5 transition-shadow hover:shadow-md">
                <h3 className="mb-2 font-semibold text-stone-800">{project.name}</h3>
                <div className="mb-3">
                  <Badge tone={portalStatusTone[project.status]}>{portalStatusLabel(t, project.status)}</Badge>
                </div>
                {project.startDate && <p className="text-sm text-stone-500">{t("portalDashboardPage.startDate", { date: formatDate(project.startDate, locale) })}</p>}
                <p className="mt-3 text-sm text-primary">{t("portalDashboardPage.viewProject")}</p>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </PortalLayout>
  );
}
