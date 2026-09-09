import { useEffect, useState, type FormEvent } from "react";
import { Layout } from "../components/Layout";
import { PageHeader } from "../ui/PageHeader";
import { Card } from "../ui/Card";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { ErrorState } from "../ui/ErrorState";
import { EmptyState } from "../ui/EmptyState";
import { Skeleton } from "../ui/Skeleton";
import { Modal } from "../ui/Modal";
import { Can } from "../auth/Can";
import { formatDateTime } from "../lib/format";
import { ZatcaOnboardingPanel } from "./zatca/ZatcaOnboardingPanel";
import {
  getZatcaConfig,
  updateZatcaIdentity,
  createZatcaEgsUnit,
  deactivateZatcaEgsUnit,
  configureZatcaCredential,
  clearZatcaCredential,
  verifyZatcaConnection,
  getZatcaOnboardingStatus,
  prepareZatcaSubmission,
  submitZatcaSubmission,
  listAllZatcaSubmissions,
} from "../api/zatca";
import { apiFetch, ApiError } from "../api/client";
import type {
  Invoice,
  ZatcaConfig,
  ZatcaEgsUnit,
  ZatcaEnvironment,
  ZatcaOnboardingStatus,
  ZatcaOnboardingStatusSummary,
  ZatcaPrepareResult,
  ZatcaSubmission,
  ZatcaVerifyConnectionResult,
} from "../api/types";

// MIDAD ZATCA e-invoicing settings (Slice 3) — a frontend consumer of
// server/src/routes/zatca.ts only. This page never claims "ZATCA compliant"
// anywhere: every status shown is exactly what the backend's real
// status/csidStatus/verify-connection response says, using the wording the
// Slice 3 spec requires (Not connected / Configuration incomplete /
// Simulation connected / Production connected / Verification failed /
// Certificate expired) instead of a fabricated boolean.

const statusLabel: Record<ZatcaEgsUnit["status"], string> = {
  not_onboarded: "لم يبدأ الإعداد",
  onboarding: "قيد الإعداد",
  active: "متصلة",
  revoked: "تم إلغاء الاتصال",
  deactivated: "معطّلة",
};
const statusTone: Record<ZatcaEgsUnit["status"], "neutral" | "success" | "warning" | "danger"> = {
  not_onboarded: "neutral",
  onboarding: "warning",
  active: "success",
  revoked: "danger",
  deactivated: "neutral",
};
const csidStatusLabel: Record<ZatcaEgsUnit["csidStatus"], string> = {
  none: "لا يوجد",
  compliance_pending: "بانتظار شهادة الامتثال",
  compliance_issued: "تم إصدار شهادة الامتثال",
  production_issued: "تم إصدار شهادة الإنتاج",
  expired: "منتهية الصلاحية",
  revoked: "ملغاة",
};

// The one display-only derivation this page performs — a wording choice
// over already-real fields (hasCredential/status/environment), never a new
// status value invented on the frontend. See this file's header comment
// for why "ZATCA compliant" is never a string that appears here.
function connectionSummary(unit: ZatcaEgsUnit): { text: string; tone: "neutral" | "success" | "warning" | "danger" } {
  if (!unit.hasCredential) return { text: "غير متصلة — لم يتم إدخال بيانات الاعتماد بعد", tone: "neutral" };
  if (unit.status === "active") {
    return { text: unit.environment === "production" ? "متصلة (بيئة الإنتاج)" : "متصلة (بيئة المحاكاة)", tone: "success" };
  }
  if (unit.status === "onboarding") return { text: "الإعداد غير مكتمل — بحاجة للتحقق من الاتصال", tone: "warning" };
  if (unit.status === "revoked") return { text: "تم إلغاء الاتصال من قبل ZATCA", tone: "danger" };
  if (unit.status === "deactivated") return { text: "معطّلة", tone: "neutral" };
  return { text: "غير متصلة", tone: "neutral" };
}

