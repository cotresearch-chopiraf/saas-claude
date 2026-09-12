import { useEffect, useState, type FormEvent } from "react";
import { Layout } from "../components/Layout";
import { PageHeader } from "../ui/PageHeader";
import { Card } from "../ui/Card";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Tabs } from "../ui/Tabs";
import { Skeleton } from "../ui/Skeleton";
import { EmptyState } from "../ui/EmptyState";
import { ErrorState } from "../ui/ErrorState";
import { Can } from "../auth/Can";
import { ApiError } from "../api/client";
import { formatDate } from "../lib/format";
import {
  getComplianceDashboard,
  listCompliancePeriods,
  createCompliancePeriod,
  listComplianceSnapshots,
  createComplianceSnapshot,
  listNitaqatRecords,
  createNitaqatRecord,
  updateNitaqatRecord,
  verifyNitaqatRecord,
  listNitaqatEvidence,
  uploadNitaqatEvidence,
  downloadNitaqatEvidence,
  listGosiRecords,
  createGosiRecord,
  updateGosiRecord,
  verifyGosiRecord,
  listGosiEvidence,
  uploadGosiEvidence,
  downloadGosiEvidence,
  listComplianceExceptions,
  createComplianceException,
  resolveComplianceException,
  closeComplianceException,
} from "../api/workforceCompliance";
import type {
  ComplianceDashboard,
  CompliancePeriod,
  ComplianceWorkforceSnapshot,
  NitaqatComplianceRecord,
  GosiComplianceRecord,
  ComplianceException,
  ComplianceEvidence,
  ComplianceSourceType,
  ComplianceVerificationStatus,
  GosiStatus,
  ComplianceExceptionSeverity,
  ComplianceExceptionStatus,
} from "../api/types";
import { useTranslation } from "../i18n/I18nProvider";

// MIDAD Phase D1 — Nitaqat + GOSI Compliance Tracking Foundation.
//
// NO OFFICIAL GOVERNMENT INTEGRATION: this page never calls Qiwa, Nitaqat,
// or GOSI. Every figure shown is either a company-entered record or a
// company-reported reference the company itself asserts — the UI's whole
// job is to make that distinction impossible to miss (see sourceTypeLabel/
// verificationStatusLabel below, and the explicit "لم يتم التحقق منها
// رسمياً" caption on every unverified badge). There is no compliance
// score, no percentage, no green/red "compliant" verdict anywhere on this
// page — see this phase's own explicit "no fake compliance metric" rule.
export function LaborCompliance() {
  const { t } = useTranslation();
  const [dashboard, setDashboard] = useState<ComplianceDashboard | null>(null);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"periods" | "nitaqat" | "gosi" | "exceptions">("nitaqat");

  function loadDashboard() {
    setDashboardError(null);
    setDashboard(null);
    getComplianceDashboard()
      .then(setDashboard)
      .catch((err) => setDashboardError(err instanceof ApiError ? err.message : t("laborCompliancePage.loadError")));
  }
  useEffect(loadDashboard, []);

  return (
    <Layout>
      <PageHeader title={t("laborCompliancePage.title")} subtitle={t("laborCompliancePage.subtitle")} />

      <div className="mb-6">
        {dashboardError && <ErrorState message={dashboardError} onRetry={loadDashboard} />}
        {!dashboardError && !dashboard && <Skeleton rows={3} />}
        {!dashboardError && dashboard && <DashboardCard dashboard={dashboard} />}
      </div>

      <Tabs
        items={[
          { key: "nitaqat", label: t("laborCompliancePage.tabs.nitaqat") },
          { key: "gosi", label: t("laborCompliancePage.tabs.gosi") },
          { key: "exceptions", label: t("laborCompliancePage.tabs.exceptions") },
          { key: "periods", label: t("laborCompliancePage.tabs.periods") },
        ]}
        active={activeTab}
        onChange={(key) => setActiveTab(key as typeof activeTab)}
      />

      <div className="mt-5">
        {activeTab === "periods" && <PeriodsTab onChanged={loadDashboard} />}
        {activeTab === "nitaqat" && <NitaqatTab onChanged={loadDashboard} />}
        {activeTab === "gosi" && <GosiTab onChanged={loadDashboard} />}
        {activeTab === "exceptions" && <ExceptionsTab onChanged={loadDashboard} />}
      </div>
    </Layout>
  );
}

const verificationStatusTone: Record<ComplianceVerificationStatus, "neutral" | "warning" | "success"> = {
  unverified: "neutral",
  pending_verification: "warning",
  verified: "success",
};

