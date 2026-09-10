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
  const [dashboard, setDashboard] = useState<ComplianceDashboard | null>(null);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"periods" | "nitaqat" | "gosi" | "exceptions">("nitaqat");

  function loadDashboard() {
    setDashboardError(null);
    setDashboard(null);
    getComplianceDashboard()
      .then(setDashboard)
      .catch((err) => setDashboardError(err instanceof ApiError ? err.message : "تعذّر تحميل لوحة الامتثال"));
  }
  useEffect(loadDashboard, []);

  return (
    <Layout>
      <PageHeader title="امتثال العمالة — نطاقات و GOSI" subtitle="تتبع داخلي لبيانات نطاقات والتأمينات الاجتماعية، غير متصل رسمياً بأي جهة حكومية." />

      <div className="mb-6">
        {dashboardError && <ErrorState message={dashboardError} onRetry={loadDashboard} />}
        {!dashboardError && !dashboard && <Skeleton rows={3} />}
        {!dashboardError && dashboard && <DashboardCard dashboard={dashboard} />}
      </div>

      <Tabs
        items={[
          { key: "nitaqat", label: "نطاقات" },
          { key: "gosi", label: "GOSI" },
          { key: "exceptions", label: "استثناءات" },
          { key: "periods", label: "الفترات" },
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

const sourceTypeLabel: Record<ComplianceSourceType, string> = {
  manual: "إدخال داخلي",
  csv_import: "استيراد CSV",
  excel_import: "استيراد Excel",
  external_reference: "مرجع خارجي",
};
const verificationStatusLabel: Record<ComplianceVerificationStatus, string> = {
  unverified: "غير موثق",
  pending_verification: "بانتظار التحقق",
  verified: "موثق",
};
const verificationStatusTone: Record<ComplianceVerificationStatus, "neutral" | "warning" | "success"> = {
  unverified: "neutral",
  pending_verification: "warning",
  verified: "success",
};
const gosiStatusLabel: Record<GosiStatus, string> = {
  not_recorded: "غير مسجَّل",
  recorded: "مسجَّل",
  pending_verification: "بانتظار التحقق",
  verified: "موثق",
  exception: "استثناء",
};

function DashboardCard({ dashboard }: { dashboard: ComplianceDashboard }) {
  return (
    <Card className="p-5">
      <h2 className="mb-4 font-semibold text-stone-800">الامتثال</h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <p className="mb-1 text-xs font-semibold text-stone-500">نطاقات</p>
          {dashboard.nitaqat ? (
            <>
              <Badge tone={verificationStatusTone[dashboard.nitaqat.verificationStatus]}>{verificationStatusLabel[dashboard.nitaqat.verificationStatus]}</Badge>
              <p className="mt-1 text-xs text-stone-500">المصدر: {sourceTypeLabel[dashboard.nitaqat.sourceType]}</p>
              <p className="text-xs text-stone-400">آخر تحديث: {formatDate(dashboard.nitaqat.updatedAt)}</p>
            </>
          ) : (
            <p className="text-sm text-stone-400">لا يوجد سجل بعد</p>
          )}
        </div>
        <div>
          <p className="mb-1 text-xs font-semibold text-stone-500">GOSI</p>
          {dashboard.gosi ? (
            <>
              <Badge tone={verificationStatusTone[dashboard.gosi.verificationStatus]}>{verificationStatusLabel[dashboard.gosi.verificationStatus]}</Badge>
              <p className="mt-1 text-xs text-stone-500">المصدر: {sourceTypeLabel[dashboard.gosi.sourceType]}</p>
              <p className="text-xs text-stone-400">آخر تحديث: {formatDate(dashboard.gosi.updatedAt)}</p>
            </>
          ) : (
            <p className="text-sm text-stone-400">لا يوجد سجل بعد</p>
          )}
        </div>
        <div>
          <p className="mb-1 text-xs font-semibold text-stone-500">استثناءات</p>
          <p className="text-sm text-stone-700">{dashboard.exceptions.open} مفتوحة</p>
          {dashboard.exceptions.highOrCritical > 0 && <p className="text-sm text-danger-600">{dashboard.exceptions.highOrCritical} عالية الأولوية</p>}
        </div>
      </div>
    </Card>
  );
}

// --- Periods ---
function PeriodsTab({ onChanged }: { onChanged: () => void }) {
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
      .catch((err) => setError(err instanceof ApiError ? err.message : "تعذّر تحميل الفترات"));
  }
  useEffect(load, []);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (periods === null || snapshots === null) return <Skeleton rows={3} />;

  return (
    <div className="space-y-6">
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold text-stone-800">فترات الامتثال</h3>
          <Can permission="laborCompliance.manage">
            <Button size="sm" onClick={() => setShowCreatePeriod((v) => !v)}>
              {showCreatePeriod ? "إلغاء" : "+ فترة جديدة"}
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
          <EmptyState message="لا توجد فترات امتثال بعد" />
        ) : (
          <ul className="space-y-1">
            {periods.map((p) => (
              <li key={p.id} className="flex items-center justify-between rounded-md border border-stone-100 px-3 py-2 text-sm">
                <span>{p.label ?? `${formatDate(p.periodStart)} — ${formatDate(p.periodEnd)}`}</span>
                <Badge tone={p.status === "open" ? "success" : "neutral"}>{p.status === "open" ? "مفتوحة" : "مغلقة"}</Badge>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-semibold text-stone-800">لقطات العمالة</h3>
          <Can permission="laborCompliance.manage">
            <Button size="sm" onClick={() => setShowCreateSnapshot((v) => !v)} disabled={periods.length === 0}>
              {showCreateSnapshot ? "إلغاء" : "+ لقطة جديدة"}
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
          <EmptyState message="لا توجد لقطات عمالة بعد" />
        ) : (
          <ul className="space-y-1">
            {snapshots.map((s) => (
              <li key={s.id} className="rounded-md border border-stone-100 px-3 py-2 text-sm">
                <div className="flex items-center justify-between">
                  <span>{formatDate(s.snapshotDate)} — إجمالي {s.totalEmployees} (سعوديون {s.saudiEmployees} / غير سعوديين {s.nonSaudiEmployees})</span>
                  <Badge tone={verificationStatusTone[s.verificationStatus]}>{verificationStatusLabel[s.verificationStatus]}</Badge>
                </div>
                <p className="mt-1 text-xs text-stone-500">المصدر: {sourceTypeLabel[s.sourceType]}</p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function PeriodForm({ onSaved, onCancel }: { onSaved: () => void; onCancel: () => void }) {
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
      setError(err instanceof ApiError ? err.message : "تعذّر إنشاء الفترة");
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
        <input placeholder="تسمية (اختياري)" value={label} onChange={(e) => setLabel(e.target.value)} className="rounded-md border border-stone-300 px-3 py-2 text-sm sm:col-span-2" />
        <input required type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} className="rounded-md border border-stone-300 px-3 py-2 text-sm" />
        <input required type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} className="rounded-md border border-stone-300 px-3 py-2 text-sm" />
        <div className="flex gap-2 sm:col-span-4">
          <Button type="submit" size="sm" disabled={submitting}>حفظ</Button>
          <Button type="button" variant="secondary" size="sm" onClick={onCancel}>إلغاء</Button>
        </div>
      </form>
    </Card>
  );
}

function SnapshotForm({ periods, onSaved, onCancel }: { periods: CompliancePeriod[]; onSaved: () => void; onCancel: () => void }) {
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
      setError(err instanceof ApiError ? err.message : "تعذّر إنشاء اللقطة");
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
            <option key={p.id} value={p.id}>{p.label ?? formatDate(p.periodStart)}</option>
          ))}
        </select>
        <input required type="date" value={snapshotDate} onChange={(e) => setSnapshotDate(e.target.value)} className="rounded-md border border-stone-300 px-3 py-2 text-sm" />
        <input required type="number" min="0" placeholder="إجمالي الموظفين" value={totalEmployees} onChange={(e) => setTotalEmployees(e.target.value)} className="rounded-md border border-stone-300 px-3 py-2 text-sm" />
        <input required type="number" min="0" placeholder="سعوديون" value={saudiEmployees} onChange={(e) => setSaudiEmployees(e.target.value)} className="rounded-md border border-stone-300 px-3 py-2 text-sm" />
        <input required type="number" min="0" placeholder="غير سعوديين" value={nonSaudiEmployees} onChange={(e) => setNonSaudiEmployees(e.target.value)} className="rounded-md border border-stone-300 px-3 py-2 text-sm" />
        <div className="flex gap-2 sm:col-span-4">
          <Button type="submit" size="sm" disabled={submitting}>حفظ</Button>
          <Button type="button" variant="secondary" size="sm" onClick={onCancel}>إلغاء</Button>
        </div>
      </form>
    </Card>
  );
}

// --- Nitaqat ---
function NitaqatTab({ onChanged }: { onChanged: () => void }) {
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
      .catch((err) => setError(err instanceof ApiError ? err.message : "تعذّر تحميل سجلات نطاقات"));
  }
  useEffect(load, []);

  const selected = records?.find((r) => r.id === selectedId) ?? null;

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (records === null || periods === null) return <Skeleton rows={3} />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-stone-800">سجلات نطاقات</h3>
        <Can permission="laborCompliance.manage">
          <Button size="sm" onClick={() => setShowCreate((v) => !v)} disabled={periods.length === 0}>
            {showCreate ? "إلغاء" : "+ سجل جديد"}
          </Button>
        </Can>
      </div>
      {periods.length === 0 && <p className="text-xs text-stone-500">أنشئ فترة امتثال أولاً من تبويب "الفترات".</p>}
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
        <EmptyState message="لا توجد سجلات نطاقات بعد" />
      ) : (
        <ul className="space-y-1">
          {records.map((r) => (
            <li key={r.id} className="cursor-pointer rounded-md border border-stone-100 px-3 py-2 text-sm hover:bg-stone-50" onClick={() => setSelectedId(r.id)}>
              <div className="flex items-center justify-between">
                <span>{r.classification ?? "بدون تصنيف مسجَّل"} — إجمالي {r.totalCount} (سعوديون {r.saudiCount})</span>
                <Badge tone={verificationStatusTone[r.verificationStatus]}>{verificationStatusLabel[r.verificationStatus]}</Badge>
              </div>
              <p className="mt-1 text-xs text-stone-500">المصدر: {sourceTypeLabel[r.sourceType]}</p>
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
      setError(err instanceof ApiError ? err.message : "تعذّر إنشاء السجل");
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
        <p className="text-xs text-stone-500 sm:col-span-3">أدخل التصنيف كما ورد لك تحديداً (مثلاً من شاشة قوى) — هذا الحقل نص حر، ولا يُحسب داخل مداد.</p>
        <select required value={compliancePeriodId} onChange={(e) => setCompliancePeriodId(e.target.value)} className="rounded-md border border-stone-300 px-3 py-2 text-sm">
          {periods.map((p) => (
            <option key={p.id} value={p.id}>{p.label ?? formatDate(p.periodStart)}</option>
          ))}
        </select>
        <input placeholder="التصنيف المُبلَّغ (اختياري)" value={classification} onChange={(e) => setClassification(e.target.value)} className="rounded-md border border-stone-300 px-3 py-2 text-sm sm:col-span-2" />
        <input required type="number" min="0" placeholder="عدد السعوديين" value={saudiCount} onChange={(e) => setSaudiCount(e.target.value)} className="rounded-md border border-stone-300 px-3 py-2 text-sm" />
        <input required type="number" min="0" placeholder="عدد غير السعوديين" value={nonSaudiCount} onChange={(e) => setNonSaudiCount(e.target.value)} className="rounded-md border border-stone-300 px-3 py-2 text-sm" />
        <input required type="number" min="0" placeholder="الإجمالي" value={totalCount} onChange={(e) => setTotalCount(e.target.value)} className="rounded-md border border-stone-300 px-3 py-2 text-sm" />
        <input placeholder="مرجع خارجي (اختياري)" value={externalReference} onChange={(e) => setExternalReference(e.target.value)} className="rounded-md border border-stone-300 px-3 py-2 text-sm sm:col-span-3" />
        <div className="flex gap-2 sm:col-span-3">
          <Button type="submit" size="sm" disabled={submitting}>حفظ</Button>
          <Button type="button" variant="secondary" size="sm" onClick={onCancel}>إلغاء</Button>
        </div>
      </form>
    </Card>
  );
}

function NitaqatDetail({ record, onChanged, onClose }: { record: NitaqatComplianceRecord; onChanged: () => void; onClose: () => void }) {
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
      setError(err instanceof ApiError ? err.message : "تعذّر التحقق من السجل");
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
      setError(err instanceof ApiError ? err.message : "تعذّر رفع الدليل");
    }
  }

  return (
    <Card className="p-5">
      <div className="mb-3 flex items-start justify-between">
        <div>
          <h3 className="font-semibold text-stone-800">{record.classification ?? "سجل نطاقات"}</h3>
          <Badge tone={verificationStatusTone[record.verificationStatus]}>{verificationStatusLabel[record.verificationStatus]}</Badge>
        </div>
        <button type="button" onClick={onClose} className="text-stone-400 hover:text-stone-600" aria-label="إغلاق التفاصيل">✕</button>
      </div>

      {error && (
        <div className="mb-3">
          <ErrorState message={error} />
        </div>
      )}

      <dl className="mb-4 text-sm">
        <div className="flex justify-between border-b border-stone-100 py-1.5"><dt className="text-stone-500">المصدر</dt><dd>{sourceTypeLabel[record.sourceType]}</dd></div>
        <div className="flex justify-between border-b border-stone-100 py-1.5"><dt className="text-stone-500">مرجع خارجي</dt><dd>{record.externalReference ?? "—"}</dd></div>
        <div className="flex justify-between py-1.5"><dt className="text-stone-500">ملاحظات</dt><dd>{record.notes ?? "—"}</dd></div>
      </dl>

      <div className="mb-4">
        <p className="mb-2 text-xs font-semibold text-stone-500">الأدلة الداعمة</p>
        {evidence === null && <p className="text-xs text-stone-400">جارٍ التحميل...</p>}
        {evidence && evidence.length === 0 && <p className="text-xs text-stone-400">لا توجد أدلة مرفقة</p>}
        {evidence && evidence.length > 0 && (
          <ul className="space-y-1">
            {evidence.map((f) => (
              <li key={f.id} className="flex items-center justify-between text-xs">
                <span>{f.fileName}</span>
                <button type="button" onClick={() => downloadNitaqatEvidence(record.id, f.id, f.fileName)} className="text-primary hover:underline">تنزيل</button>
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
          <Button size="sm" disabled={submitting} onClick={onVerify}>تحقق من السجل</Button>
        </Can>
      )}
    </Card>
  );
}

// --- GOSI ---
function GosiTab({ onChanged }: { onChanged: () => void }) {
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
      .catch((err) => setError(err instanceof ApiError ? err.message : "تعذّر تحميل سجلات GOSI"));
  }
  useEffect(load, []);

  const selected = records?.find((r) => r.id === selectedId) ?? null;

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (records === null || periods === null) return <Skeleton rows={3} />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-stone-800">سجلات GOSI</h3>
        <Can permission="laborCompliance.manage">
          <Button size="sm" onClick={() => setShowCreate((v) => !v)} disabled={periods.length === 0}>
            {showCreate ? "إلغاء" : "+ سجل جديد"}
          </Button>
        </Can>
      </div>
      {periods.length === 0 && <p className="text-xs text-stone-500">أنشئ فترة امتثال أولاً من تبويب "الفترات".</p>}
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
        <EmptyState message="لا توجد سجلات GOSI بعد" />
      ) : (
        <ul className="space-y-1">
          {records.map((r) => (
            <li key={r.id} className="cursor-pointer rounded-md border border-stone-100 px-3 py-2 text-sm hover:bg-stone-50" onClick={() => setSelectedId(r.id)}>
              <div className="flex items-center justify-between">
                <span>الاشتراك: {gosiStatusLabel[r.contributionStatus]} — التقديم: {gosiStatusLabel[r.submissionStatus]}</span>
                <Badge tone={verificationStatusTone[r.verificationStatus]}>{verificationStatusLabel[r.verificationStatus]}</Badge>
              </div>
              <p className="mt-1 text-xs text-stone-500">المصدر: {sourceTypeLabel[r.sourceType]}</p>
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
      setError(err instanceof ApiError ? err.message : "تعذّر إنشاء السجل");
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
            <option key={p.id} value={p.id}>{p.label ?? formatDate(p.periodStart)}</option>
          ))}
        </select>
        <input type="number" min="0" placeholder="عدد الموظفين المسجَّلين (اختياري)" value={registeredEmployeeCount} onChange={(e) => setRegisteredEmployeeCount(e.target.value)} className="rounded-md border border-stone-300 px-3 py-2 text-sm" />
        <input placeholder="مرجع خارجي (اختياري)" value={externalReference} onChange={(e) => setExternalReference(e.target.value)} className="rounded-md border border-stone-300 px-3 py-2 text-sm" />
        <div className="flex gap-2 sm:col-span-3">
          <Button type="submit" size="sm" disabled={submitting}>حفظ</Button>
          <Button type="button" variant="secondary" size="sm" onClick={onCancel}>إلغاء</Button>
        </div>
      </form>
    </Card>
  );
}

function GosiDetail({ record, onChanged, onClose }: { record: GosiComplianceRecord; onChanged: () => void; onClose: () => void }) {
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
      setError(err instanceof ApiError ? err.message : "تعذّر التحقق من السجل");
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
      setError(err instanceof ApiError ? err.message : "تعذّر رفع الدليل");
    }
  }

  const statusOptions: GosiStatus[] = ["not_recorded", "recorded", "pending_verification", "verified", "exception"];

  return (
    <Card className="p-5">
      <div className="mb-3 flex items-start justify-between">
        <div>
          <h3 className="font-semibold text-stone-800">سجل GOSI</h3>
          <Badge tone={verificationStatusTone[record.verificationStatus]}>{verificationStatusLabel[record.verificationStatus]}</Badge>
        </div>
        <button type="button" onClick={onClose} className="text-stone-400 hover:text-stone-600" aria-label="إغلاق التفاصيل">✕</button>
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
              {field === "contributionStatus" ? "الاشتراك" : field === "submissionStatus" ? "التقديم" : "السداد"}
            </label>
            <select
              value={record[field]}
              onChange={(e) => onUpdateStatus(field, e.target.value as GosiStatus)}
              className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
              disabled={record.verificationStatus === "verified"}
            >
              {statusOptions.map((s) => (
                <option key={s} value={s}>{gosiStatusLabel[s]}</option>
              ))}
            </select>
          </div>
        ))}
      </div>

      <div className="mb-4">
        <p className="mb-2 text-xs font-semibold text-stone-500">الأدلة الداعمة</p>
        {evidence === null && <p className="text-xs text-stone-400">جارٍ التحميل...</p>}
        {evidence && evidence.length === 0 && <p className="text-xs text-stone-400">لا توجد أدلة مرفقة</p>}
        {evidence && evidence.length > 0 && (
          <ul className="space-y-1">
            {evidence.map((f) => (
              <li key={f.id} className="flex items-center justify-between text-xs">
                <span>{f.fileName}</span>
                <button type="button" onClick={() => downloadGosiEvidence(record.id, f.id, f.fileName)} className="text-primary hover:underline">تنزيل</button>
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
          <Button size="sm" disabled={submitting} onClick={onVerify}>تحقق من السجل</Button>
        </Can>
      )}
    </Card>
  );
}

// --- Exceptions ---
const severityLabel: Record<ComplianceExceptionSeverity, string> = { low: "منخفضة", medium: "متوسطة", high: "عالية", critical: "حرجة" };
const severityTone: Record<ComplianceExceptionSeverity, "neutral" | "info" | "warning" | "danger"> = { low: "neutral", medium: "info", high: "warning", critical: "danger" };
const exceptionStatusLabel: Record<ComplianceExceptionStatus, string> = { open: "مفتوح", in_progress: "قيد المعالجة", resolved: "تم الحل", closed: "مغلق" };

function ExceptionsTab({ onChanged }: { onChanged: () => void }) {
  const [exceptions, setExceptions] = useState<ComplianceException[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  function load() {
    setError(null);
    listComplianceExceptions()
      .then(setExceptions)
      .catch((err) => setError(err instanceof ApiError ? err.message : "تعذّر تحميل الاستثناءات"));
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
        <h3 className="font-semibold text-stone-800">الاستثناءات</h3>
        <Can permission="laborCompliance.manage">
          <Button size="sm" onClick={() => setShowCreate((v) => !v)}>{showCreate ? "إلغاء" : "+ استثناء جديد"}</Button>
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
        <EmptyState message="لا توجد استثناءات" />
      ) : (
        <ul className="space-y-2">
          {exceptions.map((exc) => (
            <li key={exc.id} className="rounded-md border border-stone-100 px-3 py-2 text-sm">
              <div className="flex items-center justify-between">
                <span>{exc.description}</span>
                <div className="flex items-center gap-2">
                  <Badge tone={severityTone[exc.severity]}>{severityLabel[exc.severity]}</Badge>
                  <Badge tone="neutral">{exceptionStatusLabel[exc.status]}</Badge>
                </div>
              </div>
              <Can permission="laborCompliance.manage">
                <div className="mt-2 flex gap-2">
                  {(exc.status === "open" || exc.status === "in_progress") && (
                    <Button size="sm" variant="secondary" onClick={() => onResolve(exc.id)}>تحديد كمحلول</Button>
                  )}
                  {exc.status === "resolved" && (
                    <Button size="sm" variant="secondary" onClick={() => onClose(exc.id)}>إغلاق</Button>
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

function ExceptionForm({ onSaved, onCancel }: { onSaved: () => void; onCancel: () => void }) {
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
      setError(err instanceof ApiError ? err.message : "تعذّر إنشاء الاستثناء");
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
        <input required placeholder="الوصف (مثال: يحتاج إلى تحقق)" value={description} onChange={(e) => setDescription(e.target.value)} className="rounded-md border border-stone-300 px-3 py-2 text-sm sm:col-span-2" />
        <select value={severity} onChange={(e) => setSeverity(e.target.value as ComplianceExceptionSeverity)} className="rounded-md border border-stone-300 px-3 py-2 text-sm">
          {(Object.keys(severityLabel) as ComplianceExceptionSeverity[]).map((s) => (
            <option key={s} value={s}>{severityLabel[s]}</option>
          ))}
        </select>
        <div className="flex gap-2 sm:col-span-3">
          <Button type="submit" size="sm" disabled={submitting}>حفظ</Button>
          <Button type="button" variant="secondary" size="sm" onClick={onCancel}>إلغاء</Button>
        </div>
      </form>
    </Card>
  );
}
