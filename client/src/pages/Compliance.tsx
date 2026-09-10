import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Layout } from "../components/Layout";
import { PageHeader } from "../ui/PageHeader";
import { Card } from "../ui/Card";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { ErrorState } from "../ui/ErrorState";
import { EmptyState } from "../ui/EmptyState";
import { Skeleton } from "../ui/Skeleton";
import { Table } from "../ui/Table";
import { Modal } from "../ui/Modal";
import { Tabs, type TabItem } from "../ui/Tabs";
import { Can } from "../auth/Can";
import { formatDate, formatDateTime, formatPercent } from "../lib/format";
import {
  getCountries,
  getProfile,
  setProfile,
  getRules,
  getStatus,
  listOverrides,
  createOverride,
  resetOverride,
  listOverrideHistory,
  listHistory,
  getOverridableSettings,
} from "../api/compliance";
import { ApiError } from "../api/client";
import type {
  ComplianceAuditEvent,
  ComplianceCountry,
  ComplianceOverride,
  ComplianceProfile,
  ComplianceRulesResponse,
  ComplianceStatus,
  CreateOverrideResult,
} from "../api/types";

// MIDAD Phase 4 — Compliance / Tax Center. A company-level page (like
// Settings/Team/Suppliers, NOT a project section) that is purely a
// frontend consumer of the already-live, already-tested compliance
// backend (server/src/routes/compliance.ts + server/src/lib/compliance/**
// — see server/tests/compliance.test.ts / taxEngineP0.test.ts). This page
// never calculates tax, never derives compliance status, never infers a
// rule's effective date or precedence, and never invents a warning — every
// value shown here is exactly what the backend returned. The one generic,
// non-domain-specific mechanism this page uses is a dotted-path JSON
// lookup (getValueAtPath below) purely to decide which input widget an
// override's value needs (boolean vs. text) — it encodes no tax rule.

const overrideKeyLabel = (key: string) => key; // raw backend key, never relabeled with invented meaning

function getValueAtPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc && typeof acc === "object" && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

function displayLocalized(label: Partial<Record<"ar" | "fr" | "en", string>> | undefined, fallback: string): string {
  if (!label) return fallback;
  return label.ar ?? label.en ?? label.fr ?? fallback;
}

// Renders a JSONB setting value (number | boolean | string) honestly,
// without assuming it is a percentage — only the known ComplianceRules.vat
// fields (a typed, backend-documented shape) are ever formatted with
// formatPercent below.
function renderRawValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "نعم" : "لا";
  if (value === null || value === undefined) return "—";
  return String(value);
}

const TABS: TabItem[] = [
  { key: "profile", label: "الملف الضريبي" },
  { key: "status", label: "الحالة" },
  { key: "rules", label: "القواعد المطبّقة" },
  { key: "overrides", label: "الاستثناءات" },
  { key: "history", label: "السجل" },
];