// pending_verification/verified are shared with ComplianceVerificationStatus and
// reuse those translation keys; only not_recorded/recorded/exception are GOSI-specific.
function gosiStatusLabel(t: (key: string) => string, status: GosiStatus): string {
  if (status === "pending_verification" || status === "verified") {
    return t(`laborCompliancePage.verificationStatus.${status}`);
  }
  return t(`laborCompliancePage.gosiStatus.${status}`);
}

function DashboardCard({ dashboard }: { dashboard: ComplianceDashboard }) {
  const { t, locale } = useTranslation();
  return (
    <Card className="p-5">
      <h2 className="mb-4 font-semibold text-stone-800">{t("laborCompliancePage.dashboard.heading")}</h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <p className="mb-1 text-xs font-semibold text-stone-500">{t("laborCompliancePage.tabs.nitaqat")}</p>
          {dashboard.nitaqat ? (
            <>
              <Badge tone={verificationStatusTone[dashboard.nitaqat.verificationStatus]}>{t(`laborCompliancePage.verificationStatus.${dashboard.nitaqat.verificationStatus}`)}</Badge>
              <p className="mt-1 text-xs text-stone-500">{t("laborCompliancePage.sourceLabel", { source: t(`laborCompliancePage.sourceType.${dashboard.nitaqat.sourceType}`) })}</p>
              <p className="text-xs text-stone-400">{t("laborCompliancePage.dashboard.lastUpdated", { date: formatDate(dashboard.nitaqat.updatedAt, locale) })}</p>
            </>
          ) : (
            <p className="text-sm text-stone-400">{t("laborCompliancePage.dashboard.noRecordYet")}</p>
          )}
        </div>
        <div>
          <p className="mb-1 text-xs font-semibold text-stone-500">{t("laborCompliancePage.tabs.gosi")}</p>
          {dashboard.gosi ? (
            <>
              <Badge tone={verificationStatusTone[dashboard.gosi.verificationStatus]}>{t(`laborCompliancePage.verificationStatus.${dashboard.gosi.verificationStatus}`)}</Badge>
              <p className="mt-1 text-xs text-stone-500">{t("laborCompliancePage.sourceLabel", { source: t(`laborCompliancePage.sourceType.${dashboard.gosi.sourceType}`) })}</p>
              <p className="text-xs text-stone-400">{t("laborCompliancePage.dashboard.lastUpdated", { date: formatDate(dashboard.gosi.updatedAt, locale) })}</p>
            </>
          ) : (
            <p className="text-sm text-stone-400">{t("laborCompliancePage.dashboard.noRecordYet")}</p>
          )}
        </div>
        <div>
          <p className="mb-1 text-xs font-semibold text-stone-500">{t("laborCompliancePage.tabs.exceptions")}</p>
          <p className="text-sm text-stone-700">{t("laborCompliancePage.dashboard.openCount", { count: dashboard.exceptions.open })}</p>
          {dashboard.exceptions.highOrCritical > 0 && <p className="text-sm text-danger-600">{t("laborCompliancePage.dashboard.highPriorityCount", { count: dashboard.exceptions.highOrCritical })}</p>}
        </div>
      </div>
    </Card>
  );
}

