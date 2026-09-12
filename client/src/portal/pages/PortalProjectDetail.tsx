import { useEffect, useState } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import { PortalLayout } from "../components/PortalLayout";
import { Card, Badge, EmptyState, ErrorState, Skeleton } from "../../ui";
import { ApiError } from "../../api/client";
import { formatDate } from "../../lib/format";
import { getPortalProject } from "../api/portalProjects";
import { listPortalDocuments, downloadPortalDocument } from "../api/portalDocuments";
import { useClientPortalAuth } from "../auth/ClientPortalAuthContext";
import { portalStatusLabel, portalStatusTone } from "../lib/projectStatus";
import type { PortalProject, PortalDocument } from "../api/types";
import { useTranslation } from "../../i18n/I18nProvider";

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between border-b border-stone-100 py-2 text-sm last:border-0">
      <dt className="text-stone-500">{label}</dt>
      <dd className="font-medium text-stone-800">{value}</dd>
    </div>
  );
}

// MIDAD Phase B3 — the client-facing Documents section. Every document
// rendered here already passed all four server-side conditions
// (authenticated + active grant + belongs to this project + clientVisible
// = true) — this component filters nothing itself, it only displays what
// the server already decided to return. Its own load/download failures are
// two independent error states (list failure vs. one download failure)
// so a broken download never blanks out an otherwise-working list.
function PortalDocumentsSection({ projectId }: { projectId: string }) {
  const { t, locale } = useTranslation();
  const { logout } = useClientPortalAuth();
  const navigate = useNavigate();
  const [documents, setDocuments] = useState<PortalDocument[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  function load() {
    setError(null);
    setDocuments(null);
    listPortalDocuments(projectId)
      .then(setDocuments)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          logout();
          navigate("/portal/login", { replace: true });
          return;
        }
        setError(err instanceof ApiError ? err.message : t("portalProjectDetailPage.documents.loadError"));
      });
  }
  useEffect(load, [projectId]);

  async function onDownload(doc: PortalDocument) {
    setDownloadError(null);
    try {
      await downloadPortalDocument(t, projectId, doc.id, doc.fileName);
    } catch (err) {
      setDownloadError(err instanceof ApiError ? err.message : t("quotesPage.actions.downloadError"));
    }
  }

  return (
    <Card className="mt-6 p-5">
      <h2 className="mb-3 font-semibold text-stone-800">{t("portalProjectDetailPage.documents.heading")}</h2>

      {error && <ErrorState message={error} onRetry={load} />}
      {!error && !documents && <Skeleton rows={3} />}
      {!error && documents && documents.length === 0 && <EmptyState message={t("portalProjectDetailPage.documents.emptyMessage")} />}
      {!error && documents && documents.length > 0 && (
        <div className="space-y-3">
          {documents.map((doc) => (
            <div key={doc.id} className="flex items-center justify-between rounded-lg border border-stone-200 p-3">
              <div>
                <p className="text-sm font-medium text-stone-800">{doc.fileName}</p>
                <p className="text-xs text-stone-500">{formatDate(doc.uploadedAt, locale)}</p>
              </div>
              <button type="button" onClick={() => onDownload(doc)} className="text-sm text-primary hover:underline">
                {t("portalProjectDetailPage.documents.viewDownload")}
              </button>
            </div>
          ))}
        </div>
      )}
      {downloadError && (
        <div className="mt-3">
          <ErrorState message={downloadError} />
        </div>
      )}
    </Card>
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
  const { t, locale } = useTranslation();
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
        setError(err instanceof ApiError ? err.message : t("portalProjectDetailPage.loadError"));
      });
  }
  useEffect(load, [projectId]);

  if (!projectId) return null;

  return (
    <PortalLayout>
      <div className="mb-4">
        <Link to="/portal" className="text-sm text-primary hover:underline">
          {t("portalProjectDetailPage.backToProjects")}
        </Link>
      </div>

      {error && <ErrorState message={error} onRetry={load} />}
      {notFound && <ErrorState message={t("portalProjectDetailPage.notFound")} />}
      {!error && !notFound && !project && <Skeleton rows={5} />}

      {project && (
        <>
          <h1 className="mb-2 text-xl font-bold text-stone-800">{project.name}</h1>
          <div className="mb-6">
            <Badge tone={portalStatusTone[project.status]}>{portalStatusLabel(t, project.status)}</Badge>
          </div>

          <Card className="p-5">
            <h2 className="mb-3 font-semibold text-stone-800">{t("portalProjectDetailPage.projectInfoHeading")}</h2>
            <dl>
              <Field label={t("portalProjectDetailPage.fields.projectName")} value={project.name} />
              {project.clientName && <Field label={t("portalProjectDetailPage.fields.client")} value={project.clientName} />}
              {project.startDate && <Field label={t("portalProjectDetailPage.fields.startDate")} value={formatDate(project.startDate, locale)} />}
              {project.address && <Field label={t("portalProjectDetailPage.fields.location")} value={project.address} />}
            </dl>
          </Card>

          <PortalDocumentsSection projectId={project.id} />
        </>
      )}
    </PortalLayout>
  );
}
