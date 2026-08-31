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
import {
  getZatcaConfig,
  updateZatcaIdentity,
  createZatcaEgsUnit,
  deactivateZatcaEgsUnit,
  configureZatcaCredential,
  clearZatcaCredential,
  verifyZatcaConnection,
} from "../api/zatca";
import { ApiError } from "../api/client";
import type { ZatcaConfig, ZatcaEgsUnit, ZatcaEnvironment, ZatcaVerifyConnectionResult } from "../api/types";

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

export function ZatcaSettings() {
  const [config, setConfig] = useState<ZatcaConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  async function load() {
    setError(null);
    try {
      setConfig(await getZatcaConfig());
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
  if (error || !config) {
    return (
      <Layout>
        <PageHeader title="الفوترة الإلكترونية (ZATCA)" subtitle="ربط شركتك بمنصة فاتورة السعودية للفوترة الإلكترونية." />
        <ErrorState message={error ?? "تعذّر تحميل البيانات"} onRetry={load} />
      </Layout>
    );
  }

  return (
    <Layout>
      <PageHeader title="الفوترة الإلكترونية (ZATCA)" subtitle="ربط شركتك بمنصة فاتورة السعودية للفوترة الإلكترونية." />
      <div className="space-y-5">
        <IdentityCard identity={config.identity} onSaved={load} />
        <EgsUnitsCard units={config.egsUnits} onChanged={load} />
      </div>
    </Layout>
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

function EgsUnitsCard({ units, onChanged }: { units: ZatcaEgsUnit[]; onChanged: () => void }) {
  const [showCreate, setShowCreate] = useState(false);

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-stone-800">٢. وحدات الفوترة الإلكترونية (EGS)</h2>
          <p className="mt-1 text-sm text-stone-500">اختاري بيئة المحاكاة أولاً، ثم أكملي الإعداد الخارجي مع ZATCA وأدخلي بيانات الاعتماد الناتجة.</p>
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
            <EgsUnitRow key={unit.id} unit={unit} onChanged={onChanged} />
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

function EgsUnitRow({ unit, onChanged }: { unit: ZatcaEgsUnit; onChanged: () => void }) {
  const [showCredential, setShowCredential] = useState(false);
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
          </Can>
          {unit.status !== "deactivated" && (
            <Button size="sm" variant="secondary" onClick={onDeactivate}>
              تعطيل الوحدة
            </Button>
          )}
        </div>
      </Can>

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