// --- Periods ---
function PeriodsTab({ onChanged }: { onChanged: () => void }) {
  const { t, locale } = useTranslation();
  const [periods, setPeriods] = useState<CompliancePeriod[] | null>(null);
  const [snapshots, setSnapshots] = useState<ComplianceWorkforceSnapshot[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreatePeriod, setShowCreatePeriod] = useState(false);
  const [showCreateSnapshot, setShowCreateSnapshot] = useState(false);

  function load() {
    setError(null);
    Promise.all([listCompliancePeriods(), listComplianceSnapshots()])
      .then(([p, s]) => {
        setPeriods(p);
        setSnapshots(s);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : t("laborCompliancePage.periods.loadError")));
  }
  useEffect(load, []);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (periods === null || snapshots === null) return <Skeleton rows={3} />;

  return (
    <div className="space-y-6">
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold text-stone-800">{t("laborCompliancePage.periods.heading")}</h3>
          <Can permission="laborCompliance.manage">
            <Button size="sm" onClick={() => setShowCreatePeriod((v) => !v)}>
              {showCreatePeriod ? t("common.cancel") : t("laborCompliancePage.periods.newPeriod")}
            </Button>
          </Can>
        </div>
        {showCreatePeriod && (
          <PeriodForm
            onSaved={() => {
              setShowCreatePeriod(false);
              load();
            }}
            onCancel={() => setShowCreatePeriod(false)}
          />
        )}
        {periods.length === 0 ? (
          <EmptyState message={t("laborCompliancePage.periods.emptyMessage")} />
        ) : (
          <ul className="space-y-1">
            {periods.map((p) => (
              <li key={p.id} className="flex items-center justify-between rounded-md border border-stone-100 px-3 py-2 text-sm">
                <span>{p.label ?? `${formatDate(p.periodStart, locale)} — ${formatDate(p.periodEnd, locale)}`}</span>
                <Badge tone={p.status === "open" ? "success" : "neutral"}>{t(`laborCompliancePage.periods.status.${p.status}`)}</Badge>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold text-stone-800">{t("laborCompliancePage.periods.snapshotsHeading")}</h3>
          <Can permission="laborCompliance.manage">
            <Button size="sm" onClick={() => setShowCreateSnapshot((v) => !v)} disabled={periods.length === 0}>
              {showCreateSnapshot ? t("common.cancel") : t("laborCompliancePage.periods.newSnapshot")}
            </Button>
          </Can>
        </div>
        {showCreateSnapshot && (
          <SnapshotForm
            periods={periods}
            onSaved={() => {
              setShowCreateSnapshot(false);
              load();
            }}
            onCancel={() => setShowCreateSnapshot(false)}
          />
        )}
        {snapshots.length === 0 ? (
          <EmptyState message={t("laborCompliancePage.periods.snapshotsEmptyMessage")} />
        ) : (
          <ul className="space-y-1">
            {snapshots.map((s) => (
              <li key={s.id} className="rounded-md border border-stone-100 px-3 py-2 text-sm">
                <div className="flex items-center justify-between">
                  <span>{t("laborCompliancePage.periods.snapshotSummary", { date: formatDate(s.snapshotDate, locale), total: s.totalEmployees, saudi: s.saudiEmployees, nonSaudi: s.nonSaudiEmployees })}</span>
                  <Badge tone={verificationStatusTone[s.verificationStatus]}>{t(`laborCompliancePage.verificationStatus.${s.verificationStatus}`)}</Badge>
                </div>
                <p className="mt-1 text-xs text-stone-500">{t("laborCompliancePage.sourceLabel", { source: t(`laborCompliancePage.sourceType.${s.sourceType}`) })}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function PeriodForm({ onSaved, onCancel }: { onSaved: () => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await createCompliancePeriod({ periodStart, periodEnd, label: label || undefined });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("laborCompliancePage.periods.form.genericError"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="mb-3 p-4">
      <form onSubmit={onSubmit} className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        {error && (
          <div className="sm:col-span-4">
            <ErrorState message={error} />
          </div>
        )}
        <input placeholder={t("laborCompliancePage.periods.form.labelPlaceholder")} value={label} onChange={(e) => setLabel(e.target.value)} className="rounded-md border border-stone-300 px-3 py-2 text-sm sm:col-span-2" />
        <input required type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} className="rounded-md border border-stone-300 px-3 py-2 text-sm" />
        <input required type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} className="rounded-md border border-stone-300 px-3 py-2 text-sm" />
        <div className="flex gap-2 sm:col-span-4">
          <Button type="submit" size="sm" disabled={submitting}>{t("common.save")}</Button>
          <Button type="button" variant="secondary" size="sm" onClick={onCancel}>{t("common.cancel")}</Button>
        </div>
      </form>
    </Card>
  );
}

function SnapshotForm({ periods, onSaved, onCancel }: { periods: CompliancePeriod[]; onSaved: () => void; onCancel: () => void }) {
  const { t, locale } = useTranslation();
  const [compliancePeriodId, setCompliancePeriodId] = useState(periods[0]?.id ?? "");
  const [snapshotDate, setSnapshotDate] = useState("");
  const [totalEmployees, setTotalEmployees] = useState("");
  const [saudiEmployees, setSaudiEmployees] = useState("");
  const [nonSaudiEmployees, setNonSaudiEmployees] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await createComplianceSnapshot({
        compliancePeriodId,
        snapshotDate,
        totalEmployees: Number(totalEmployees),
        saudiEmployees: Number(saudiEmployees),
        nonSaudiEmployees: Number(nonSaudiEmployees),
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("laborCompliancePage.periods.snapshotForm.genericError"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="mb-3 p-4">
      <form onSubmit={onSubmit} className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        {error && (
          <div className="sm:col-span-4">
            <ErrorState message={error} />
          </div>
        )}
        <select required value={compliancePeriodId} onChange={(e) => setCompliancePeriodId(e.target.value)} className="rounded-md border border-stone-300 px-3 py-2 text-sm">
          {periods.map((p) => (
            <option key={p.id} value={p.id}>{p.label ?? formatDate(p.periodStart, locale)}</option>
          ))}
        </select>
        <input required type="date" value={snapshotDate} onChange={(e) => setSnapshotDate(e.target.value)} className="rounded-md border border-stone-300 px-3 py-2 text-sm" />
        <input required type="number" min="0" placeholder={t("laborCompliancePage.periods.snapshotForm.totalPlaceholder")} value={totalEmployees} onChange={(e) => setTotalEmployees(e.target.value)} className="rounded-md border border-stone-300 px-3 py-2 text-sm" />
        <input required type="number" min="0" placeholder={t("laborCompliancePage.periods.snapshotForm.saudiPlaceholder")} value={saudiEmployees} onChange={(e) => setSaudiEmployees(e.target.value)} className="rounded-md border border-stone-300 px-3 py-2 text-sm" />
        <input required type="number" min="0" placeholder={t("laborCompliancePage.periods.snapshotForm.nonSaudiPlaceholder")} value={nonSaudiEmployees} onChange={(e) => setNonSaudiEmployees(e.target.value)} className="rounded-md border border-stone-300 px-3 py-2 text-sm" />
        <div className="flex gap-2 sm:col-span-4">
          <Button type="submit" size="sm" disabled={submitting}>{t("common.save")}</Button>
          <Button type="button" variant="secondary" size="sm" onClick={onCancel}>{t("common.cancel")}</Button>
        </div>
      </form>
    </Card>
  );
}

// --- Nitaqat ---
function NitaqatTab({ onChanged }: { onChanged: () => void }) {
  const { t } = useTranslation();
  const [records, setRecords] = useState<NitaqatComplianceRecord[] | null>(null);
  const [periods, setPeriods] = useState<CompliancePeriod[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  function load() {
    setError(null);
    Promise.all([listNitaqatRecords(), listCompliancePeriods()])
      .then(([r, p]) => {
        setRecords(r);
        setPeriods(p);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : t("laborCompliancePage.nitaqat.loadError")));
  }
  useEffect(load, []);

  const selected = records?.find((r) => r.id === selectedId) ?? null;

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (records === null || periods === null) return <Skeleton rows={3} />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-stone-800">{t("laborCompliancePage.nitaqat.heading")}</h3>
        <Can permission="laborCompliance.manage">
          <Button size="sm" onClick={() => setShowCreate((v) => !v)} disabled={periods.length === 0}>
            {showCreate ? t("common.cancel") : t("laborCompliancePage.nitaqat.newRecord")}
          </Button>
        </Can>
      </div>
      {periods.length === 0 && <p className="text-xs text-stone-500">{t("laborCompliancePage.needsPeriodHint")}</p>}
      {showCreate && (
        <NitaqatForm
          periods={periods}
          onSaved={() => {
            setShowCreate(false);
            load();
            onChanged();
          }}
          onCancel={() => setShowCreate(false)}
        />
      )}

      {records.length === 0 ? (
        <EmptyState message={t("laborCompliancePage.nitaqat.emptyMessage")} />
      ) : (
        <ul className="space-y-1">
          {records.map((r) => (
            <li key={r.id} className="cursor-pointer rounded-md border border-stone-100 px-3 py-2 text-sm hover:bg-stone-50" onClick={() => setSelectedId(r.id)}>
              <div className="flex items-center justify-between">
                <span>{t("laborCompliancePage.nitaqat.rowSummary", { classification: r.classification ?? t("laborCompliancePage.nitaqat.noClassification"), total: r.totalCount, saudi: r.saudiCount })}</span>
                <Badge tone={verificationStatusTone[r.verificationStatus]}>{t(`laborCompliancePage.verificationStatus.${r.verificationStatus}`)}</Badge>
              </div>
              <p className="mt-1 text-xs text-stone-500">{t("laborCompliancePage.sourceLabel", { source: t(`laborCompliancePage.sourceType.${r.sourceType}`) })}</p>
            </li>
          ))}
        </ul>
      )}

      {selected && (
        <NitaqatDetail
          record={selected}
          onChanged={() => {
            load();
            onChanged();
          }}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

function NitaqatForm({ periods, onSaved, onCancel }: { periods: CompliancePeriod[]; onSaved: () => void; onCancel: () => void }) {
  const { t, locale } = useTranslation();
  const [compliancePeriodId, setCompliancePeriodId] = useState(periods[0]?.id ?? "");
  const [classification, setClassification] = useState("");
  const [saudiCount, setSaudiCount] = useState("");
  const [nonSaudiCount, setNonSaudiCount] = useState("");
  const [totalCount, setTotalCount] = useState("");
  const [externalReference, setExternalReference] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await createNitaqatRecord({
        compliancePeriodId,
        classification: classification || undefined,
        saudiCount: Number(saudiCount),
        nonSaudiCount: Number(nonSaudiCount),
        totalCount: Number(totalCount),
        externalReference: externalReference || undefined,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("laborCompliancePage.recordForm.genericError"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="p-4">
      <form onSubmit={onSubmit} className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {error && (
          <div className="sm:col-span-3">
            <ErrorState message={error} />
          </div>
        )}
        <p className="text-xs text-stone-500 sm:col-span-3">{t("laborCompliancePage.nitaqat.form.classificationHint")}</p>
        <select required value={compliancePeriodId} onChange={(e) => setCompliancePeriodId(e.target.value)} className="rounded-md border border-stone-300 px-3 py-2 text-sm">
          {periods.map((p) => (
            <option key={p.id} value={p.id}>{p.label ?? formatDate(p.periodStart, locale)}</option>
          ))}
        </select>
        <input placeholder={t("laborCompliancePage.nitaqat.form.classificationPlaceholder")} value={classification} onChange={(e) => setClassification(e.target.value)} className="rounded-md border border-stone-300 px-3 py-2 text-sm sm:col-span-2" />
        <input required type="number" min="0" placeholder={t("laborCompliancePage.nitaqat.form.saudiPlaceholder")} value={saudiCount} onChange={(e) => setSaudiCount(e.target.value)} className="rounded-md border border-stone-300 px-3 py-2 text-sm" />
        <input required type="number" min="0" placeholder={t("laborCompliancePage.nitaqat.form.nonSaudiPlaceholder")} value={nonSaudiCount} onChange={(e) => setNonSaudiCount(e.target.value)} className="rounded-md border border-stone-300 px-3 py-2 text-sm" />
        <input required type="number" min="0" placeholder={t("laborCompliancePage.nitaqat.form.totalPlaceholder")} value={totalCount} onChange={(e) => setTotalCount(e.target.value)} className="rounded-md border border-stone-300 px-3 py-2 text-sm" />
        <input placeholder={t("laborCompliancePage.recordForm.externalReferencePlaceholder")} value={externalReference} onChange={(e) => setExternalReference(e.target.value)} className="rounded-md border border-stone-300 px-3 py-2 text-sm sm:col-span-3" />
        <div className="flex gap-2 sm:col-span-3">
          <Button type="submit" size="sm" disabled={submitting}>{t("common.save")}</Button>
          <Button type="button" variant="secondary" size="sm" onClick={onCancel}>{t("common.cancel")}</Button>
        </div>
      </form>
    </Card>
  );
}

function NitaqatDetail({ record, onChanged, onClose }: { record: NitaqatComplianceRecord; onChanged: () => void; onClose: () => void }) {
  const { t } = useTranslation();
  const [evidence, setEvidence] = useState<ComplianceEvidence[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function loadEvidence() {
    listNitaqatEvidence(record.id).then(setEvidence).catch(() => setEvidence([]));
  }
  useEffect(loadEvidence, [record.id]);

  async function onVerify() {
    setError(null);
    setSubmitting(true);
    try {
      await verifyNitaqatRecord(record.id);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("laborCompliancePage.detail.verifyError"));
    } finally {
      setSubmitting(false);
    }
  }

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    try {
      await uploadNitaqatEvidence(record.id, file);
      loadEvidence();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("laborCompliancePage.detail.uploadError"));
    }
  }

  return (
    <Card className="p-5">
      <div className="mb-3 flex items-start justify-between">
        <div>
          <h3 className="font-semibold text-stone-800">{record.classification ?? t("laborCompliancePage.nitaqat.defaultTitle")}</h3>
          <Badge tone={verificationStatusTone[record.verificationStatus]}>{t(`laborCompliancePage.verificationStatus.${record.verificationStatus}`)}</Badge>
        </div>
        <button type="button" onClick={onClose} className="text-stone-400 hover:text-stone-600" aria-label={t("laborCompliancePage.detail.closeAriaLabel")}>✕</button>
      </div>

      {error && (
        <div className="mb-3">
          <ErrorState message={error} />
        </div>
      )}

      <dl className="mb-4 text-sm">
        <div className="flex justify-between border-b border-stone-100 py-1.5"><dt className="text-stone-500">{t("laborCompliancePage.detail.fields.source")}</dt><dd>{t(`laborCompliancePage.sourceType.${record.sourceType}`)}</dd></div>
        <div className="flex justify-between border-b border-stone-100 py-1.5"><dt className="text-stone-500">{t("laborCompliancePage.detail.fields.externalReference")}</dt><dd>{record.externalReference ?? "—"}</dd></div>
        <div className="flex justify-between py-1.5"><dt className="text-stone-500">{t("laborCompliancePage.detail.fields.notes")}</dt><dd>{record.notes ?? "—"}</dd></div>
      </dl>

      <div className="mb-4">
        <p className="mb-2 text-xs font-semibold text-stone-500">{t("laborCompliancePage.detail.evidenceHeading")}</p>
        {evidence === null && <p className="text-xs text-stone-400">{t("common.loading")}</p>}
        {evidence && evidence.length === 0 && <p className="text-xs text-stone-400">{t("laborCompliancePage.detail.noEvidence")}</p>}
        {evidence && evidence.length > 0 && (
          <ul className="space-y-1">
            {evidence.map((f) => (
              <li key={f.id} className="flex items-center justify-between text-xs">
                <span>{f.fileName}</span>
                <button type="button" onClick={() => downloadNitaqatEvidence(record.id, f.id, f.fileName)} className="text-primary hover:underline">{t("laborCompliancePage.detail.download")}</button>
              </li>
            ))}
          </ul>
        )}
        <Can permission="laborCompliance.manage">
          <input type="file" onChange={onUpload} className="mt-2 text-xs" />
        </Can>
      </div>

      {record.verificationStatus !== "verified" && (
        <Can permission="laborCompliance.verify">
          <Button size="sm" disabled={submitting} onClick={onVerify}>{t("laborCompliancePage.detail.verify")}</Button>
        </Can>
      )}
    </Card>
  );
}

// --- GOSI ---
function GosiTab({ onChanged }: { onChanged: () => void }) {
  const { t } = useTranslation();
  const [records, setRecords] = useState<GosiComplianceRecord[] | null>(null);
  const [periods, setPeriods] = useState<CompliancePeriod[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  function load() {
    setError(null);
    Promise.all([listGosiRecords(), listCompliancePeriods()])
      .then(([r, p]) => {
        setRecords(r);
        setPeriods(p);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : t("laborCompliancePage.gosi.loadError")));
  }
  useEffect(load, []);

  const selected = records?.find((r) => r.id === selectedId) ?? null;

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (records === null || periods === null) return <Skeleton rows={3} />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-stone-800">{t("laborCompliancePage.gosi.heading")}</h3>
        <Can permission="laborCompliance.manage">
          <Button size="sm" onClick={() => setShowCreate((v) => !v)} disabled={periods.length === 0}>
            {showCreate ? t("common.cancel") : t("laborCompliancePage.nitaqat.newRecord")}
          </Button>
        </Can>
      </div>
      {periods.length === 0 && <p className="text-xs text-stone-500">{t("laborCompliancePage.needsPeriodHint")}</p>}
      {showCreate && (
        <GosiForm
          periods={periods}
          onSaved={() => {
            setShowCreate(false);
            load();
            onChanged();
          }}
          onCancel={() => setShowCreate(false)}
        />
      )}

      {records.length === 0 ? (
        <EmptyState message={t("laborCompliancePage.gosi.emptyMessage")} />
      ) : (
        <ul className="space-y-1">
          {records.map((r) => (
            <li key={r.id} className="cursor-pointer rounded-md border border-stone-100 px-3 py-2 text-sm hover:bg-stone-50" onClick={() => setSelectedId(r.id)}>
              <div className="flex items-center justify-between">
                <span>{t("laborCompliancePage.gosi.rowSummary", { contribution: gosiStatusLabel(t, r.contributionStatus), submission: gosiStatusLabel(t, r.submissionStatus) })}</span>
                <Badge tone={verificationStatusTone[r.verificationStatus]}>{t(`laborCompliancePage.verificationStatus.${r.verificationStatus}`)}</Badge>
              </div>
              <p className="mt-1 text-xs text-stone-500">{t("laborCompliancePage.sourceLabel", { source: t(`laborCompliancePage.sourceType.${r.sourceType}`) })}</p>
            </li>
          ))}
        </ul>
      )}

      {selected && (
        <GosiDetail
          record={selected}
          onChanged={() => {
            load();
            onChanged();
          }}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

function GosiForm({ periods, onSaved, onCancel }: { periods: CompliancePeriod[]; onSaved: () => void; onCancel: () => void }) {
  const { t, locale } = useTranslation();
  const [compliancePeriodId, setCompliancePeriodId] = useState(periods[0]?.id ?? "");
  const [registeredEmployeeCount, setRegisteredEmployeeCount] = useState("");
  const [externalReference, setExternalReference] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await createGosiRecord({
        compliancePeriodId,
        registeredEmployeeCount: registeredEmployeeCount ? Number(registeredEmployeeCount) : undefined,
        externalReference: externalReference || undefined,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("laborCompliancePage.recordForm.genericError"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="p-4">
      <form onSubmit={onSubmit} className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {error && (
          <div className="sm:col-span-3">
            <ErrorState message={error} />
          </div>
        )}
        <select required value={compliancePeriodId} onChange={(e) => setCompliancePeriodId(e.target.value)} className="rounded-md border border-stone-300 px-3 py-2 text-sm">
          {periods.map((p) => (
            <option key={p.id} value={p.id}>{p.label ?? formatDate(p.periodStart, locale)}</option>
          ))}
        </select>
        <input type="number" min="0" placeholder={t("laborCompliancePage.gosi.form.registeredCountPlaceholder")} value={registeredEmployeeCount} onChange={(e) => setRegisteredEmployeeCount(e.target.value)} className="rounded-md border border-stone-300 px-3 py-2 text-sm" />
        <input placeholder={t("laborCompliancePage.recordForm.externalReferencePlaceholder")} value={externalReference} onChange={(e) => setExternalReference(e.target.value)} className="rounded-md border border-stone-300 px-3 py-2 text-sm" />
        <div className="flex gap-2 sm:col-span-3">
          <Button type="submit" size="sm" disabled={submitting}>{t("common.save")}</Button>
          <Button type="button" variant="secondary" size="sm" onClick={onCancel}>{t("common.cancel")}</Button>
        </div>
      </form>
    </Card>
  );
}

function GosiDetail({ record, onChanged, onClose }: { record: GosiComplianceRecord; onChanged: () => void; onClose: () => void }) {
  const { t } = useTranslation();
  const [evidence, setEvidence] = useState<ComplianceEvidence[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function loadEvidence() {
    listGosiEvidence(record.id).then(setEvidence).catch(() => setEvidence([]));
  }
  useEffect(loadEvidence, [record.id]);

  async function onVerify() {
    setError(null);
    setSubmitting(true);
    try {
      await verifyGosiRecord(record.id);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("laborCompliancePage.detail.verifyError"));
    } finally {
      setSubmitting(false);
    }
  }

  async function onUpdateStatus(field: "contributionStatus" | "submissionStatus" | "paymentStatus", value: GosiStatus) {
    await updateGosiRecord(record.id, { [field]: value });
    onChanged();
  }

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    try {
      await uploadGosiEvidence(record.id, file);
      loadEvidence();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("laborCompliancePage.detail.uploadError"));
    }
  }

  const statusOptions: GosiStatus[] = ["not_recorded", "recorded", "pending_verification", "verified", "exception"];

  return (
    <Card className="p-5">
      <div className="mb-3 flex items-start justify-between">
        <div>
          <h3 className="font-semibold text-stone-800">{t("laborCompliancePage.gosi.detailTitle")}</h3>
          <Badge tone={verificationStatusTone[record.verificationStatus]}>{t(`laborCompliancePage.verificationStatus.${record.verificationStatus}`)}</Badge>
        </div>
        <button type="button" onClick={onClose} className="text-stone-400 hover:text-stone-600" aria-label={t("laborCompliancePage.detail.closeAriaLabel")}>✕</button>
      </div>

      {error && (
        <div className="mb-3">
          <ErrorState message={error} />
        </div>
      )}

      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {(["contributionStatus", "submissionStatus", "paymentStatus"] as const).map((field) => (
          <div key={field}>
            <label className="mb-1 block text-xs text-stone-500">
              {field === "contributionStatus" ? t("laborCompliancePage.gosi.detail.fields.contribution") : field === "submissionStatus" ? t("laborCompliancePage.gosi.detail.fields.submission") : t("laborCompliancePage.gosi.detail.fields.payment")}
            </label>
            <select
              value={record[field]}
              onChange={(e) => onUpdateStatus(field, e.target.value as GosiStatus)}
              className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
              disabled={record.verificationStatus === "verified"}
            >
              {statusOptions.map((s) => (
                <option key={s} value={s}>{gosiStatusLabel(t, s)}</option>
              ))}
            </select>
          </div>
        ))}
      </div>

      <div className="mb-4">
        <p className="mb-2 text-xs font-semibold text-stone-500">{t("laborCompliancePage.detail.evidenceHeading")}</p>
        {evidence === null && <p className="text-xs text-stone-400">{t("common.loading")}</p>}
        {evidence && evidence.length === 0 && <p className="text-xs text-stone-400">{t("laborCompliancePage.detail.noEvidence")}</p>}
        {evidence && evidence.length > 0 && (
          <ul className="space-y-1">
            {evidence.map((f) => (
              <li key={f.id} className="flex items-center justify-between text-xs">
                <span>{f.fileName}</span>
                <button type="button" onClick={() => downloadGosiEvidence(record.id, f.id, f.fileName)} className="text-primary hover:underline">{t("laborCompliancePage.detail.download")}</button>
              </li>
            ))}
          </ul>
        )}
        <Can permission="laborCompliance.manage">
          <input type="file" onChange={onUpload} className="mt-2 text-xs" />
        </Can>
      </div>

      {record.verificationStatus !== "verified" && (
        <Can permission="laborCompliance.verify">
          <Button size="sm" disabled={submitting} onClick={onVerify}>{t("laborCompliancePage.detail.verify")}</Button>
        </Can>
      )}
    </Card>
  );
}

// --- Exceptions ---
const severityTone: Record<ComplianceExceptionSeverity, "neutral" | "info" | "warning" | "danger"> = { low: "neutral", medium: "info", high: "warning", critical: "danger" };

function ExceptionsTab({ onChanged }: { onChanged: () => void }) {
  const { t } = useTranslation();
  const [exceptions, setExceptions] = useState<ComplianceException[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  function load() {
    setError(null);
    listComplianceExceptions()
      .then(setExceptions)
      .catch((err) => setError(err instanceof ApiError ? err.message : t("laborCompliancePage.exceptions.loadError")));
  }
  useEffect(load, []);

  async function onResolve(id: string) {
    await resolveComplianceException(id);
    load();
    onChanged();
  }
  async function onClose(id: string) {
    await closeComplianceException(id);
    load();
    onChanged();
  }

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (exceptions === null) return <Skeleton rows={3} />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-stone-800">{t("laborCompliancePage.exceptions.heading")}</h3>
        <Can permission="laborCompliance.manage">
          <Button size="sm" onClick={() => setShowCreate((v) => !v)}>{showCreate ? t("common.cancel") : t("laborCompliancePage.exceptions.newException")}</Button>
        </Can>
      </div>
      {showCreate && (
        <ExceptionForm
          onSaved={() => {
            setShowCreate(false);
            load();
            onChanged();
          }}
          onCancel={() => setShowCreate(false)}
        />
      )}

      {exceptions.length === 0 ? (
        <EmptyState message={t("laborCompliancePage.exceptions.emptyMessage")} />
      ) : (
        <ul className="space-y-2">
          {exceptions.map((exc) => (
            <li key={exc.id} className="rounded-md border border-stone-100 px-3 py-2 text-sm">
              <div className="flex items-center justify-between">
                <span>{exc.description}</span>
                <div className="flex items-center gap-2">
                  <Badge tone={severityTone[exc.severity]}>{t(`laborCompliancePage.exceptions.severity.${exc.severity}`)}</Badge>
                  <Badge tone="neutral">{t(`laborCompliancePage.exceptions.status.${exc.status}`)}</Badge>
                </div>
              </div>
              <Can permission="laborCompliance.manage">
                <div className="mt-2 flex gap-2">
                  {(exc.status === "open" || exc.status === "in_progress") && (
                    <Button size="sm" variant="secondary" onClick={() => onResolve(exc.id)}>{t("budgetAlertsPage.detail.markResolved")}</Button>
                  )}
                  {exc.status === "resolved" && (
                    <Button size="sm" variant="secondary" onClick={() => onClose(exc.id)}>{t("laborCompliancePage.exceptions.closeAction")}</Button>
                  )}
                </div>
              </Can>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const EXCEPTION_SEVERITIES: ComplianceExceptionSeverity[] = ["low", "medium", "high", "critical"];

function ExceptionForm({ onSaved, onCancel }: { onSaved: () => void; onCancel: () => void }) {
  const { t } = useTranslation();
  const [description, setDescription] = useState("");
  const [severity, setSeverity] = useState<ComplianceExceptionSeverity>("medium");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await createComplianceException({ description, severity });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("laborCompliancePage.exceptions.form.genericError"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="p-4">
      <form onSubmit={onSubmit} className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {error && (
          <div className="sm:col-span-3">
            <ErrorState message={error} />
          </div>
        )}
        <input required placeholder={t("laborCompliancePage.exceptions.form.descriptionPlaceholder")} value={description} onChange={(e) => setDescription(e.target.value)} className="rounded-md border border-stone-300 px-3 py-2 text-sm sm:col-span-2" />
        <select value={severity} onChange={(e) => setSeverity(e.target.value as ComplianceExceptionSeverity)} className="rounded-md border border-stone-300 px-3 py-2 text-sm">
          {EXCEPTION_SEVERITIES.map((s) => (
            <option key={s} value={s}>{t(`laborCompliancePage.exceptions.severity.${s}`)}</option>
          ))}
        </select>
        <div className="flex gap-2 sm:col-span-3">
          <Button type="submit" size="sm" disabled={submitting}>{t("common.save")}</Button>
          <Button type="button" variant="secondary" size="sm" onClick={onCancel}>{t("common.cancel")}</Button>
        </div>
      </form>
    </Card>
  );
}