function isCertificateExpiring(certificateExpiresAt: string | null): boolean {
  if (!certificateExpiresAt) return false;
  const days = (new Date(certificateExpiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
  return days <= 30;
}

// Slice 4 — labels for server/src/lib/zatca/domain/onboarding.ts's
// computed status. Wording deliberately avoids "compliant" anywhere; see
// this file's header comment.
const onboardingStatusLabel: Record<ZatcaOnboardingStatus, string> = {
  not_configured: "لم يبدأ الإعداد بعد",
  configuration_incomplete: "الإعداد غير مكتمل",
  ready_for_simulation: "جاهزة لتجربة بيئة المحاكاة",
  simulation_connected: "متصلة ببيئة المحاكاة",
  simulation_failed: "فشل الاتصال ببيئة المحاكاة",
  production_not_enabled: "بيئة الإنتاج غير مفعّلة بعد",
};
const onboardingStatusTone: Record<ZatcaOnboardingStatus, "neutral" | "success" | "warning" | "danger"> = {
  not_configured: "neutral",
  configuration_incomplete: "warning",
  ready_for_simulation: "warning",
  simulation_connected: "success",
  simulation_failed: "danger",
  production_not_enabled: "warning",
};

function OnboardingStatusBanner({ summary }: { summary: ZatcaOnboardingStatusSummary }) {
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge tone={onboardingStatusTone[summary.status]}>{onboardingStatusLabel[summary.status]}</Badge>
          <span className="text-xs text-stone-400">هذه ليست شهادة امتثال — هي حالة إعداد الاتصال فقط.</span>
        </div>
        <div className="flex flex-wrap gap-3 text-xs text-stone-500">
          <span>الهوية الضريبية: {summary.identityComplete ? "مكتملة" : "غير مكتملة"}</span>
          <span>بيئة المحاكاة: {summary.simulationConnected ? "متصلة" : summary.hasSimulationEgsUnit ? "غير متصلة" : "غير مُعدّة"}</span>
          <span>بيئة الإنتاج: {summary.productionConnected ? "متصلة" : summary.hasProductionEgsUnit ? "غير متصلة" : "غير مُعدّة"}</span>
        </div>
      </div>
    </Card>
  );
}

export function ZatcaSettings() {
  const [config, setConfig] = useState<ZatcaConfig | null>(null);
  const [onboarding, setOnboarding] = useState<ZatcaOnboardingStatusSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Remounts HistoryCard on every load() (identity/EGS/prepare/submit
  // change) so its own submissions fetch is never stale from a single
  // mount-only effect — see HistoryCard's own comment.
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);

  async function load() {
    setError(null);
    try {
      const [configRes, onboardingRes] = await Promise.all([getZatcaConfig(), getZatcaOnboardingStatus()]);
      setConfig(configRes);
      setOnboarding(onboardingRes);
      setHistoryRefreshKey((k) => k + 1);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر تحميل إعدادات الفوترة الإلكترونية");
    } finally {
      setLoaded(true);
    }
  }
  useEffect(() => {
    load();
  }, []);

  if (!loaded) {
    return (
      <Layout>
        <PageHeader title="الفوترة الإلكترونية (ZATCA)" subtitle="ربط شركتك بمنصة فاتورة السعودية للفوترة الإلكترونية." />
        <Skeleton rows={6} />
      </Layout>
    );
  }
  if (error || !config || !onboarding) {
    return (
      <Layout>
        <PageHeader title="الفوترة الإلكترونية (ZATCA)" subtitle="ربط شركتك بمنصة فاتورة السعودية للفوترة الإلكترونية." />
        <ErrorState message={error ?? "تعذّر تحميل البيانات"} onRetry={load} />
      </Layout>
    );
  }

  const simulationUnits = config.egsUnits.filter((u) => u.environment === "simulation");

  return (
    <Layout>
      <PageHeader title="الفوترة الإلكترونية (ZATCA)" subtitle="ربط شركتك بمنصة فاتورة السعودية للفوترة الإلكترونية." />
      <div className="space-y-5">
        <OnboardingStatusBanner summary={onboarding} />
        <IdentityCard identity={config.identity} onSaved={load} />
        <EgsUnitsCard units={config.egsUnits} identity={config.identity} onChanged={load} />
        <SimulationCard simulationUnits={simulationUnits} onChanged={load} />
        <HistoryCard key={historyRefreshKey} />
      </div>
    </Layout>
  );
}

// --- Step 5: Simulation ----------------------------------------------------

function SimulationCard({ simulationUnits, onChanged }: { simulationUnits: ZatcaEgsUnit[]; onChanged: () => void }) {
  const [invoices, setInvoices] = useState<Invoice[] | null>(null);
  const [invoicesError, setInvoicesError] = useState<string | null>(null);
  const [egsUnitId, setEgsUnitId] = useState<string>(simulationUnits[0]?.id ?? "");
  const [invoiceId, setInvoiceId] = useState<string>("");
  const [preparing, setPreparing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [prepareResult, setPrepareResult] = useState<ZatcaPrepareResult | null>(null);
  const [submitOutcome, setSubmitOutcome] = useState<{ error?: string; category?: string; state?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Slice 5 fix: useState's initializer only runs once at mount, so
  // creating the tenant's first simulation EGS unit while already on this
  // page (no reload) left egsUnitId permanently "" and the Prepare button
  // permanently disabled — found via real browser testing, not a unit
  // test. Re-syncs whenever the current selection no longer names a real
  // unit in the list (covers both "list was empty" and "selected unit was
  // deactivated/removed").
  useEffect(() => {
    if (!simulationUnits.some((u) => u.id === egsUnitId)) {
      setEgsUnitId(simulationUnits[0]?.id ?? "");
    }
  }, [simulationUnits, egsUnitId]);

  useEffect(() => {
    apiFetch<Invoice[]>("/invoices")
      .then(setInvoices)
      .catch((err) => setInvoicesError(err instanceof ApiError ? err.message : "تعذّر تحميل الفواتير"));
  }, []);

  async function onPrepare() {
    if (!egsUnitId || !invoiceId) return;
    setError(null);
    setPrepareResult(null);
    setSubmitOutcome(null);
    setPreparing(true);
    try {
      setPrepareResult(await prepareZatcaSubmission(egsUnitId, invoiceId));
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر تحضير المستند");
    } finally {
      setPreparing(false);
    }
  }

  async function onSubmit() {
    if (!prepareResult) return;
    setSubmitting(true);
    setSubmitOutcome(null);
    try {
      const result = await submitZatcaSubmission(prepareResult.submission.id);
      setSubmitOutcome({ state: result.submission.state });
    } catch (err) {
      // apiFetch throws ApiError for the 400/404/409/501 outcomes /submit
      // can return — this is the REAL result (e.g. "not_implemented" at
      // the signing boundary), never hidden or reworded as success.
      setSubmitOutcome({ error: err instanceof ApiError ? err.message : "تعذّر الإرسال" });
    } finally {
      setSubmitting(false);
      onChanged(); // refresh onboarding status + History with the real persisted outcome
    }
  }

  if (simulationUnits.length === 0) {
    return (
      <Card className="p-5">
        <h2 className="mb-1 font-semibold text-stone-800">٥. بيئة المحاكاة (Simulation)</h2>
        <EmptyState message="أنشئي وحدة فوترة إلكترونية ببيئة المحاكاة أولاً (الخطوة ٢)." />
      </Card>
    );
  }

  return (
    <Card className="p-5">
      <h2 className="mb-1 font-semibold text-stone-800">٥. بيئة المحاكاة (Simulation)</h2>
      <p className="mb-4 text-sm text-stone-500">
        اختاري فاتورة ووحدة فوترة إلكترونية لتحضير مستند ZATCA حقيقي (XML + تجزئة + ICV/PIH)، ثم جرّبي إرساله. هذه بيئة
        اختبار حقيقية — لا تُستخدم بيانات وهمية.
      </p>
      <Can permission="zatca.submit">
        <div className="grid grid-cols-1 gap-3 border-b border-stone-100 pb-4 sm:grid-cols-3">
          <select
            value={egsUnitId}
            onChange={(e) => setEgsUnitId(e.target.value)}
            className="rounded-md border border-stone-300 px-3 py-2 text-sm"
          >
            {simulationUnits.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
          {invoicesError ? (
            <div className="sm:col-span-2">
              <ErrorState message={invoicesError} />
            </div>
          ) : (
            <select
              value={invoiceId}
              onChange={(e) => setInvoiceId(e.target.value)}
              className="rounded-md border border-stone-300 px-3 py-2 text-sm sm:col-span-2"
            >
              <option value="">
                {invoices === null ? "جارٍ تحميل الفواتير..." : invoices.length === 0 ? "لا توجد فواتير" : "اختاري فاتورة"}
              </option>
              {(invoices ?? []).map((inv) => (
                <option key={inv.id} value={inv.id}>
                  {inv.invoiceNumber} — {inv.clientName}
                </option>
              ))}
            </select>
          )}
        </div>
      </Can>

      {error && <ErrorState message={error} />}

      <Can permission="zatca.submit">
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" disabled={preparing || !egsUnitId || !invoiceId} onClick={onPrepare}>
            {preparing ? "جارٍ التحضير..." : "توليد المستند (XML) وتحضيره"}
          </Button>
          {prepareResult && (
            <Button size="sm" variant="secondary" disabled={submitting} onClick={onSubmit}>
              {submitting ? "جارٍ الإرسال..." : "إرسال إلى ZATCA (محاكاة)"}
            </Button>
          )}
        </div>
      </Can>

      {prepareResult && (
        <div className="mt-4 rounded-md bg-stone-50 p-3 text-xs text-stone-600">
          <p>
            {prepareResult.alreadyExists ? "تم تحضير هذا المستند مسبقاً — تمت إعادة استخدامه (لا تكرار)." : "تم تحضير مستند جديد."}
          </p>
          <p className="mt-1">رقم ICV: {prepareResult.submission.icv} · تجزئة المستند: {prepareResult.submission.documentHash.slice(0, 24)}…</p>
          <p className="mt-1">
            نتيجة التحقق البنيوي/الحسابي: {prepareResult.validation.valid ? "سليم" : "به أخطاء"} (هذا ليس تحقق SDK رسمي من
            ZATCA — sdkVerified: {String(prepareResult.validation.sdkVerified)})
          </p>
          {prepareResult.validation.errors.length > 0 && (
            <ul className="mt-1 list-inside list-disc text-danger-700">
              {prepareResult.validation.errors.map((e) => (
                <li key={e.code}>{e.message}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {submitOutcome && (
        <div
          className={`mt-3 rounded-md p-3 text-xs ${
            submitOutcome.error ? "bg-warning-100 text-warning-700" : submissionOutcomePanelClasses[submissionStateTone(submitOutcome.state ?? "")]
          }`}
        >
          {submitOutcome.error ? (
            <>
              <p className="font-medium">لم يتم الإرسال إلى ZATCA فعلياً.</p>
              <p className="mt-1">{submitOutcome.error}</p>
            </>
          ) : (
            <p>حالة المستند الآن: {submissionStateLabel[submitOutcome.state ?? ""] ?? submitOutcome.state}</p>
          )}
        </div>
      )}
    </Card>
  );
}

// --- Step 6: History --------------------------------------------------------

const submissionStateLabel: Record<string, string> = {
  not_submitted: "لم تُرسل بعد",
  ready_for_submission: "جاهزة للإرسال",
  submitting: "جارٍ الإرسال",
  submitted: "أُرسلت",
  cleared: "معتمدة (Clearance)",
  reported: "مُبلَّغة (Reporting)",
  rejected: "مرفوضة",
  retry_required: "بحاجة لإعادة محاولة",
  compliance_pending: "بانتظار فحص الامتثال",
  compliance_failed: "فشل الإرسال",
};

// Slice AB — shared by the History card's badges and SimulationCard's own
// submit-outcome panel, so a real "cleared"/"reported" result is never
// styled the same as a failure just because it flows through the same
// generic panel. "cleared"/"reported" here means exactly what ZATCA's own
// response field said — never a claim about ZATCA-wide compliance.
function submissionStateTone(state: string): "neutral" | "success" | "danger" {
  if (state === "compliance_failed" || state === "rejected") return "danger";
  if (state === "cleared" || state === "reported") return "success";
  return "neutral";
}

const submissionOutcomePanelClasses: Record<"neutral" | "success" | "danger", string> = {
  neutral: "bg-stone-100 text-stone-600",
  success: "bg-success-100 text-success-700",
  danger: "bg-danger-100 text-danger-700",
};

// Remounted (via a changing `key`) by the parent's load() on every
// identity/EGS/prepare/submit change — its own effect only fetches once
// per mount, so without that remount a freshly prepared/submitted
// submission would not appear until a manual page reload.
function HistoryCard() {
  const [submissions, setSubmissions] = useState<ZatcaSubmission[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setSubmissions(null);
    setError(null);
    listAllZatcaSubmissions()
      .then((page) => setSubmissions(page.submissions))
      .catch((err) => setError(err instanceof ApiError ? err.message : "تعذّر تحميل سجل الإرسالات"));
  }
  useEffect(load, []);

  return (
    <Card className="p-5">
      <h2 className="mb-1 font-semibold text-stone-800">٦. سجل إرسالات ZATCA</h2>
      <p className="mb-4 text-sm text-stone-500">آخر المستندات التي تم تحضيرها أو محاولة إرسالها، بحالتها الحقيقية فقط.</p>
      {error && <ErrorState message={error} onRetry={load} />}
      {!error && !submissions && <Skeleton rows={3} />}
      {!error && submissions && submissions.length === 0 && <EmptyState message="لا توجد إرسالات بعد." />}
      {!error && submissions && submissions.length > 0 && (
        <div className="space-y-2">
          {submissions.map((s) => (
            <div key={s.id} className="rounded-lg border border-stone-200 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-stone-800">ICV #{s.icv} · {s.environment === "production" ? "إنتاج" : "محاكاة"}</span>
                <Badge tone={submissionStateTone(s.state)}>{submissionStateLabel[s.state] ?? s.state}</Badge>
              </div>
              <p className="mt-1 text-xs text-stone-400">{formatDateTime(s.createdAt)} · محاولات: {s.retryCount}</p>
              {s.zatcaErrorMessage && <p className="mt-1 text-xs text-danger-700">{s.zatcaErrorMessage}</p>}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// --- Step 1: tax identity -------------------------------------------------

function IdentityCard({ identity, onSaved }: { identity: ZatcaConfig["identity"]; onSaved: () => void }) {
  const [vatNumber, setVatNumber] = useState(identity.vatNumber ?? "");
  const [commercialRegistration, setCommercialRegistration] = useState(identity.commercialRegistration ?? "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await updateZatcaIdentity({
        vatNumber: vatNumber || undefined,
        commercialRegistration: commercialRegistration || undefined,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر حفظ بيانات الهوية الضريبية");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="p-5">
      <h2 className="mb-1 font-semibold text-stone-800">١. بيانات الهوية الضريبية</h2>
      <p className="mb-4 text-sm text-stone-500">
        الاسم القانوني والعنوان تُقرأ من إعدادات الشركة. أدخلي الرقم الضريبي والسجل التجاري هنا لاستخدامهما في الفوترة
        الإلكترونية.
      </p>
      <dl className="mb-4 grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
        <Field label="الاسم القانوني" value={identity.legalName ?? "—"} />
        <Field label="العنوان" value={identity.address ?? "—"} />
      </dl>
      <Can permission="zatca.configure">
        <form onSubmit={onSubmit} className="grid grid-cols-1 gap-3 border-t border-stone-100 pt-4 sm:grid-cols-2">
          {error && (
            <div className="sm:col-span-2">
              <ErrorState message={error} />
            </div>
          )}
          <label className="text-sm text-stone-600">
            الرقم الضريبي (VAT)
            <input
              value={vatNumber}
              onChange={(e) => setVatNumber(e.target.value)}
              className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="text-sm text-stone-600">
            السجل التجاري
            <input
              value={commercialRegistration}
              onChange={(e) => setCommercialRegistration(e.target.value)}
              className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
            />
          </label>
          <Button type="submit" disabled={submitting} className="sm:col-span-2">
            {submitting ? "جارٍ الحفظ..." : "حفظ"}
          </Button>
        </form>
      </Can>
      {!identity.vatNumber && !identity.commercialRegistration && (
        <p className="mt-2 text-xs text-warning-700">لم يتم إدخال الرقم الضريبي أو السجل التجاري بعد.</p>
      )}
    </Card>
  );
}

// --- Step 2+: EGS units ---------------------------------------------------

function EgsUnitsCard({ units, identity, onChanged }: { units: ZatcaEgsUnit[]; identity: ZatcaConfig["identity"]; onChanged: () => void }) {
  const [showCreate, setShowCreate] = useState(false);

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-stone-800">٢. وحدات الفوترة الإلكترونية (EGS)</h2>
          <p className="mt-1 text-sm text-stone-500">
            أنشئي وحدة، ثم أكملي إعداد ZATCA الحقيقي (CSR → شهادة الامتثال → شهادة الإنتاج) من داخل كل وحدة، أو أدخلي
            بيانات اعتماد حصلتِ عليها من قناة أخرى مباشرةً.
          </p>
        </div>
        <Can permission="zatca.configure">
          <Button size="sm" onClick={() => setShowCreate((v) => !v)}>
            {showCreate ? "إلغاء" : "+ وحدة جديدة"}
          </Button>
        </Can>
      </div>

      {showCreate && (
        <div className="mb-4 border-b border-stone-100 pb-4">
          <CreateEgsUnitForm
            onDone={() => {
              setShowCreate(false);
              onChanged();
            }}
          />
        </div>
      )}

      {units.length === 0 ? (
        <EmptyState message="لا توجد وحدات فوترة إلكترونية بعد." />
      ) : (
        <div className="space-y-3">
          {units.map((unit) => (
            <EgsUnitRow key={unit.id} unit={unit} identity={identity} onChanged={onChanged} />
          ))}
        </div>
      )}
    </Card>
  );
}

function CreateEgsUnitForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [environment, setEnvironment] = useState<ZatcaEnvironment>("simulation");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setError(null);
    setSubmitting(true);
    try {
      await createZatcaEgsUnit({ name: name.trim(), environment });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر إنشاء الوحدة");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {error && (
        <div className="sm:col-span-3">
          <ErrorState message={error} />
        </div>
      )}
      <input
        required
        placeholder="اسم الوحدة (مثال: المكتب الرئيسي)"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="rounded-md border border-stone-300 px-3 py-2 text-sm sm:col-span-2"
      />
      <select
        value={environment}
        onChange={(e) => setEnvironment(e.target.value as ZatcaEnvironment)}
        className="rounded-md border border-stone-300 px-3 py-2 text-sm"
      >
        <option value="simulation">بيئة المحاكاة (Simulation)</option>
        <option value="production">بيئة الإنتاج (Production)</option>
      </select>
      <Button type="submit" disabled={submitting || !name.trim()} className="sm:col-span-3">
        {submitting ? "جارٍ الإنشاء..." : "إنشاء الوحدة"}
      </Button>
    </form>
  );
}

function EgsUnitRow({ unit, identity, onChanged }: { unit: ZatcaEgsUnit; identity: ZatcaConfig["identity"]; onChanged: () => void }) {
  const [showCredential, setShowCredential] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<ZatcaVerifyConnectionResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const summary = connectionSummary(unit);
  const certExpiring = isCertificateExpiring(unit.certificateExpiresAt);

  async function onVerify() {
    setVerifying(true);
    setError(null);
    setVerifyResult(null);
    try {
      const result = await verifyZatcaConnection(unit.id);
      setVerifyResult(result);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر التحقق من الاتصال");
    } finally {
      setVerifying(false);
    }
  }

  async function onDeactivate() {
    setError(null);
    try {
      await deactivateZatcaEgsUnit(unit.id);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر التعطيل");
    }
  }

  async function onClearCredential() {
    setError(null);
    try {
      await clearZatcaCredential(unit.id);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر إزالة بيانات الاعتماد");
    }
  }

  return (
    <div className="rounded-lg border border-stone-200 p-4">
      {error && <ErrorState message={error} />}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium text-stone-800">{unit.name}</p>
          <p className="mt-0.5 text-xs text-stone-400">
            {unit.environment === "production" ? "بيئة الإنتاج" : "بيئة المحاكاة"} · أُنشئت {formatDateTime(unit.createdAt)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={statusTone[unit.status]}>{statusLabel[unit.status]}</Badge>
          <Badge tone="neutral">شهادة CSID: {csidStatusLabel[unit.csidStatus]}</Badge>
        </div>
      </div>

      <p className={`mt-2 text-sm ${summary.tone === "success" ? "text-success-700" : summary.tone === "danger" ? "text-danger-700" : summary.tone === "warning" ? "text-warning-700" : "text-stone-500"}`}>
        {summary.text}
      </p>

      {certExpiring && (
        <p className="mt-1 text-xs text-warning-700">تنتهي صلاحية الشهادة قريباً: {formatDateTime(unit.certificateExpiresAt!)}</p>
      )}
      {unit.lastCommunicationAt && (
        <p className="mt-1 text-xs text-stone-400">آخر تواصل مع ZATCA: {formatDateTime(unit.lastCommunicationAt)}</p>
      )}

      {verifyResult && (
        <div className="mt-2 rounded-md bg-stone-50 p-2 text-xs text-stone-600">
          نتيجة آخر تحقق: {verifyResult.detail ?? (verifyResult.connected ? "تم الاتصال" : "لم يتصل")}
          {verifyResult.correlationId && <span className="block text-stone-400">معرّف التتبّع: {verifyResult.correlationId}</span>}
        </div>
      )}

      <Can permission="zatca.configure">
        <div className="mt-3 flex flex-wrap gap-2 border-t border-stone-100 pt-3">
          {!unit.hasCredential ? (
            <Button size="sm" variant="secondary" onClick={() => setShowCredential(true)}>
              ربط بيانات الاعتماد
            </Button>
          ) : (
            <Button size="sm" variant="secondary" onClick={onClearCredential}>
              إزالة بيانات الاعتماد
            </Button>
          )}
          <Can permission="zatca.submit">
            <Button size="sm" disabled={verifying} onClick={onVerify}>
              {verifying ? "جارٍ التحقق..." : "التحقق من الاتصال"}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setShowOnboarding((v) => !v)}>
              {showOnboarding ? "إخفاء إعداد ZATCA الحقيقي" : "إعداد ZATCA الحقيقي (CSR ← شهادة الامتثال ← الإنتاج)"}
            </Button>
          </Can>
          {unit.status !== "deactivated" && (
            <Button size="sm" variant="secondary" onClick={onDeactivate}>
              تعطيل الوحدة
            </Button>
          )}
        </div>
      </Can>

      {showOnboarding && (
        <div className="mt-3 border-t border-stone-100 pt-3">
          <ZatcaOnboardingPanel unit={unit} identity={identity} onChanged={onChanged} />
        </div>
      )}

      <CredentialModal
        open={showCredential}
        egsUnitId={unit.id}
        onClose={() => setShowCredential(false)}
        onDone={() => {
          setShowCredential(false);
          onChanged();
        }}
      />
    </div>
  );
}

function CredentialModal({
  open,
  egsUnitId,
  onClose,
  onDone,
}: {
  open: boolean;
  egsUnitId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [binarySecurityToken, setBinarySecurityToken] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await configureZatcaCredential(egsUnitId, { binarySecurityToken, secret });
      setBinarySecurityToken("");
      setSecret("");
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر حفظ بيانات الاعتماد");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="ربط بيانات اعتماد ZATCA">
      <form onSubmit={onSubmit} className="space-y-3">
        <p className="text-sm text-stone-500">
          أدخلي الشهادة (binarySecurityToken) والمفتاح السري الناتجَين من إتمام إجراءات الإعداد مع ZATCA خارج المنصة. لا
          تُخزَّن هذه القيم في قاعدة بيانات MIDAD ولا تُعرض مجدداً بعد الحفظ.
        </p>
        {error && <ErrorState message={error} />}
        <label className="block text-sm text-stone-600">
          binarySecurityToken
          <textarea
            required
            value={binarySecurityToken}
            onChange={(e) => setBinarySecurityToken(e.target.value)}
            rows={3}
            className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 font-mono text-xs"
          />
        </label>
        <label className="block text-sm text-stone-600">
          المفتاح السري (secret)
          <input
            required
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
          />
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>
            إلغاء
          </Button>
          <Button type="submit" size="sm" disabled={submitting || !binarySecurityToken || !secret}>
            {submitting ? "جارٍ الحفظ..." : "حفظ"}
          </Button>
        </div>
      </form>
    </Modal>
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
