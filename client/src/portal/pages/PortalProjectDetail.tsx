import { useEffect, useState } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import { PortalLayout } from "../components/PortalLayout";
import { Card, Badge, ErrorState, Skeleton } from "../../ui";
import { ApiError } from "../../api/client";
import { formatDate } from "../../lib/format";
import { getPortalProject } from "../api/portalProjects";
import { useClientPortalAuth } from "../auth/ClientPortalAuthContext";
import { portalStatusLabel, portalStatusTone } from "../lib/projectStatus";
import type { PortalProject } from "../api/types";

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between border-b border-stone-100 py-2 text-sm last:border-0">
      <dt className="text-stone-500">{label}</dt>
      <dd className="font-medium text-stone-800">{value}</dd>
    </div>
  );
}

// MIDAD Phase B2 — a single authorized project's client-safe summary.
// Server-authorized via requireClientProjectAccess (routes/
// clientPortalProjects.ts's GET /:projectId) — the same 404 an
// unauthorized or nonexistent project already gets is exactly what
// renders here as "unauthorized/not found", never a distinguishable
// error. Only fields the API actually returned are rendered — no
// placeholder rows for budget/forecast/actual cost/cash flow, which do
// not exist in this response at all (see this phase's own scope
// boundary).
export function PortalProjectDetail() {
  const { projectId } = useParams<{ projectId: string }>();
  const { logout } = useClientPortalAuth();
  const navigate = useNavigate();
  const [project, setProject] = useState<PortalProject | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    if (!projectId) return;
    setError(null);
    setNotFound(false);
    setProject(null);
    getPortalProject(projectId)
      .then(setProject)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          logout();
          navigate("/portal/login", { replace: true });
          return;
        }
        if (err instanceof ApiError && err.status === 404) {
          setNotFound(true);
          return;
        }
        setError(err instanceof ApiError ? err.message : "تعذّر تحميل المشروع");
      });
  }
  useEffect(load, [projectId]);

  if (!projectId) return null;

  return (
    <PortalLayout>
      <div className="mb-4">
        <Link to="/portal" className="text-sm text-primary hover:underline">
          العودة إلى مشاريعك
        </Link>
      </div>

      {error && <ErrorState message={error} onRetry={load} />}
      {notFound && <ErrorState message="المشروع غير موجود" />}
      {!error && !notFound && !project && <Skeleton rows={5} />}

      {project && (
        <>
          <h1 className="mb-2 text-xl font-bold text-stone-800">{project.name}</h1>
          <div className="mb-6">
            <Badge tone={portalStatusTone[project.status]}>{portalStatusLabel[project.status]}</Badge>
          </div>

          <Card className="p-5">
            <h2 className="mb-3 font-semibold text-stone-800">معلومات المشروع</h2>
            <dl>
              <Field label="اسم المشروع" value={project.name} />
              {project.clientName && <Field label="العميل" value={project.clientName} />}
              {project.startDate && <Field label="تاريخ البدء" value={formatDate(project.startDate)} />}
              {project.address && <Field label="الموقع" value={project.address} />}
            </dl>
          </Card>
        </>
      )}
    </PortalLayout>
  );
}
