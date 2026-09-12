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
import { useTranslation } from "../i18n/I18nProvider";

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
function renderRawValue(t: (key: string) => string, value: unknown): string {
  if (typeof value === "boolean") return value ? t("compliancePage.yes") : t("compliancePage.no");
  if (value === null || value === undefined) return "—";
  return String(value);
}

export function Compliance() {
  const { t } = useTranslation();
  const TABS: TabItem[] = [
    { key: "profile", label: t("compliancePage.tabs.profile") },
    { key: "status", label: t("compliancePage.tabs.status") },
    { key: "rules", label: t("compliancePage.tabs.rules") },
    { key: "overrides", label: t("compliancePage.tabs.overrides") },
    { key: "history", label: t("compliancePage.tabs.history") },
  ];
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
      setError(err instanceof Error ? err.message : t("compliancePage.loadError"));
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
        <PageHeader title={t("compliancePage.title")} subtitle={t("compliancePage.subtitle")} />
        <Skeleton rows={6} />
      </Layout>
    );
  }

  if (error) {
    return (
      <Layout>
        <PageHeader title={t("compliancePage.title")} subtitle={t("compliancePage.subtitle")} />
        <ErrorState message={error} onRetry={load} />
      </Layout>
    );
  }

  const notConfigured = status?.status === "not_configured";

  return (
    <Layout>
      <PageHeader title={t("compliancePage.title")} subtitle={t("compliancePage.subtitle")} />

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
  const { t, locale } = useTranslation();
  if (notConfigured) {
    return (
      <Card className="p-5">
        <h2 className="mb-2 font-semibold text-stone-800">{t("compliancePage.profileTab.notConfiguredHeading")}</h2>
        <p className="mb-4 text-sm text-stone-500">
          {t("compliancePage.profileTab.notConfiguredDescription")}
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
        <Field label={t("compliancePage.fields.countryCode")} value={profile.countryCode} />
        {/* profile.status rendered verbatim, never translated/relabeled — this
            page never derives compliance status, per its own header comment
            and Compliance.test.tsx's "renders the server-provided status
            verbatim" assertion. */}
        <Field label={t("compliancePage.fields.status")} value={<Badge tone={profile.status === "configured" ? "success" : "warning"}>{profile.status}</Badge>} />
        <Field label={t("compliancePage.fields.legalEntityType")} value={profile.legalEntityType ?? "—"} />
        <Field label={t("compliancePage.fields.businessActivity")} value={profile.businessActivity ?? "—"} />
        <Field label={t("compliancePage.fields.taxRegistrationStatus")} value={profile.taxRegistrationStatus ?? "—"} />
        <Field label={t("compliancePage.fields.lastUpdate")} value={formatDateTime(profile.updatedAt, locale)} />
      </dl>

      <Can permission="compliance.manage">
        <div className="mt-6 border-t border-stone-100 pt-5">
          <h3 className="mb-3 font-semibold text-stone-700">{t("compliancePage.profileTab.changeCountryHeading")}</h3>
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
  const { t } = useTranslation();
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
      setError(err instanceof ApiError ? err.message : t("compliancePage.profileTab.form.genericError"));
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
        {t("compliancePage.profileTab.form.countryLabel")}
        <select
          required
          value={countryCode}
          onChange={(e) => setCountryCode(e.target.value)}
          className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
        >
          {countries.length === 0 && <option value="">{t("compliancePage.profileTab.form.noCountriesAvailable")}</option>}
          {countries.map((c) => (
            <option key={c.countryCode} value={c.countryCode}>
              {displayLocalized(c.displayName, c.countryCode)}
            </option>
          ))}
        </select>
      </label>
      <input
        placeholder={t("compliancePage.profileTab.form.legalEntityTypePlaceholder")}
        value={legalEntityType}
        onChange={(e) => setLegalEntityType(e.target.value)}
        className="rounded-md border border-stone-300 px-3 py-2 text-sm"
      />
      <input
        placeholder={t("compliancePage.profileTab.form.businessActivityPlaceholder")}
        value={businessActivity}
        onChange={(e) => setBusinessActivity(e.target.value)}
        className="rounded-md border border-stone-300 px-3 py-2 text-sm"
      />
      <input
        placeholder={t("compliancePage.profileTab.form.taxRegistrationStatusPlaceholder")}
        value={taxRegistrationStatus}
        onChange={(e) => setTaxRegistrationStatus(e.target.value)}
        className="rounded-md border border-stone-300 px-3 py-2 text-sm sm:col-span-2"
      />
      <Button type="submit" disabled={submitting || !countryCode} className="sm:col-span-2">
        {submitting ? t("compliancePage.profileTab.form.saving") : initial ? t("compliancePage.profileTab.form.saveChange") : t("compliancePage.profileTab.form.activate")}
      </Button>
    </form>
  );
}

// --- Status --------------------------------------------------------------

function StatusTab({ status }: { status: ComplianceStatus | null }) {
  const { t, locale } = useTranslation();
  if (!status) return <Skeleton rows={4} />;

  if (status.status === "not_configured") {
    return <EmptyState message={t("compliancePage.statusTab.emptyMessage")} />;
  }

  return (
    <Card className="p-5">
      <dl className="grid grid-cols-1 gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
        {/* status.status rendered verbatim — see the identical note on
            profile.status in ProfileTab above. */}
        <Field label={t("compliancePage.fields.status")} value={<Badge tone={status.status === "configured" ? "success" : "warning"}>{status.status}</Badge>} />
        <Field label={t("compliancePage.fields.countryCode")} value={status.countryCode} />
        <Field label={t("compliancePage.fields.ruleVersion")} value={status.ruleVersion ?? "—"} />
        <Field label={t("compliancePage.fields.activeOverrideCount")} value={String(status.overrideCount)} />
        <Field label={t("compliancePage.fields.lastUpdate")} value={formatDateTime(status.lastUpdate, locale)} />
      </dl>

      <div className="mt-5 border-t border-stone-100 pt-4">
        <h3 className="mb-2 font-semibold text-stone-700">{t("compliancePage.statusTab.zakatHeading")}</h3>
        {status.zakat.status === "review_required" ? (
          <p className="text-sm text-warning-700">{t("compliancePage.statusTab.zakatReviewRequired", { reason: status.zakat.reason })}</p>
        ) : (
          <dl className="grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
            <Field label={t("compliancePage.applicable")} value={status.zakat.applicable ? t("compliancePage.yes") : t("compliancePage.no")} />
            <Field label={t("compliancePage.statusTab.reviewNeeded")} value={status.zakat.reviewRequired ? t("compliancePage.yes") : t("compliancePage.no")} />
            {status.zakat.notes && <Field label={t("compliancePage.fields.notes")} value={status.zakat.notes} />}
          </dl>
        )}
      </div>
    </Card>
  );
}

// --- Rules (read-only viewer) --------------------------------------------

function RulesTab({ rules }: { rules: ComplianceRulesResponse | null }) {
  const { t } = useTranslation();
  if (!rules) return <Skeleton rows={4} />;

  if (rules.status === "review_required") {
    return <EmptyState message={t("compliancePage.rulesTab.reviewRequired", { reason: rules.reason })} />;
  }

  const r = rules.rules;
  return (
    <div className="space-y-4">
      <Card className="p-5">
        <h3 className="mb-3 font-semibold text-stone-700">{t("compliancePage.rulesTab.vatHeading")}</h3>
        <dl className="grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
          <Field label={t("compliancePage.applicable")} value={r.vat.applicable ? t("compliancePage.yes") : t("compliancePage.no")} />
          <Field label={t("compliancePage.rulesTab.standardRate")} value={formatPercent(r.vat.standardRatePercent)} />
        </dl>
        {r.vat.categories.length > 0 && (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-stone-200 text-right text-stone-500">
                  <th className="py-1.5">{t("compliancePage.rulesTab.categoryColumn")}</th>
                  <th className="py-1.5">{t("compliancePage.rulesTab.rateColumn")}</th>
                </tr>
              </thead>
              <tbody>
                {r.vat.categories.map((c) => (
                  <tr key={c.code} className="border-b border-stone-100">
                    <td className="py-1.5">{displayLocalized(c.label, c.code)}</td>
                    <td className="py-1.5">{c.ratePercent !== null ? formatPercent(c.ratePercent) : t("compliancePage.rulesTab.variableRate")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="p-5">
        <h3 className="mb-3 font-semibold text-stone-700">{t("compliancePage.rulesTab.withholdingHeading")}</h3>
        <Field label={t("compliancePage.rulesTab.withholdingApplicable")} value={r.withholding.applicable ? t("compliancePage.yes") : t("compliancePage.no")} />
        {r.withholding.rules.length > 0 && (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-stone-200 text-right text-stone-500">
                  <th className="py-1.5">{t("compliancePage.rulesTab.vendorTypeColumn")}</th>
                  <th className="py-1.5">{t("compliancePage.rulesTab.serviceCategoryColumn")}</th>
                  <th className="py-1.5">{t("compliancePage.rulesTab.rateColumn")}</th>
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
        <h3 className="mb-3 font-semibold text-stone-700">{t("compliancePage.rulesTab.eInvoicingHeading")}</h3>
        <dl className="grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
          <Field label={t("compliancePage.rulesTab.required")} value={r.eInvoicing.required ? t("compliancePage.yes") : t("compliancePage.no")} />
          <Field label={t("compliancePage.rulesTab.standard")} value={r.eInvoicing.profile ?? "—"} />
          <Field label={t("compliancePage.rulesTab.bilingualRequired")} value={r.invoice.bilingualRequired ? t("compliancePage.yes") : t("compliancePage.no")} />
          <Field label={t("compliancePage.rulesTab.currency")} value={r.localization.currency} />
        </dl>
        {r.invoice.requiredFields.length > 0 && (
          <p className="mt-3 text-sm text-stone-600">{t("compliancePage.rulesTab.requiredInvoiceFields", { fields: r.invoice.requiredFields.join(t("compliancePage.rulesTab.listSeparator")) })}</p>
        )}
        {r.identifiers.length > 0 && (
          <ul className="mt-3 list-inside list-disc text-sm text-stone-600">
            {r.identifiers.map((id) => (
              <li key={id.type}>
                {displayLocalized(id.label, id.type)} {id.required ? t("compliancePage.rulesTab.identifierRequired") : t("compliancePage.rulesTab.identifierOptional")}
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
  const { t, locale } = useTranslation();
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
      setError(err instanceof ApiError ? err.message : t("compliancePage.overridesTab.resetError"));
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
            <p className="text-sm text-stone-500">{t("compliancePage.overridesTab.notConfiguredHint")}</p>
          ) : (
            <Button size="sm" onClick={() => setShowCreate((v) => !v)}>
              {showCreate ? t("common.cancel") : t("compliancePage.overridesTab.newOverride")}
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
        <EmptyState message={t("compliancePage.overridesTab.emptyMessage")} />
      ) : (
        <Table>
          <thead>
            <tr className="border-b border-stone-200 text-right text-stone-500">
              <th className="px-4 py-2">{t("compliancePage.overridesTab.columns.setting")}</th>
              <th className="px-4 py-2">{t("compliancePage.overridesTab.columns.currentValue")}</th>
              <th className="px-4 py-2">{t("compliancePage.overridesTab.columns.officialValueAtCreation")}</th>
              <th className="px-4 py-2">{t("compliancePage.overridesTab.columns.effectiveFrom")}</th>
              <th className="px-4 py-2">{t("compliancePage.fields.status")}</th>
              <th className="px-4 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {overrides.map((o) => (
              <tr key={o.id} className="border-b border-stone-100">
                <td className="px-4 py-2">{overrideKeyLabel(o.settingKey)}</td>
                <td className="px-4 py-2">{renderRawValue(t, o.overrideValue)}</td>
                <td className="px-4 py-2">{renderRawValue(t, o.officialDefaultSnapshot)}</td>
                <td className="px-4 py-2">{formatDate(o.effectiveFrom, locale)}</td>
                <td className="px-4 py-2">
                  {/* o.status rendered verbatim — see the note on
                      profile.status/status.status above. */}
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
                      {resettingId === o.id ? t("compliancePage.overridesTab.resetting") : t("compliancePage.overridesTab.reset")}
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
  const { t } = useTranslation();
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
      setError(err instanceof ApiError ? err.message : t("compliancePage.createOverrideForm.genericError"));
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
          {t("compliancePage.overridesTab.columns.setting")}
          <select
            required
            value={settingKey}
            onChange={(e) => setSettingKey(e.target.value)}
            className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
          >
            {(overridableKeys ?? []).length === 0 && <option value="">{t("compliancePage.createOverrideForm.noOverridableSettings")}</option>}
            {(overridableKeys ?? []).map((k) => (
              <option key={k} value={k}>
                {overrideKeyLabel(k)}
              </option>
            ))}
          </select>
        </label>

        {isBooleanSetting ? (
          <label className="text-sm text-stone-600">
            {t("compliancePage.createOverrideForm.newValueLabel")}
            <select
              required
              value={rawValue}
              onChange={(e) => setRawValue(e.target.value)}
              className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
            >
              <option value="">{t("compliancePage.createOverrideForm.selectValuePlaceholder")}</option>
              <option value="true">{t("compliancePage.yes")}</option>
              <option value="false">{t("compliancePage.no")}</option>
            </select>
          </label>
        ) : (
          <label className="text-sm text-stone-600">
            {t("compliancePage.createOverrideForm.newValueLabel")}
            <input
              required
              value={rawValue}
              onChange={(e) => setRawValue(e.target.value)}
              className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
            />
          </label>
        )}

        <label className="text-sm text-stone-600">
          {t("compliancePage.overridesTab.columns.effectiveFrom")}
          <input
            required
            type="date"
            value={effectiveFrom}
            onChange={(e) => setEffectiveFrom(e.target.value)}
            className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
          />
        </label>
        <label className="text-sm text-stone-600">
          {t("compliancePage.createOverrideForm.effectiveToLabel")}
          <input
            type="date"
            value={effectiveTo}
            onChange={(e) => setEffectiveTo(e.target.value)}
            className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
          />
        </label>
        <input
          placeholder={t("compliancePage.createOverrideForm.reasonPlaceholder")}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm sm:col-span-2"
        />

        <Button type="submit" disabled={submitting || !settingKey} className="sm:col-span-2">
          {submitting ? t("compliancePage.createOverrideForm.submitting") : t("compliancePage.createOverrideForm.submit")}
        </Button>
      </form>

      {/* Two-step confirmation — matches server/src/routes/compliance.ts's
          significantDeviationWarning contract exactly: the server's own
          warning text and officialDefault are shown verbatim, never
          reworded, and the resend only fires on this explicit click. */}
      <Modal open={pending !== null} onClose={() => setPending(null)} title={t("compliancePage.createOverrideForm.confirmModal.title")}>
        {pending && (
          <div className="space-y-3">
            <p className="text-sm text-stone-700">{pending.warning}</p>
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <Field label={t("compliancePage.createOverrideForm.confirmModal.officialValue")} value={renderRawValue(t, pending.officialDefault)} />
              <Field label={t("compliancePage.createOverrideForm.confirmModal.requestedValue")} value={renderRawValue(t, pending.value)} />
            </dl>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="secondary" size="sm" onClick={() => setPending(null)}>
                {t("common.cancel")}
              </Button>
              <Button size="sm" disabled={submitting} onClick={() => submit(true)}>
                {submitting ? t("compliancePage.createOverrideForm.confirmModal.confirming") : t("compliancePage.createOverrideForm.confirmModal.confirm")}
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
  const { t, locale } = useTranslation();
  return (
    <div className="space-y-5">
      <Card className="p-5">
        <h3 className="mb-3 font-semibold text-stone-700">{t("compliancePage.historyTab.overrideHistoryHeading")}</h3>
        {!overrideHistory ? (
          <Skeleton rows={3} />
        ) : overrideHistory.length === 0 ? (
          <EmptyState message={t("compliancePage.historyTab.overrideHistoryEmptyMessage")} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-stone-200 text-right text-stone-500">
                  <th className="py-1.5">{t("compliancePage.overridesTab.columns.setting")}</th>
                  <th className="py-1.5">{t("compliancePage.historyTab.columns.value")}</th>
                  <th className="py-1.5">{t("compliancePage.fields.status")}</th>
                  <th className="py-1.5">{t("compliancePage.historyTab.columns.createdAt")}</th>
                  <th className="py-1.5">{t("compliancePage.historyTab.columns.resetAt")}</th>
                </tr>
              </thead>
              <tbody>
                {overrideHistory.map((o) => (
                  <tr key={o.id} className="border-b border-stone-100">
                    <td className="py-1.5">{overrideKeyLabel(o.settingKey)}</td>
                    <td className="py-1.5">{renderRawValue(t, o.overrideValue)}</td>
                    <td className="py-1.5">
                      <Badge tone={overrideStatusTone[o.status]}>{o.status}</Badge>
                    </td>
                    <td className="py-1.5">{formatDate(o.createdAt, locale)}</td>
                    <td className="py-1.5">{o.resetAt ? formatDate(o.resetAt, locale) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="p-5">
        <h3 className="mb-3 font-semibold text-stone-700">{t("compliancePage.historyTab.auditHeading")}</h3>
        {!history ? (
          <Skeleton rows={3} />
        ) : history.length === 0 ? (
          <EmptyState message={t("compliancePage.historyTab.auditEmptyMessage")} />
        ) : (
          <ul className="space-y-2">
            {history.map((e) => (
              <li key={e.id} className="flex items-baseline justify-between border-b border-stone-100 pb-2 text-sm">
                <span className="text-stone-700">{e.action}</span>
                <span className="text-stone-400">{formatDateTime(e.createdAt, locale)}</span>
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
