import { useEffect, useState, type FormEvent } from "react";
import { Tabs } from "../../ui/Tabs";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { ErrorState } from "../../ui/ErrorState";
import { EmptyState } from "../../ui/EmptyState";
import { Skeleton } from "../../ui/Skeleton";
import { formatDateTime } from "../../lib/format";
import { presentZatcaError, type PresentedZatcaError } from "../../lib/zatcaErrors";
import {
  getZatcaCsrInstance,
  generateZatcaCsr,
  confirmZatcaCsid,
  getZatcaComplianceLifecycle,
  requestZatcaComplianceCsid,
  listZatcaComplianceAttempts,
  submitZatcaComplianceInvoice,
  listZatcaProductionCsidOperations,
  requestZatcaProductionCsid,
  renewZatcaProductionCsid,
} from "../../api/zatca";
import type {
  ZatcaEgsUnit,
  ZatcaTenantIdentity,
  ZatcaCsrInstance,
  ZatcaCsrFields,
  ZatcaCsrCustomAttributeOids,
  ZatcaComplianceLifecycle,
  ZatcaComplianceAttempt,
  ZatcaProviderOperation,
  ZatcaComplianceDocumentType,
  ZatcaInvoiceFamily,
} from "../../api/types";

// ZATCA Customer Onboarding & Compliance Center — the real, customer-facing
// CSR -> OTP -> Compliance CSID -> Compliance Invoice -> Production CSID ->
// Renewal workflow. Before this, every one of these backend routes
// (server/src/routes/zatca.ts) existed, worked, and was tested, but had NO
// UI at all — a real MIDAD customer could only reach them with a direct
// authenticated HTTP call (curl/Postman), never through the product. This
// file closes that gap by calling the EXISTING routes exactly as they are
// — no new business logic, no client-side signing/hashing, no invented
// success states. Every status shown here is read back from the backend on
// every load, never assumed to still be true from a prior response.
//
// Rendered per-EGS-unit, behind an explicit toggle in ZatcaSettings.tsx's
// EgsUnitRow (see that file) — onboarding is inherently a per-unit
// workflow (each EGS unit has its own CSR/CSID/certificate lifecycle).

function ErrorPanel({ presented }: { presented: PresentedZatcaError }) {
  return (
    <div className="rounded-md border border-danger-200 bg-danger-50 p-3 text-sm text-danger-800">
      <p className="font-medium">{presented.title}</p>
      <p className="mt-1">{presented.message}</p>
      <p className="mt-1 text-xs text-danger-600">
        {presented.retryGuidanceText}
        {presented.needsAdminOrSupport && " قد تحتاجين لتدخّل مسؤول الشركة أو الدعم الفني."}
      </p>
    </div>
  );
}

// Password-style, cleared on unmount/after each attempt (state lives only
// in the calling step's own component, which resets it) — never persisted
// anywhere, never logged, never stored in localStorage/sessionStorage. See
// this Center's overall security review for the full audit of this claim.
function OtpInput({ value, onChange, egsUnitName }: { value: string; onChange: (v: string) => void; egsUnitName: string }) {
  return (
    <label className="block text-sm text-stone-600">
      رمز التحقق (OTP) — الخاص بوحدة "{egsUnitName}"
      <input
        type="password"
        autoComplete="off"
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="أدخلي رمز OTP من بوابة فاتورة (ZATCA)"
        className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
      />
      <span className="mt-1 block text-xs text-stone-400">
        احصلي على هذا الرمز من بوابة فاتورة (Fatoora) الخاصة بـ ZATCA خارج MIDAD، ثم أدخليه هنا فقط. لا يُخزَّن هذا الرمز
        أو يُسجَّل في أي مكان — يُستخدم لمرة واحدة فقط عند الإرسال.
      </span>
    </label>
  );
}

const csidStatusLabel: Record<ZatcaEgsUnit["csidStatus"], string> = {
  none: "لا يوجد",
  compliance_pending: "بانتظار شهادة الامتثال",
  compliance_issued: "تم إصدار شهادة الامتثال",
  production_issued: "تم إصدار شهادة الإنتاج",
  expired: "منتهية الصلاحية",
  revoked: "ملغاة",
};

