import { useEffect, useState, type FormEvent } from "react";
import { PlatformLayout } from "../components/PlatformLayout";
import { PageHeader, Card, Badge, Button, ErrorState, Skeleton, EmptyState, Modal } from "../../ui";
import { ApiError } from "../../api/client";
import { formatDateTime } from "../../lib/format";
import { listIncidents, createIncident, updateIncidentStatus } from "../api/incidents";
import type { Incident, IncidentSeverity, IncidentStatus } from "../api/types";
import { useTranslation } from "../../i18n/I18nProvider";

// MIDAD Final Pre-Launch audit, Phase 22 (UX) — Phase 13's Incident Center
// (server/src/routes/platformIncidents.ts). Manual create/track/resolve
// only, matching the backend's deliberate scope boundary — no automatic
// error->incident pipeline exists to surface here.
const severityTone: Record<IncidentSeverity, "neutral" | "warning" | "danger"> = {
  low: "neutral",
  medium: "warning",
  high: "warning",
  critical: "danger",
};

const statusTone: Record<IncidentStatus, "danger" | "warning" | "success"> = {
  open: "danger",
  investigating: "warning",
  resolved: "success",
};

export function PlatformIncidents() {
  const { t, locale } = useTranslation();
  const [statusFilter, setStatusFilter] = useState<IncidentStatus | "">("");
  const [incidents, setIncidents] = useState<Incident[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState<Incident | null>(null);

  function load() {
    setIncidents(null);
    setError(null);
    listIncidents(statusFilter ? { status: statusFilter } : {})
      .then(setIncidents)
      .catch((err) => setError(err instanceof ApiError ? err.message : t("platformIncidentsPage.loadError")));
  }

  useEffect(load, [statusFilter]);

  return (
    <PlatformLayout>
      <PageHeader
        title={t("platformIncidentsPage.title")}
        subtitle={t("platformIncidentsPage.subtitle")}
        actions={
          <div className="flex items-center gap-2">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as IncidentStatus | "")}
              className="rounded-md border border-stone-300 px-3 py-2 text-sm"
            >
              <option value="">{t("platformIncidentsPage.allStatuses")}</option>
              <option value="open">{t("platformIncidentsPage.status.open")}</option>
              <option value="investigating">{t("platformIncidentsPage.status.investigating")}</option>
              <option value="resolved">{t("platformIncidentsPage.status.resolved")}</option>
            </select>
            <Button size="sm" onClick={() => setCreating(true)}>
              {t("platformIncidentsPage.createIncident")}
            </Button>
          </div>
        }
      />

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : !incidents ? (
        <Skeleton rows={4} />
      ) : incidents.length === 0 ? (
        <EmptyState message={t("platformIncidentsPage.emptyMessage")} />
      ) : (
        <Card className="divide-y divide-stone-100">
          {incidents.map((incident) => (
            <button
              key={incident.id}
              onClick={() => setDetail(incident)}
              className="flex w-full flex-wrap items-center justify-between gap-2 px-4 py-3 text-start text-sm hover:bg-stone-50"
            >
              <div className="min-w-0">
                <p className="font-medium text-stone-800">{incident.title}</p>
                <p className="text-xs text-stone-500">{incident.affectedService}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-stone-400">{formatDateTime(incident.createdAt, locale)}</span>
                <Badge tone={severityTone[incident.severity]}>{t(`platformIncidentsPage.severity.${incident.severity}`)}</Badge>
                <Badge tone={statusTone[incident.status]}>{t(`platformIncidentsPage.status.${incident.status}`)}</Badge>
              </div>
            </button>
          ))}
        </Card>
      )}

      {creating && <CreateIncidentModal onClose={() => setCreating(false)} onCreated={() => { setCreating(false); load(); }} />}
      {detail && <IncidentDetailModal incident={detail} onClose={() => setDetail(null)} onUpdated={() => { setDetail(null); load(); }} />}
    </PlatformLayout>
  );
}

function CreateIncidentModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { t } = useTranslation();
  const [companyId, setCompanyId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState<IncidentSeverity>("medium");
  const [affectedService, setAffectedService] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await createIncident({ companyId: companyId.trim() || null, title, description, severity, affectedService });
      onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("common.errorGeneric"));
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={t("platformIncidentsPage.createIncident")}>
      <form onSubmit={onSubmit} className="space-y-3">
        {error && <ErrorState message={error} />}
        <input
          required
          minLength={3}
          placeholder={t("platformIncidentsPage.form.title")}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <textarea
          required
          minLength={3}
          placeholder={t("platformIncidentsPage.form.description")}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <input
          required
          placeholder={t("platformIncidentsPage.form.affectedService")}
          value={affectedService}
          onChange={(e) => setAffectedService(e.target.value)}
          className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <select value={severity} onChange={(e) => setSeverity(e.target.value as IncidentSeverity)} className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm">
          <option value="low">{t("platformIncidentsPage.severity.low")}</option>
          <option value="medium">{t("platformIncidentsPage.severity.medium")}</option>
          <option value="high">{t("platformIncidentsPage.severity.high")}</option>
          <option value="critical">{t("platformIncidentsPage.severity.critical")}</option>
        </select>
        <input
          placeholder={t("platformIncidentsPage.form.companyIdOptional")}
          value={companyId}
          onChange={(e) => setCompanyId(e.target.value)}
          className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" size="sm" disabled={busy}>
            {busy ? t("common.saving") : t("common.create")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function IncidentDetailModal({ incident, onClose, onUpdated }: { incident: Incident; onClose: () => void; onUpdated: () => void }) {
  const { t, locale } = useTranslation();
  const [resolutionNotes, setResolutionNotes] = useState(incident.resolutionNotes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSetStatus(status: IncidentStatus) {
    setBusy(true);
    setError(null);
    try {
      await updateIncidentStatus(incident.id, status, status === "resolved" ? resolutionNotes : undefined);
      onUpdated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("common.errorGeneric"));
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={incident.title}>
      <div className="space-y-3 text-sm">
        {error && <ErrorState message={error} />}
        <p className="text-stone-600">{incident.description}</p>
        <p className="text-xs text-stone-400">
          {t("platformIncidentsPage.detail.affectedService")}: {incident.affectedService} · {formatDateTime(incident.createdAt, locale)}
        </p>
        {incident.status !== "resolved" && (
          <textarea
            placeholder={t("platformIncidentsPage.detail.resolutionNotesPlaceholder")}
            value={resolutionNotes}
            onChange={(e) => setResolutionNotes(e.target.value)}
            rows={2}
            className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
          />
        )}
        {incident.resolutionNotes && <p className="rounded-md bg-stone-50 p-2 text-xs text-stone-600">{incident.resolutionNotes}</p>}
        <div className="flex flex-wrap justify-end gap-2">
          {incident.status !== "investigating" && incident.status !== "resolved" && (
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => onSetStatus("investigating")}>
              {t("platformIncidentsPage.detail.markInvestigating")}
            </Button>
          )}
          {incident.status !== "resolved" && (
            <Button size="sm" disabled={busy} onClick={() => onSetStatus("resolved")}>
              {t("platformIncidentsPage.detail.markResolved")}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