export function Compliance() {
  const [activeTab, setActiveTab] = useState("profile");

  const [profile, setProfileState] = useState<ComplianceProfile | null>(null);
  const [status, setStatus] = useState<ComplianceStatus | null>(null);
  const [rules, setRules] = useState<ComplianceRulesResponse | null>(null);
  const [overrides, setOverrides] = useState<ComplianceOverride[] | null>(null);
  const [overrideHistory, setOverrideHistory] = useState<ComplianceOverride[] | null>(null);
  const [history, setHistory] = useState<ComplianceAuditEvent[] | null>(null);
  const [countries, setCountries] = useState<ComplianceCountry[] | null>(null);
  const [overridableKeys, setOverridableKeys] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  async function load() {
    setError(null);
    try {
      const [statusRes, rulesRes, overridesRes, overrideHistoryRes, historyRes, countriesRes, overridableRes] = await Promise.all([
        getStatus(),
        getRules(),
        listOverrides(),
        listOverrideHistory(),
        listHistory(),
        getCountries(),
        getOverridableSettings(),
      ]);
      setStatus(statusRes);
      setRules(rulesRes);
      setOverrides(overridesRes);
      setOverrideHistory(overrideHistoryRes);
      setHistory(historyRes);
      setCountries(countriesRes);
      setOverridableKeys(overridableRes);

      if (statusRes.status !== "not_configured") {
        try {
          setProfileState(await getProfile());
        } catch {
          // Status said configured but the profile fetch itself failed —
          // treat as "unknown", not as "not configured" (never fabricate).
          setProfileState(null);
        }
      } else {
        setProfileState(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذّر تحميل بيانات الامتثال الضريبي");
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
        <PageHeader title="الامتثال الضريبي" subtitle="إعداد الدولة، القواعد الضريبية المطبّقة، والاستثناءات." />
        <Skeleton rows={6} />
      </Layout>
    );
  }

  if (error) {
    return (
      <Layout>
        <PageHeader title="الامتثال الضريبي" subtitle="إعداد الدولة، القواعد الضريبية المطبّقة، والاستثناءات." />
        <ErrorState message={error} onRetry={load} />
      </Layout>
    );
  }

  const notConfigured = status?.status === "not_configured";

  return (
    <Layout>
      <PageHeader title="الامتثال الضريبي" subtitle="إعداد الدولة، القواعد الضريبية المطبّقة، والاستثناءات." />

      {/* Tabs.tsx's own flex row has no wrap/scroll of its own — with 5
          Arabic labels it exceeds a 390px viewport unless the row itself
          scrolls horizontally within its own bounds, so this wrapper (not
          the shared component) owns that behavior. */}
      <div className="mb-5 overflow-x-auto">
        <Tabs items={TABS} active={activeTab} onChange={setActiveTab} />
      </div>

      {activeTab === "profile" && (
        <ProfileTab
          profile={profile}
          notConfigured={notConfigured}
          countries={countries}
          onSaved={load}
        />
      )}
      {activeTab === "status" && <StatusTab status={status} />}
      {activeTab === "rules" && <RulesTab rules={rules} />}
      {activeTab === "overrides" && (
        <OverridesTab
          overrides={overrides}
          overridableKeys={overridableKeys}
          rules={rules}
          notConfigured={notConfigured}
          onChanged={load}
        />
      )}
      {activeTab === "history" && <HistoryTab overrideHistory={overrideHistory} history={history} />}
    </Layout>
  );
}

// --- Profile / Onboarding ---------------------------------------------

function ProfileTab({
  profile,
  notConfigured,
  countries,
  onSaved,
}: {
  profile: ComplianceProfile | null;
  notConfigured: boolean;
  countries: ComplianceCountry[] | null;
  onSaved: () => void;
}) {
  if (notConfigured) {
    return (
      <Card className="p-5">
        <h2 className="mb-2 font-semibold text-stone-800">لم يتم إعداد ملف الامتثال الضريبي لهذه الشركة بعد</h2>
        <p className="mb-4 text-sm text-stone-500">
          اختاري دولة التشغيل لتفعيل القواعد الضريبية الرسمية المعتمدة تلقائياً — لا حاجة لإدخال أي نسب يدوياً.
        </p>
        <Can permission="compliance.manage">
          <OnboardingForm countries={countries} onSaved={onSaved} />
        </Can>
      </Card>
    );
  }

  if (!profile) return <Skeleton rows={4} />;

  return (
    <Card className="p-5">
      <dl className="grid grid-cols-1 gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
        <Field label="رمز الدولة" value={profile.countryCode} />
        <Field label="الحالة" value={<Badge tone={profile.status === "configured" ? "success" : "warning"}>{profile.status}</Badge>} />
        <Field label="نوع الكيان القانوني" value={profile.legalEntityType ?? "—"} />
        <Field label="نشاط الأعمال" value={profile.businessActivity ?? "—"} />
        <Field label="حالة التسجيل الضريبي" value={profile.taxRegistrationStatus ?? "—"} />
        <Field label="آخر تحديث" value={formatDateTime(profile.updatedAt)} />
      </dl>

      <Can permission="compliance.manage">
        <div className="mt-6 border-t border-stone-100 pt-5">
          <h3 className="mb-3 font-semibold text-stone-700">تغيير الدولة</h3>
          <OnboardingForm countries={countries} onSaved={onSaved} initial={profile} />
        </div>
      </Can>
    </Card>
  );
}

function OnboardingForm({
  countries,
  onSaved,
  initial,
}: {
  countries: ComplianceCountry[] | null;
  onSaved: () => void;
  initial?: ComplianceProfile;
}) {
  const [countryCode, setCountryCode] = useState(initial?.countryCode ?? countries?.[0]?.countryCode ?? "");
  const [legalEntityType, setLegalEntityType] = useState(initial?.legalEntityType ?? "");
  const [businessActivity, setBusinessActivity] = useState(initial?.businessActivity ?? "");
  const [taxRegistrationStatus, setTaxRegistrationStatus] = useState(initial?.taxRegistrationStatus ?? "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!countryCode) return;
    setError(null);
    setSubmitting(true);
    try {
      await setProfile({
        countryCode,
        legalEntityType: legalEntityType || undefined,
        businessActivity: businessActivity || undefined,
        taxRegistrationStatus: taxRegistrationStatus || undefined,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر حفظ الملف الضريبي");
    } finally {
      setSubmitting(false);
    }
  }

  if (!countries) return <Skeleton rows={3} />;

  return (
    <form onSubmit={onSubmit} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {error && (
        <div className="sm:col-span-2">
          <ErrorState message={error} />
        </div>
      )}
      <label className="text-sm text-stone-600 sm:col-span-2">
        الدولة
        <select
          required
          value={countryCode}
          onChange={(e) => setCountryCode(e.target.value)}
          className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
        >
          {countries.length === 0 && <option value="">لا توجد دول مدعومة حالياً</option>}
          {countries.map((c) => (
            <option key={c.countryCode} value={c.countryCode}>
              {displayLocalized(c.displayName, c.countryCode)}
            </option>
          ))}
        </select>
      </label>
      <input
        placeholder="نوع الكيان القانوني (اختياري)"
        value={legalEntityType}
        onChange={(e) => setLegalEntityType(e.target.value)}
        className="rounded-md border border-stone-300 px-3 py-2 text-sm"
      />
      <input
        placeholder="نشاط الأعمال (اختياري)"
        value={businessActivity}
        onChange={(e) => setBusinessActivity(e.target.value)}
        className="rounded-md border border-stone-300 px-3 py-2 text-sm"
      />
      <input
        placeholder="حالة التسجيل الضريبي (اختياري)"
        value={taxRegistrationStatus}
        onChange={(e) => setTaxRegistrationStatus(e.target.value)}
        className="rounded-md border border-stone-300 px-3 py-2 text-sm sm:col-span-2"
      />
      <Button type="submit" disabled={submitting || !countryCode} className="sm:col-span-2">
        {submitting ? "جارٍ الحفظ..." : initial ? "حفظ التغيير" : "تفعيل الامتثال الضريبي"}
      </Button>
    </form>
  );
}

// --- Status --------------------------------------------------------------

function StatusTab({ status }: { status: ComplianceStatus | null }) {
  if (!status) return <Skeleton rows={4} />;

  if (status.status === "not_configured") {
    return <EmptyState message="لا توجد حالة امتثال بعد — أكملي إعداد الملف الضريبي أولاً من تبويب «الملف الضريبي»." />;
  }

  return (
    <Card className="p-5">
      <dl className="grid grid-cols-1 gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
        <Field label="الحالة" value={<Badge tone={status.status === "configured" ? "success" : "warning"}>{status.status}</Badge>} />
        <Field label="رمز الدولة" value={status.countryCode} />
        <Field label="نسخة القواعد النشطة" value={status.ruleVersion ?? "—"} />
        <Field label="عدد الاستثناءات النشطة" value={String(status.overrideCount)} />
        <Field label="آخر تحديث" value={formatDateTime(status.lastUpdate)} />
      </dl>

      <div className="mt-5 border-t border-stone-100 pt-4">
        <h3 className="mb-2 font-semibold text-stone-700">حالة الزكاة</h3>
        {status.zakat.status === "review_required" ? (
          <p className="text-sm text-warning-700">قيد المراجعة — {status.zakat.reason}</p>
        ) : (
          <dl className="grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
            <Field label="سارية" value={status.zakat.applicable ? "نعم" : "لا"} />
            <Field label="تتطلب مراجعة" value={status.zakat.reviewRequired ? "نعم" : "لا"} />
            {status.zakat.notes && <Field label="ملاحظات" value={status.zakat.notes} />}
          </dl>
        )}
      </div>
    </Card>
  );
}

// --- Rules (read-only viewer) --------------------------------------------

function RulesTab({ rules }: { rules: ComplianceRulesResponse | null }) {
  if (!rules) return <Skeleton rows={4} />;

  if (rules.status === "review_required") {
    return <EmptyState message={`القواعد قيد المراجعة — ${rules.reason}`} />;
  }

  const r = rules.rules;
  return (
    <div className="space-y-4">
      <Card className="p-5">
        <h3 className="mb-3 font-semibold text-stone-700">ضريبة القيمة المضافة</h3>
        <dl className="grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
          <Field label="سارية" value={r.vat.applicable ? "نعم" : "لا"} />
          <Field label="النسبة القياسية" value={formatPercent(r.vat.standardRatePercent)} />
        </dl>
        {r.vat.categories.length > 0 && (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-stone-200 text-right text-stone-500">
                  <th className="py-1.5">الفئة</th>
                  <th className="py-1.5">النسبة</th>
                </tr>
              </thead>
              <tbody>
                {r.vat.categories.map((c) => (
                  <tr key={c.code} className="border-b border-stone-100">
                    <td className="py-1.5">{displayLocalized(c.label, c.code)}</td>
                    <td className="py-1.5">{c.ratePercent !== null ? formatPercent(c.ratePercent) : "متغيّرة"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="p-5">
        <h3 className="mb-3 font-semibold text-stone-700">الاستقطاع الضريبي (Withholding)</h3>
        <Field label="سارٍ" value={r.withholding.applicable ? "نعم" : "لا"} />
        {r.withholding.rules.length > 0 && (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-stone-200 text-right text-stone-500">
                  <th className="py-1.5">نوع المورّد</th>
                  <th className="py-1.5">فئة الخدمة</th>
                  <th className="py-1.5">النسبة</th>
                </tr>
              </thead>
              <tbody>
                {r.withholding.rules.map((w, i) => (
                  <tr key={i} className="border-b border-stone-100">
                    <td className="py-1.5">{w.vendorType}</td>
                    <td className="py-1.5">{w.serviceCategory ?? "—"}</td>
                    <td className="py-1.5">{formatPercent(w.ratePercent)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="p-5">
        <h3 className="mb-3 font-semibold text-stone-700">الفوترة الإلكترونية والمتطلبات</h3>
        <dl className="grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
          <Field label="مطلوبة" value={r.eInvoicing.required ? "نعم" : "لا"} />
          <Field label="المعيار" value={r.eInvoicing.profile ?? "—"} />
          <Field label="ثنائية اللغة مطلوبة" value={r.invoice.bilingualRequired ? "نعم" : "لا"} />
          <Field label="العملة" value={r.localization.currency} />
        </dl>
        {r.invoice.requiredFields.length > 0 && (
          <p className="mt-3 text-sm text-stone-600">الحقول المطلوبة في الفاتورة: {r.invoice.requiredFields.join("، ")}</p>
        )}
        {r.identifiers.length > 0 && (
          <ul className="mt-3 list-inside list-disc text-sm text-stone-600">
            {r.identifiers.map((id) => (
              <li key={id.type}>
                {displayLocalized(id.label, id.type)} {id.required ? "(مطلوب)" : "(اختياري)"}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

// --- Overrides -------------------------------------------------------------

const overrideStatusTone = { active: "info", reset: "neutral" } as const;

function OverridesTab({
  overrides,
  overridableKeys,
  rules,
  notConfigured,
  onChanged,
}: {
  overrides: ComplianceOverride[] | null;
  overridableKeys: string[] | null;
  rules: ComplianceRulesResponse | null;
  notConfigured: boolean;
  onChanged: () => void;
}) {
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resettingId, setResettingId] = useState<string | null>(null);

  async function onReset(id: string) {
    if (resettingId) return;
    setResettingId(id);
    setError(null);
    try {
      await resetOverride(id);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر إعادة تعيين الاستثناء");
    } finally {
      setResettingId(null);
    }
  }

  return (
    <div className="space-y-4">
      {error && <ErrorState message={error} />}

      <Can permission="compliance.manage">
        <div className="flex justify-end">
          {notConfigured ? (
            <p className="text-sm text-stone-500">أكملي إعداد الملف الضريبي أولاً قبل إنشاء استثناء.</p>
          ) : (
            <Button size="sm" onClick={() => setShowCreate((v) => !v)}>
              {showCreate ? "إلغاء" : "+ استثناء جديد"}
            </Button>
          )}
        </div>
        {showCreate && !notConfigured && (
          <CreateOverrideForm
            overridableKeys={overridableKeys}
            rules={rules}
            onDone={() => {
              setShowCreate(false);
              onChanged();
            }}
          />
        )}
      </Can>

      {!overrides ? (
        <Skeleton rows={3} />
      ) : overrides.length === 0 ? (
        <EmptyState message="لا توجد استثناءات نشطة حالياً — القيم الرسمية للدولة مطبّقة كما هي." />
      ) : (
        <Table>
          <thead>
            <tr className="border-b border-stone-200 text-right text-stone-500">
              <th className="px-4 py-2">الإعداد</th>
              <th className="px-4 py-2">القيمة الحالية</th>
              <th className="px-4 py-2">القيمة الرسمية عند الإنشاء</th>
              <th className="px-4 py-2">سارٍ من</th>
              <th className="px-4 py-2">الحالة</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {overrides.map((o) => (
              <tr key={o.id} className="border-b border-stone-100">
                <td className="px-4 py-2">{overrideKeyLabel(o.settingKey)}</td>
                <td className="px-4 py-2">{renderRawValue(o.overrideValue)}</td>
                <td className="px-4 py-2">{renderRawValue(o.officialDefaultSnapshot)}</td>
                <td className="px-4 py-2">{formatDate(o.effectiveFrom)}</td>
                <td className="px-4 py-2">
                  <Badge tone={overrideStatusTone[o.status]}>{o.status}</Badge>
                </td>
                <td className="px-4 py-2">
                  <Can permission="compliance.manage">
                    <button
                      type="button"
                      onClick={() => onReset(o.id)}
                      disabled={resettingId === o.id}
                      className="text-sm text-primary hover:underline disabled:text-stone-400"
                    >
                      {resettingId === o.id ? "جارٍ إعادة التعيين..." : "إعادة تعيين"}
                    </button>
                  </Can>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}

type PendingConfirmation = {
  settingKey: string;
  value: unknown;
  effectiveFrom: string;
  effectiveTo?: string;
  reason?: string;
  warning: string;
  officialDefault: unknown;
};

function CreateOverrideForm({
  overridableKeys,
  rules,
  onDone,
}: {
  overridableKeys: string[] | null;
  rules: ComplianceRulesResponse | null;
  onDone: () => void;
}) {
  const [settingKey, setSettingKey] = useState(overridableKeys?.[0] ?? "");
  const [rawValue, setRawValue] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [effectiveTo, setEffectiveTo] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pending, setPending] = useState<PendingConfirmation | null>(null);

  // Purely a display/input-widget decision (boolean vs. text) — a generic
  // property-path read of the already-fetched rules snapshot, never a
  // second calculation of the rule itself. See getValueAtPath's own
  // comment above.
  const currentValueForKey =
    rules && rules.status === "resolved" ? getValueAtPath(rules.rules, settingKey) : undefined;
  const isBooleanSetting = typeof currentValueForKey === "boolean";

  function coerceValue(): unknown {
    if (isBooleanSetting) return rawValue === "true";
    const n = Number(rawValue);
    return rawValue !== "" && Number.isFinite(n) ? n : rawValue;
  }

  async function submit(confirmed: boolean) {
    setError(null);
    setSubmitting(true);
    try {
      const input = {
        settingKey,
        value: confirmed && pending ? pending.value : coerceValue(),
        effectiveFrom: confirmed && pending ? pending.effectiveFrom : effectiveFrom,
        effectiveTo: (confirmed && pending ? pending.effectiveTo : effectiveTo) || undefined,
        reason: (confirmed && pending ? pending.reason : reason) || undefined,
        confirmed,
      };
      const result: CreateOverrideResult = await createOverride(input);
      if (result.status === "confirmation_required") {
        setPending({
          settingKey: input.settingKey,
          value: input.value,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: input.effectiveTo,
          reason: input.reason,
          warning: result.warning,
          officialDefault: result.officialDefault,
        });
      } else {
        setPending(null);
        onDone();
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر إنشاء الاستثناء");
      setPending(null);
    } finally {
      setSubmitting(false);
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    // Never automatically confirmed — the first submission always goes
    // through with confirmed:false so the server's own deviation check
    // runs; only the explicit "confirm" action in the dialog below sends
    // confirmed:true.
    await submit(false);
  }

  return (
    <Card className="p-4">
      <form onSubmit={onSubmit} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {error && (
          <div className="sm:col-span-2">
            <ErrorState message={error} />
          </div>
        )}
        <label className="text-sm text-stone-600">
          الإعداد
          <select
            required
            value={settingKey}
            onChange={(e) => setSettingKey(e.target.value)}
            className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
          >
            {(overridableKeys ?? []).length === 0 && <option value="">لا توجد إعدادات قابلة للاستثناء</option>}
            {(overridableKeys ?? []).map((k) => (
              <option key={k} value={k}>
                {overrideKeyLabel(k)}
              </option>
            ))}
          </select>
        </label>

        {isBooleanSetting ? (
          <label className="text-sm text-stone-600">
            القيمة الجديدة
            <select
              required
              value={rawValue}
              onChange={(e) => setRawValue(e.target.value)}
              className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
            >
              <option value="">اختاري القيمة</option>
              <option value="true">نعم</option>
              <option value="false">لا</option>
            </select>
          </label>
        ) : (
          <label className="text-sm text-stone-600">
            القيمة الجديدة
            <input
              required
              value={rawValue}
              onChange={(e) => setRawValue(e.target.value)}
              className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
            />
          </label>
        )}

        <label className="text-sm text-stone-600">
          سارٍ من
          <input
            required
            type="date"
            value={effectiveFrom}
            onChange={(e) => setEffectiveFrom(e.target.value)}
            className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="text-sm text-stone-600">
          سارٍ حتى (اختياري)
          <input
            type="date"
            value={effectiveTo}
            onChange={(e) => setEffectiveTo(e.target.value)}
            className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
          />
        </label>
        <input
          placeholder="سبب الاستثناء (اختياري)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm sm:col-span-2"
        />

        <Button type="submit" disabled={submitting || !settingKey} className="sm:col-span-2">
          {submitting ? "جارٍ الإرسال..." : "إرسال الاستثناء"}
        </Button>
      </form>

      {/* Two-step confirmation — matches server/src/routes/compliance.ts's
          significantDeviationWarning contract exactly: the server's own
          warning text and officialDefault are shown verbatim, never
          reworded, and the resend only fires on this explicit click. */}
      <Modal open={pending !== null} onClose={() => setPending(null)} title="تأكيد الانحراف عن القيمة الرسمية">
        {pending && (
          <div className="space-y-3">
            <p className="text-sm text-stone-700">{pending.warning}</p>
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <Field label="القيمة الرسمية" value={renderRawValue(pending.officialDefault)} />
              <Field label="القيمة المطلوبة" value={renderRawValue(pending.value)} />
            </dl>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" size="sm" onClick={() => setPending(null)}>
                إلغاء
              </Button>
              <Button size="sm" disabled={submitting} onClick={() => submit(true)}>
                {submitting ? "جارٍ التأكيد..." : "تأكيد المتابعة"}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </Card>
  );
}

// --- History (two distinct, never-merged lists) ---------------------------

function HistoryTab({
  overrideHistory,
  history,
}: {
  overrideHistory: ComplianceOverride[] | null;
  history: ComplianceAuditEvent[] | null;
}) {
  return (
    <div className="space-y-5">
      <Card className="p-5">
        <h3 className="mb-3 font-semibold text-stone-700">سجل الاستثناءات (نشطة + معاد تعيينها)</h3>
        {!overrideHistory ? (
          <Skeleton rows={3} />
        ) : overrideHistory.length === 0 ? (
          <EmptyState message="لا يوجد سجل استثناءات بعد." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-stone-200 text-right text-stone-500">
                  <th className="py-1.5">الإعداد</th>
                  <th className="py-1.5">القيمة</th>
                  <th className="py-1.5">الحالة</th>
                  <th className="py-1.5">تاريخ الإنشاء</th>
                  <th className="py-1.5">تاريخ إعادة التعيين</th>
                </tr>
              </thead>
              <tbody>
                {overrideHistory.map((o) => (
                  <tr key={o.id} className="border-b border-stone-100">
                    <td className="py-1.5">{overrideKeyLabel(o.settingKey)}</td>
                    <td className="py-1.5">{renderRawValue(o.overrideValue)}</td>
                    <td className="py-1.5">
                      <Badge tone={overrideStatusTone[o.status]}>{o.status}</Badge>
                    </td>
                    <td className="py-1.5">{formatDate(o.createdAt)}</td>
                    <td className="py-1.5">{o.resetAt ? formatDate(o.resetAt) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="p-5">
        <h3 className="mb-3 font-semibold text-stone-700">سجل التدقيق العام للامتثال الضريبي</h3>
        {!history ? (
          <Skeleton rows={3} />
        ) : history.length === 0 ? (
          <EmptyState message="لا يوجد سجل تدقيق بعد." />
        ) : (
          <ul className="space-y-2">
            {history.map((e) => (
              <li key={e.id} className="flex items-baseline justify-between border-b border-stone-100 pb-2 text-sm">
                <span className="text-stone-700">{e.action}</span>
                <span className="text-stone-400">{formatDateTime(e.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between border-b border-stone-100 pb-2">
      <dt className="text-stone-500">{label}</dt>
      <dd className="font-medium text-stone-800">{value}</dd>
    </div>
  );
}