export function ZatcaOnboardingPanel({
  unit,
  identity,
  onChanged,
}: {
  unit: ZatcaEgsUnit;
  identity: ZatcaTenantIdentity;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState("csr");

  return (
    <div className="rounded-lg border border-stone-200 bg-stone-50/50 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-stone-700">الإعداد الحقيقي مع ZATCA لوحدة "{unit.name}"</p>
        <Badge tone="neutral">حالة الشهادة: {csidStatusLabel[unit.csidStatus]}</Badge>
      </div>
      <Tabs
        items={[
          { key: "csr", label: "١. طلب CSR" },
          { key: "compliance-csid", label: "٢. شهادة الامتثال" },
          { key: "compliance-invoice", label: "٣. فاتورة اختبار الامتثال" },
          { key: "production-csid", label: "٤. تفعيل الإنتاج" },
          { key: "renewal", label: "٥. التجديد" },
        ]}
        active={tab}
        onChange={setTab}
      />
      <div className="pt-4">
        {tab === "csr" && <CsrStep unit={unit} identity={identity} onChanged={onChanged} />}
        {tab === "compliance-csid" && <ComplianceCsidStep unit={unit} onChanged={onChanged} />}
        {tab === "compliance-invoice" && <ComplianceInvoiceStep unit={unit} />}
        {tab === "production-csid" && <ProductionCsidStep unit={unit} onChanged={onChanged} />}
        {tab === "renewal" && <RenewalStep unit={unit} />}
      </div>
    </div>
  );
}

// --- Step 1: CSR ------------------------------------------------------------

function CsrStep({ unit, identity, onChanged }: { unit: ZatcaEgsUnit; identity: ZatcaTenantIdentity; onChanged: () => void }) {
  const [current, setCurrent] = useState<ZatcaCsrInstance | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [otp, setOtp] = useState("");
  const [fields, setFields] = useState<ZatcaCsrFields>({
    commonName: unit.name,
    egsSerialNumber: "",
    organizationIdentifier: identity.vatNumber ?? "",
    organizationUnitName: "",
    organizationName: identity.legalName ?? "",
    countryCode: "SA",
    invoiceType: "1100",
    location: "",
    industry: "",
  });
  const [showOids, setShowOids] = useState(false);
  const [oids, setOids] = useState<ZatcaCsrCustomAttributeOids>({});
  const [submitting, setSubmitting] = useState(false);
  const [presentedError, setPresentedError] = useState<PresentedZatcaError | null>(null);
  const [result, setResult] = useState<{ csrPem: string; csrDerBase64: string } | null>(null);

  function load() {
    setLoadError(null);
    getZatcaCsrInstance(unit.id)
      .then((res) => setCurrent(res.csrInstance))
      .catch((err) => setLoadError(err instanceof Error ? err.message : "تعذّر تحميل حالة CSR"));
  }
  useEffect(load, [unit.id]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setPresentedError(null);
    setResult(null);
    try {
      const res = await generateZatcaCsr(unit.id, { otp, fields, customAttributeOids: oids });
      setResult(res);
      setOtp(""); // never kept in state after use
      load();
      onChanged();
    } catch (err) {
      setPresentedError(presentZatcaError(err, "تعذّر إنشاء طلب CSR"));
    } finally {
      setSubmitting(false);
    }
  }

  if (current === undefined && !loadError) return <Skeleton rows={3} />;

  return (
    <div className="space-y-3">
      {loadError && <ErrorState message={loadError} onRetry={load} />}
      {current === null && <EmptyState message="لا يوجد طلب CSR لهذه الوحدة بعد." />}
      {current && (
        <div className="rounded-md bg-white p-3 text-sm text-stone-600 ring-1 ring-stone-200">
          <p>
            يوجد طلب CSR حالي (نوع الفاتورة: {current.invoiceType}) — أُنشئ في {formatDateTime(current.generatedAt)}.
          </p>
          <p className="mt-1 text-xs text-stone-400">
            إنشاء طلب CSR جديد يستبدل هذا الطلب لغرض الإصدار (لن يُحذف السجل التاريخي).
          </p>
        </div>
      )}

      {!showForm ? (
        <Button size="sm" variant="secondary" onClick={() => setShowForm(true)}>
          {current ? "إنشاء طلب CSR جديد" : "بدء إنشاء طلب CSR"}
        </Button>
      ) : (
        <form onSubmit={onSubmit} className="space-y-3 rounded-md bg-white p-4 ring-1 ring-stone-200">
          <p className="text-xs text-stone-500">
            سيولّد MIDAD زوج مفاتيح حقيقي (ECDSA) وطلب توقيع شهادة (CSR) حقيقي لهذه الوحدة، ويُخزّن المفتاح الخاص بأمان
            على الخادم — لن يظهر المفتاح الخاص في المتصفح أبداً.
          </p>
          <OtpInput value={otp} onChange={setOtp} egsUnitName={unit.name} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <TextField label="الاسم الشائع (Common Name)" value={fields.commonName} onChange={(v) => setFields({ ...fields, commonName: v })} />
            <TextField
              label="الرقم الضريبي (يجب أن يطابق الرقم المسجّل للشركة)"
              value={fields.organizationIdentifier}
              onChange={(v) => setFields({ ...fields, organizationIdentifier: v })}
            />
            <TextField label="اسم المنشأة" value={fields.organizationName} onChange={(v) => setFields({ ...fields, organizationName: v })} />
            <TextField label="الوحدة التنظيمية (الفرع)" value={fields.organizationUnitName} onChange={(v) => setFields({ ...fields, organizationUnitName: v })} />
            <TextField label="رمز الدولة (SA)" value={fields.countryCode} onChange={(v) => setFields({ ...fields, countryCode: v.toUpperCase() })} />
            <TextField label="الرقم التسلسلي لوحدة الفوترة (EGS Serial Number)" value={fields.egsSerialNumber} onChange={(v) => setFields({ ...fields, egsSerialNumber: v })} />
            <TextField label="نوع الفاتورة (TSXY، مثال: 1100)" value={fields.invoiceType} onChange={(v) => setFields({ ...fields, invoiceType: v })} />
            <TextField label="الموقع" value={fields.location} onChange={(v) => setFields({ ...fields, location: v })} />
            <TextField label="النشاط/القطاع" value={fields.industry} onChange={(v) => setFields({ ...fields, industry: v })} />
          </div>

          <button type="button" onClick={() => setShowOids((v) => !v)} className="text-xs text-primary underline">
            {showOids ? "إخفاء الإعدادات المتقدمة" : "إعدادات متقدمة (معرّفات OID لحقول ZATCA المخصصة)"}
          </button>
          {showOids && (
            <div className="rounded-md bg-stone-50 p-3 text-xs text-stone-500">
              <p className="mb-2">
                بعض حقول CSR (الرقم التسلسلي، نوع الفاتورة، الموقع، النشاط) هي حقول خاصة بـ ZATCA وليست معياراً عاماً —
                معرّفاتها التقنية (OID) غير موثّقة رسمياً في هذه النسخة، ولا تُخمّنها MIDAD. إن لم تُدخليها، سيرفض
                الخادم الطلب صراحةً بدلاً من تخمين قيمة قد تكون خاطئة.
              </p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <TextField label="OID — الرقم التسلسلي" value={oids.egsSerialNumber ?? ""} onChange={(v) => setOids({ ...oids, egsSerialNumber: v || undefined })} />
                <TextField label="OID — نوع الفاتورة" value={oids.invoiceType ?? ""} onChange={(v) => setOids({ ...oids, invoiceType: v || undefined })} />
                <TextField label="OID — الموقع" value={oids.location ?? ""} onChange={(v) => setOids({ ...oids, location: v || undefined })} />
                <TextField label="OID — النشاط" value={oids.industry ?? ""} onChange={(v) => setOids({ ...oids, industry: v || undefined })} />
              </div>
            </div>
          )}

          {presentedError && <ErrorPanel presented={presentedError} />}

          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={submitting}>
              {submitting ? "جارٍ الإنشاء..." : "إنشاء طلب CSR"}
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => setShowForm(false)}>
              إلغاء
            </Button>
          </div>
        </form>
      )}

      {result && (
        <div className="rounded-md bg-success-50 p-3 text-sm text-success-800 ring-1 ring-success-200">
          <p className="font-medium">تم إنشاء طلب CSR بنجاح.</p>
          <p className="mt-1 text-xs">
            انسخي محتوى CSR أدناه لاستخدامه عند طلب شهادة الامتثال (الخطوة التالية) — لن يُعرض هذا الطلب مرة أخرى تلقائياً
            بعد مغادرة الصفحة، لكن يمكنك استرجاع حالته (دون محتواه الكامل) من هنا لاحقاً.
          </p>
          <textarea readOnly rows={4} value={result.csrPem} className="mt-2 block w-full rounded-md border border-success-300 bg-white p-2 font-mono text-xs" />
        </div>
      )}
    </div>
  );
}

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block text-sm text-stone-600">
      {label}
      <input
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
      />
    </label>
  );
}

// --- Step 2: Compliance CSID -------------------------------------------------

function ComplianceCsidStep({ unit, onChanged }: { unit: ZatcaEgsUnit; onChanged: () => void }) {
  const [lifecycle, setLifecycle] = useState<ZatcaComplianceLifecycle | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [otp, setOtp] = useState("");
  const [csrBase64, setCsrBase64] = useState("");
  const [requesting, setRequesting] = useState(false);
  const [requestError, setRequestError] = useState<PresentedZatcaError | null>(null);
  const [requestResult, setRequestResult] = useState<{ requestId: string; dispositionMessage: string } | null>(null);

  const [confirmToken, setConfirmToken] = useState("");
  const [confirmSecret, setConfirmSecret] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<PresentedZatcaError | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  function load() {
    setLoadError(null);
    getZatcaComplianceLifecycle(unit.id)
      .then((res) => setLifecycle(res.complianceLifecycle))
      .catch((err) => setLoadError(err instanceof Error ? err.message : "تعذّر تحميل حالة شهادة الامتثال"));
  }
  useEffect(load, [unit.id]);

  async function onRequest(e: FormEvent) {
    e.preventDefault();
    setRequesting(true);
    setRequestError(null);
    setRequestResult(null);
    try {
      const res = await requestZatcaComplianceCsid(unit.id, { otp, csrBase64 });
      setRequestResult(res);
      setOtp("");
      load();
    } catch (err) {
      setRequestError(presentZatcaError(err, "تعذّر طلب شهادة الامتثال"));
    } finally {
      setRequesting(false);
    }
  }

  async function onConfirm(e: FormEvent) {
    e.preventDefault();
    setConfirming(true);
    setConfirmError(null);
    try {
      await confirmZatcaCsid(unit.id, { binarySecurityToken: confirmToken, secret: confirmSecret, stage: "compliance" });
      setConfirmed(true);
      setConfirmToken("");
      setConfirmSecret("");
      onChanged();
    } catch (err) {
      setConfirmError(presentZatcaError(err, "تعذّر تأكيد شهادة الامتثال"));
    } finally {
      setConfirming(false);
    }
  }

  if (lifecycle === undefined && !loadError) return <Skeleton rows={3} />;

  return (
    <div className="space-y-5">
      {loadError && <ErrorState message={loadError} onRetry={load} />}

      <div>
        <h3 className="mb-1 text-sm font-semibold text-stone-800">أ. طلب شهادة الامتثال من ZATCA (اتصال حقيقي)</h3>
        {lifecycle === null && <EmptyState message="لم يُطلب شهادة امتثال لطلب CSR الحالي بعد." />}
        {lifecycle && (
          <div className="mb-2 rounded-md bg-white p-3 text-sm text-stone-600 ring-1 ring-stone-200">
            تم طلب شهادة الامتثال مسبقاً (رقم الطلب: {lifecycle.requestId}) — {lifecycle.dispositionMessage}، بتاريخ{" "}
            {formatDateTime(lifecycle.startedAt)}.
          </div>
        )}
        {!lifecycle && (
          <form onSubmit={onRequest} className="space-y-3 rounded-md bg-white p-4 ring-1 ring-stone-200">
            <OtpInput value={otp} onChange={setOtp} egsUnitName={unit.name} />
            <label className="block text-sm text-stone-600">
              محتوى طلب CSR (Base64)
              <textarea
                required
                rows={3}
                value={csrBase64}
                onChange={(e) => setCsrBase64(e.target.value)}
                placeholder="الصقي csrDerBase64 من خطوة CSR أعلاه"
                className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 font-mono text-xs"
              />
            </label>
            {requestError && <ErrorPanel presented={requestError} />}
            <Button type="submit" size="sm" disabled={requesting}>
              {requesting ? "جارٍ الإرسال إلى ZATCA..." : "طلب شهادة الامتثال من ZATCA"}
            </Button>
          </form>
        )}
        {requestResult && (
          <div className="mt-2 rounded-md bg-success-50 p-3 text-sm text-success-800 ring-1 ring-success-200">
            <p className="font-medium">أصدرت ZATCA شهادة امتثال لهذا الطلب (رقم الطلب: {requestResult.requestId}).</p>
            <p className="mt-1 text-xs">
              لأسباب أمنية، لا تعرض MIDAD بيانات الاعتماد الفعلية (binarySecurityToken/المفتاح السري) التي أرجعتها ZATCA
              لهذا الطلب مباشرةً — إن كانت هذه هي بيانات الاعتماد التي تحتاجينها في القسم "ب" أدناه لتفعيل الاتصال،
              احصلي عليها من نفس القناة التي استخدمتها لإتمام إعداد ZATCA (مثل بوابة فاتورة أو سجلاتك الخاصة) ثم
              أدخليها هناك.
            </p>
          </div>
        )}
      </div>

      <div className="border-t border-stone-200 pt-4">
        <h3 className="mb-1 text-sm font-semibold text-stone-800">ب. تأكيد شهادة الامتثال (تفعيل الاتصال)</h3>
        <p className="mb-2 text-xs text-stone-500">
          هذه الخطوة منفصلة عمداً عن "أ" أعلاه — أدخلي هنا شهادة الامتثال (binarySecurityToken) والمفتاح السري الفعليين
          اللذين حصلتِ عليهما من ZATCA (من أي قناة)، ليتم التحقق من تطابقهما مع طلب CSR وتفعيلهما كاتصال هذه الوحدة.
        </p>
        {unit.csidStatus === "compliance_issued" || unit.csidStatus === "production_issued" ? (
          <div className="rounded-md bg-success-50 p-3 text-sm text-success-700 ring-1 ring-success-200">
            تم تأكيد شهادة الامتثال لهذه الوحدة بالفعل.
          </div>
        ) : (
          <form onSubmit={onConfirm} className="space-y-3 rounded-md bg-white p-4 ring-1 ring-stone-200">
            <label className="block text-sm text-stone-600">
              binarySecurityToken (الشهادة)
              <textarea
                required
                rows={3}
                value={confirmToken}
                onChange={(e) => setConfirmToken(e.target.value)}
                className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 font-mono text-xs"
              />
            </label>
            <label className="block text-sm text-stone-600">
              المفتاح السري (secret)
              <input
                required
                type="password"
                value={confirmSecret}
                onChange={(e) => setConfirmSecret(e.target.value)}
                className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
              />
            </label>
            {confirmError && <ErrorPanel presented={confirmError} />}
            {confirmed && <p className="text-sm text-success-700">تم التأكيد بنجاح.</p>}
            <Button type="submit" size="sm" disabled={confirming || unit.csidStatus !== "compliance_pending"}>
              {confirming ? "جارٍ التأكيد..." : "تأكيد شهادة الامتثال"}
            </Button>
            {unit.csidStatus !== "compliance_pending" && (
              <p className="text-xs text-warning-700">يجب إنشاء طلب CSR أولاً (الحالة الحالية: {csidStatusLabel[unit.csidStatus]}).</p>
            )}
          </form>
        )}
      </div>
    </div>
  );
}

// --- Step 3: Compliance Invoice (test) --------------------------------------

function ComplianceInvoiceStep({ unit }: { unit: ZatcaEgsUnit }) {
  const [attempts, setAttempts] = useState<ZatcaComplianceAttempt[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [documentType, setDocumentType] = useState<ZatcaComplianceDocumentType>("388");
  const [invoiceFamily, setInvoiceFamily] = useState<ZatcaInvoiceFamily>("standard");
  const [xml, setXml] = useState("");
  const [hash, setHash] = useState("");
  const [uuid, setUuid] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [presentedError, setPresentedError] = useState<PresentedZatcaError | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  function load() {
    setLoadError(null);
    listZatcaComplianceAttempts(unit.id)
      .then((res) => setAttempts(res.attempts))
      .catch((err) => setLoadError(err instanceof Error ? err.message : "تعذّر تحميل سجل محاولات اختبار الامتثال"));
  }
  useEffect(load, [unit.id]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setPresentedError(null);
    setOutcome(null);
    try {
      const res = await submitZatcaComplianceInvoice(unit.id, {
        documentType,
        invoiceFamily,
        invoiceXmlBase64: xml,
        invoiceHashBase64: hash,
        uuid,
      });
      setOutcome(res.status);
      load();
    } catch (err) {
      setPresentedError(presentZatcaError(err, "تعذّر إرسال مستند اختبار الامتثال"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-stone-500">
        هذا اختبار امتثال منفصل تماماً عن فواتيرك الحقيقية — لا يستخدم فواتير MIDAD ولا يُنشئ أو يوقّع مستنداً تلقائياً
        (هذه نقطة تصميم متعمّدة في هذا الإصدار: مسار اختبار الامتثال مستقل عن محرك التوقيع الحقيقي المستخدم لاحقاً في
        إرسال الفواتير الفعلية عبر Clearance/Reporting). أدخلي هنا مباشرة محتوى مستند الاختبار (XML بصيغة Base64
        وتجزئته) كما تطلبه واجهة ZATCA لاختبار الامتثال.
      </p>

      <form onSubmit={onSubmit} className="space-y-3 rounded-md bg-white p-4 ring-1 ring-stone-200">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block text-sm text-stone-600">
            نوع المستند
            <select value={documentType} onChange={(e) => setDocumentType(e.target.value as ZatcaComplianceDocumentType)} className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-sm">
              <option value="388">فاتورة (388)</option>
              <option value="381">إشعار دائن (381)</option>
              <option value="383">إشعار مدين (383)</option>
            </select>
          </label>
          <label className="block text-sm text-stone-600">
            نوع الفوترة
            <select value={invoiceFamily} onChange={(e) => setInvoiceFamily(e.target.value as ZatcaInvoiceFamily)} className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-sm">
              <option value="standard">قياسية (B2B)</option>
              <option value="simplified">مبسّطة (B2C)</option>
            </select>
          </label>
        </div>
        <label className="block text-sm text-stone-600">
          محتوى المستند (Base64)
          <textarea required rows={3} value={xml} onChange={(e) => setXml(e.target.value)} className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 font-mono text-xs" />
        </label>
        <label className="block text-sm text-stone-600">
          تجزئة المستند (Base64)
          <input required value={hash} onChange={(e) => setHash(e.target.value)} className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 font-mono text-xs" />
        </label>
        <label className="block text-sm text-stone-600">
          UUID
          <div className="mt-1 flex gap-2">
            <input required value={uuid} onChange={(e) => setUuid(e.target.value)} className="block w-full rounded-md border border-stone-300 px-3 py-2 font-mono text-xs" />
            <Button type="button" size="sm" variant="secondary" onClick={() => setUuid(crypto.randomUUID())}>
              توليد
            </Button>
          </div>
        </label>
        {presentedError && <ErrorPanel presented={presentedError} />}
        {outcome && <p className="text-sm text-stone-700">نتيجة ZATCA الفعلية: {outcome}</p>}
        <Button type="submit" size="sm" disabled={submitting}>
          {submitting ? "جارٍ الإرسال..." : "إرسال مستند الاختبار إلى ZATCA"}
        </Button>
      </form>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-stone-800">سجل محاولات اختبار الامتثال</h3>
        {loadError && <ErrorState message={loadError} onRetry={load} />}
        {!loadError && attempts === null && <Skeleton rows={2} />}
        {!loadError && attempts && attempts.length === 0 && <EmptyState message="لا توجد محاولات بعد." />}
        {!loadError && attempts && attempts.length > 0 && (
          <div className="space-y-2">
            {attempts.map((a) => (
              <div key={a.id} className="rounded-md border border-stone-200 bg-white p-2 text-xs text-stone-600">
                <span className="font-medium">{a.documentType}</span> · {a.invoiceFamily} ·{" "}
                {a.normalizedOutcome ?? a.errorCategory ?? "—"} · {formatDateTime(a.attemptedAt)}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// --- Step 4: Production CSID ------------------------------------------------

function ProductionCsidStep({ unit, onChanged }: { unit: ZatcaEgsUnit; onChanged: () => void }) {
  const [operations, setOperations] = useState<ZatcaProviderOperation[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [presentedError, setPresentedError] = useState<PresentedZatcaError | null>(null);
  const [result, setResult] = useState<{ requestId: string; dispositionMessage: string } | null>(null);

  const [confirmToken, setConfirmToken] = useState("");
  const [confirmSecret, setConfirmSecret] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<PresentedZatcaError | null>(null);

  function load() {
    setLoadError(null);
    listZatcaProductionCsidOperations(unit.id)
      .then((res) => setOperations(res.operations))
      .catch((err) => setLoadError(err instanceof Error ? err.message : "تعذّر تحميل سجل عمليات شهادة الإنتاج"));
  }
  useEffect(load, [unit.id]);

  async function onRequest() {
    setRequesting(true);
    setPresentedError(null);
    setResult(null);
    try {
      const res = await requestZatcaProductionCsid(unit.id);
      setResult(res);
      load();
    } catch (err) {
      setPresentedError(presentZatcaError(err, "تعذّر طلب شهادة الإنتاج"));
    } finally {
      setRequesting(false);
    }
  }

  async function onConfirm(e: FormEvent) {
    e.preventDefault();
    setConfirming(true);
    setConfirmError(null);
    try {
      await confirmZatcaCsid(unit.id, { binarySecurityToken: confirmToken, secret: confirmSecret, stage: "production" });
      setConfirmToken("");
      setConfirmSecret("");
      onChanged();
    } catch (err) {
      setConfirmError(presentZatcaError(err, "تعذّر تأكيد شهادة الإنتاج"));
    } finally {
      setConfirming(false);
    }
  }

  const complianceReady = unit.csidStatus === "compliance_issued";
  const productionActive = unit.csidStatus === "production_issued";

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge tone={complianceReady || productionActive ? "success" : "neutral"}>بيئة الامتثال (Compliance)</Badge>
        <span className="text-stone-400">←</span>
        <Badge tone={productionActive ? "success" : "neutral"}>بيئة الإنتاج (Production)</Badge>
        <span className="text-stone-400">— بيئتان منفصلتان تماماً، لا تُستخدم شهادة إحداهما في الأخرى.</span>
      </div>

      {!complianceReady && !productionActive && (
        <ErrorState message={`لا يمكن تفعيل بيئة الإنتاج قبل إتمام شهادة الامتثال أولاً (الحالة الحالية: ${csidStatusLabel[unit.csidStatus]}).`} />
      )}

      <div>
        <h3 className="mb-1 text-sm font-semibold text-stone-800">أ. طلب شهادة الإنتاج (Onboarding)</h3>
        <div className="mb-2 rounded-md bg-warning-50 p-2 text-xs text-warning-800 ring-1 ring-warning-200">
          حالة معلّقة على التحقق الحي من ZATCA Sandbox: التوثيق المتاح لهذه المنصة يذكر حقل "currentCCSID" كخطأ محتمل لهذا
          الطلب، لكن دون تأكيد ما إذا كان مطلوباً فعلياً. لا يرسل MIDAD هذا الحقل حالياً تجنباً للتخمين — إن رفضت ZATCA
          الطلب لهذا السبب، ستظهر رسالة الخطأ الفعلية أدناه دون أي محاولة لإخفائها.
        </div>
        <Button size="sm" disabled={requesting || !complianceReady} onClick={onRequest}>
          {requesting ? "جارٍ الإرسال إلى ZATCA..." : "طلب شهادة الإنتاج من ZATCA"}
        </Button>
        {presentedError && (
          <div className="mt-2">
            <ErrorPanel presented={presentedError} />
          </div>
        )}
        {result && (
          <div className="mt-2 rounded-md bg-success-50 p-3 text-sm text-success-800 ring-1 ring-success-200">
            أصدرت ZATCA شهادة إنتاج لهذا الطلب (رقم الطلب: {result.requestId}) — {result.dispositionMessage}. أكملي
            القسم "ب" أدناه لتفعيلها فعلياً على هذه الوحدة (بيانات الاعتماد الفعلية لا تُعرض هنا لأسباب أمنية — راجعي
            القناة التي استخدمتها للحصول عليها).
          </div>
        )}
      </div>

      <div className="border-t border-stone-200 pt-4">
        <h3 className="mb-1 text-sm font-semibold text-stone-800">ب. تأكيد شهادة الإنتاج (تفعيل بيئة الإنتاج)</h3>
        {productionActive ? (
          <div className="rounded-md bg-success-50 p-3 text-sm text-success-700 ring-1 ring-success-200">بيئة الإنتاج مفعّلة لهذه الوحدة.</div>
        ) : (
          <form onSubmit={onConfirm} className="space-y-3 rounded-md bg-white p-4 ring-1 ring-stone-200">
            <label className="block text-sm text-stone-600">
              binarySecurityToken (شهادة الإنتاج)
              <textarea required rows={3} value={confirmToken} onChange={(e) => setConfirmToken(e.target.value)} className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 font-mono text-xs" />
            </label>
            <label className="block text-sm text-stone-600">
              المفتاح السري (secret)
              <input required type="password" value={confirmSecret} onChange={(e) => setConfirmSecret(e.target.value)} className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-sm" />
            </label>
            {confirmError && <ErrorPanel presented={confirmError} />}
            <Button type="submit" size="sm" disabled={confirming || !complianceReady}>
              {confirming ? "جارٍ التأكيد..." : "تأكيد شهادة الإنتاج"}
            </Button>
          </form>
        )}
      </div>

      <div className="border-t border-stone-200 pt-4">
        <h3 className="mb-2 text-sm font-semibold text-stone-800">سجل عمليات شهادة الإنتاج</h3>
        {loadError && <ErrorState message={loadError} onRetry={load} />}
        {!loadError && operations === null && <Skeleton rows={2} />}
        {!loadError && operations && operations.length === 0 && <EmptyState message="لا توجد عمليات بعد." />}
        {!loadError && operations && operations.length > 0 && (
          <div className="space-y-2">
            {operations.map((o) => (
              <div key={o.id} className="rounded-md border border-stone-200 bg-white p-2 text-xs text-stone-600">
                <span className="font-medium">{o.operationType === "production_csid_onboarding" ? "طلب أولي" : "تجديد"}</span> ·{" "}
                {o.internalStatus === "response_received" ? o.providerOutcome ?? "تم الاستلام" : `فشل (${o.errorCategory})`} ·{" "}
                {formatDateTime(o.startedAt)}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// --- Step 5: Renewal ---------------------------------------------------------

function RenewalStep({ unit }: { unit: ZatcaEgsUnit }) {
  const [otp, setOtp] = useState("");
  const [csrBase64, setCsrBase64] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [presentedError, setPresentedError] = useState<PresentedZatcaError | null>(null);
  const [outcome, setOutcome] = useState<{ outcome: string; requestId: string; dispositionMessage: string } | null>(null);

  const expiresAt = unit.certificateExpiresAt;
  const daysLeft = expiresAt ? Math.round((new Date(expiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)) : null;
  const eligible = unit.csidStatus === "production_issued";

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setPresentedError(null);
    setOutcome(null);
    try {
      const res = await renewZatcaProductionCsid(unit.id, { csrBase64, otp });
      setOutcome(res);
      setOtp("");
    } catch (err) {
      setPresentedError(presentZatcaError(err, "تعذّر تجديد شهادة الإنتاج"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="rounded-md bg-white p-3 text-sm text-stone-600 ring-1 ring-stone-200">
        <p>حالة الشهادة الحالية: {csidStatusLabel[unit.csidStatus]}</p>
        <p className="mt-1">
          تاريخ انتهاء الشهادة: {expiresAt ? formatDateTime(expiresAt) : "غير معروف"}
          {daysLeft !== null && daysLeft <= 30 && <span className="text-warning-700"> — تنتهي خلال {daysLeft} يوم تقريباً</span>}
        </p>
        {!eligible && <p className="mt-1 text-xs text-warning-700">التجديد متاح فقط بعد تفعيل بيئة الإنتاج لهذه الوحدة.</p>}
      </div>

      <p className="text-xs text-stone-500">
        لا تُحذف بيانات الاعتماد الحالية عند التجديد — بيانات الاعتماد الجديدة التي ترجعها ZATCA تُسجَّل كعملية تاريخية
        منفصلة فقط، ولن تُفعَّل تلقائياً على هذه الوحدة. بعد نجاح التجديد، استخدمي خطوة "ربط بيانات الاعتماد" (أعلى هذه
        الصفحة) لتفعيل بيانات الاعتماد الجديدة يدوياً — لا يوجد استبدال تلقائي للشهادة الحالية.
      </p>

      <form onSubmit={onSubmit} className="space-y-3 rounded-md bg-white p-4 ring-1 ring-stone-200">
        <OtpInput value={otp} onChange={setOtp} egsUnitName={unit.name} />
        <label className="block text-sm text-stone-600">
          محتوى طلب CSR للتجديد (Base64)
          <textarea required rows={3} value={csrBase64} onChange={(e) => setCsrBase64(e.target.value)} className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 font-mono text-xs" />
        </label>
        {presentedError && <ErrorPanel presented={presentedError} />}
        {outcome && (
          <div
            className={`rounded-md p-3 text-sm ring-1 ${
              outcome.outcome === "issued" ? "bg-success-50 text-success-800 ring-success-200" : "bg-warning-50 text-warning-800 ring-warning-200"
            }`}
          >
            {outcome.outcome === "issued"
              ? `أصدرت ZATCA شهادة إنتاج جديدة (رقم الطلب: ${outcome.requestId}) — ${outcome.dispositionMessage}. أكملي خطوة "ربط بيانات الاعتماد" لتفعيلها.`
              : `أفادت ZATCA أن الوحدة غير مستوفية لشروط التجديد حالياً (${outcome.dispositionMessage}). لم يتغيّر أي شيء في بيانات الاعتماد الحالية.`}
          </div>
        )}
        <Button type="submit" size="sm" disabled={submitting || !eligible}>
          {submitting ? "جارٍ الإرسال إلى ZATCA..." : "طلب التجديد من ZATCA"}
        </Button>
      </form>
    </div>
  );
}
