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
import { useTranslation } from "../i18n/I18nProvider";

// MIDAD ZATCA e-invoicing settings (Slice 3) — a frontend consumer of
// server/src/routes/zatca.ts only. This page never claims "ZATCA compliant"
// anywhere: every status shown is exactly what the backend's real
// status/csidStatus/verify-connection response says, using the wording the
// Slice 3 spec requires (Not connected / Configuration incomplete /
// Simulation connected / Production connected / Verification failed /
// Certificate expired) instead of a fabricated boolean.

const statusTone: Record<ZatcaEgsUnit["status"], "neutral" | "success" | "warning" | "danger"> = {
  not_onboarded: "neutral",
  onboarding: "warning",
  active: "success",
  revoked: "danger",
  deactivated: "neutral",
};

// The one display-only derivation this page performs — a wording choice
// over already-real fields (hasCredential/status/environment), never a new
// status value invented on the frontend. See this file's header comment
// for why "ZATCA compliant" is never a string that appears here.
function connectionSummary(t: (key: string) => string, unit: ZatcaEgsUnit): { text: string; tone: "neutral" | "success" | "warning" | "danger" } {
  if (!unit.hasCredential) return { text: t("zatcaSettingsPage.connectionSummary.noCredential"), tone: "neutral" };
  if (unit.status === "active") {
    return { text: unit.environment === "production" ? t("zatcaSettingsPage.connectionSummary.activeProduction") : t("zatcaSettingsPage.connectionSummary.activeSimulation"), tone: "success" };
  }
  if (unit.status === "onboarding") return { text: t("zatcaSettingsPage.connectionSummary.onboardingIncomplete"), tone: "warning" };
  if (unit.status === "revoked") return { text: t("zatcaSettingsPage.connectionSummary.revokedByZatca"), tone: "danger" };
  if (unit.status === "deactivated") return { text: t("zatcaSettingsPage.status.deactivated"), tone: "neutral" };
  return { text: t("zatcaSettingsPage.connectionSummary.notConnected"), tone: "neutral" };
}

function isCertificateExpiring(certificateExpiresAt: string | null): boolean {
  if (!certificateExpiresAt) return false;
  const days = (new Date(certificateExpiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
  return days <= 30;
}

// Slice 4 — labels for server/src/lib/zatca/domain/onboarding.ts's
// computed status. Wording deliberately avoids "compliant" anywhere; see
// this file's header comment.
const onboardingStatusTone: Record<ZatcaOnboardingStatus, "neutral" | "success" | "warning" | "danger"> = {
  not_configured: "neutral",
  configuration_incomplete: "warning",
  ready_for_simulation: "warning",
  simulation_connected: "success",
  simulation_failed: "danger",
  production_not_enabled: "warning",
};

function OnboardingStatusBanner({ summary }: { summary: ZatcaOnboardingStatusSummary }) {
  const { t } = useTranslation();
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge tone={onboardingStatusTone[summary.status]}>{t(`zatcaSettingsPage.onboardingStatus.${summary.status}`)}</Badge>
          <span className="text-xs text-stone-400">{t("zatcaSettingsPage.banner.notCertificateNotice")}</span>
        </div>
        <div className="flex flex-wrap gap-3 text-xs text-stone-500">
          <span>{t("zatcaSettingsPage.banner.identityLabel", { status: summary.identityComplete ? t("zatcaSettingsPage.banner.identityComplete") : t("zatcaSettingsPage.banner.identityIncomplete") })}</span>
          <span>{t("zatcaSettingsPage.banner.simulationLabel", { status: summary.simulationConnected ? t("zatcaSettingsPage.banner.envConnected") : summary.hasSimulationEgsUnit ? t("zatcaSettingsPage.banner.envNotConnected") : t("zatcaSettingsPage.banner.envNotConfigured") })}</span>
          <span>{t("zatcaSettingsPage.banner.productionLabel", { status: summary.productionConnected ? t("zatcaSettingsPage.banner.envConnected") : summary.hasProductionEgsUnit ? t("zatcaSettingsPage.banner.envNotConnected") : t("zatcaSettingsPage.banner.envNotConfigured") })}</span>
        </div>
      </div>
    </Card>
  );
}

export function ZatcaSettings() {
  const { t } = useTranslation();
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
      setError(err instanceof ApiError ? err.message : t("zatcaSettingsPage.loadError"));
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
        <PageHeader title={t("zatcaSettingsPage.title")} subtitle={t("zatcaSettingsPage.subtitle")} />
        <Skeleton rows={6} />
      </Layout>
    );
  }
  if (error || !config || !onboarding) {
    return (
      <Layout>
        <PageHeader title={t("zatcaSettingsPage.title")} subtitle={t("zatcaSettingsPage.subtitle")} />
        <ErrorState message={error ?? t("zatcaSettingsPage.genericLoadError")} onRetry={load} />
      </Layout>
    );
  }

  const simulationUnits = config.egsUnits.filter((u) => u.environment === "simulation");

  return (
    <Layout>
      <PageHeader title={t("zatcaSettingsPage.title")} subtitle={t("zatcaSettingsPage.subtitle")} />
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
  const { t, locale } = useTranslation();
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
      .catch((err) => setInvoicesError(err instanceof ApiError ? err.message : t("zatcaSettingsPage.simulation.invoicesLoadError")));
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
      setError(err instanceof ApiError ? err.message : t("zatcaSettingsPage.simulation.prepareError"));
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
      setSubmitOutcome({ error: err instanceof ApiError ? err.message : t("zatcaSettingsPage.simulation.submitError") });
    } finally {
      setSubmitting(false);
      onChanged(); // refresh onboarding status + History with the real persisted outcome
    }
  }

  if (simulationUnits.length === 0) {
    return (
      <Card className="p-5">
        <h2 className="mb-1 font-semibold text-stone-800">{t("zatcaSettingsPage.simulation.heading")}</h2>
        <EmptyState message={t("zatcaSettingsPage.simulation.emptyMessage")} />
      </Card>
    );
  }

  return (
    <Card className="p-5">
      <h2 className="mb-1 font-semibold text-stone-800">{t("zatcaSettingsPage.simulation.heading")}</h2>
      <p className="mb-4 text-sm text-stone-500">
        {t("zatcaSettingsPage.simulation.description")}
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
                {invoices === null ? t("zatcaSettingsPage.simulation.loadingInvoices") : invoices.length === 0 ? t("zatcaSettingsPage.simulation.noInvoices") : t("zatcaSettingsPage.simulation.selectInvoice")}
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
            {preparing ? t("zatcaSettingsPage.simulation.preparing") : t("zatcaSettingsPage.simulation.prepareAction")}
          </Button>
          {prepareResult && (
            <Button size="sm" variant="secondary" disabled={submitting} onClick={onSubmit}>
              {submitting ? t("zatcaSettingsPage.simulation.submitting") : t("zatcaSettingsPage.simulation.submitAction")}
            </Button>
          )}
        </div>
      </Can>

      {prepareResult && (
        <div className="mt-4 rounded-md bg-stone-50 p-3 text-xs text-stone-600">
          <p>
            {prepareResult.alreadyExists ? t("zatcaSettingsPage.simulation.reusedDocument") : t("zatcaSettingsPage.simulation.newDocument")}
          </p>
          <p className="mt-1">{t("zatcaSettingsPage.simulation.icvAndHash", { icv: prepareResult.submission.icv, hash: prepareResult.submission.documentHash.slice(0, 24) })}</p>
          <p className="mt-1">
            {t("zatcaSettingsPage.simulation.validationResult", {
              status: prepareResult.validation.valid ? t("zatcaSettingsPage.simulation.validationValid") : t("zatcaSettingsPage.simulation.validationInvalid"),
              sdkVerified: String(prepareResult.validation.sdkVerified),
            })}
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
              <p className="font-medium">{t("zatcaSettingsPage.simulation.notActuallySubmitted")}</p>
              <p className="mt-1">{submitOutcome.error}</p>
            </>
          ) : (
            <p>{t("zatcaSettingsPage.simulation.currentDocumentState", { state: submissionStateLabel(t, submitOutcome.state ?? "") })}</p>
          )}
        </div>
      )}
    </Card>
  );
}

// --- Step 6: History --------------------------------------------------------

const KNOWN_SUBMISSION_STATES = [
  "not_submitted",
  "ready_for_submission",
  "submitting",
  "submitted",
  "cleared",
  "reported",
  "rejected",
  "retry_required",
  "compliance_pending",
  "compliance_failed",
] as const;

// Falls back to the raw backend state string for any value outside the
// known set — mirrors the original Record<string,string>[state] ?? state
// lookup, since t() returns the lookup key itself (not undefined) for a
// key that doesn't resolve.
function submissionStateLabel(t: (key: string) => string, state: string): string {
  return (KNOWN_SUBMISSION_STATES as readonly string[]).includes(state)
    ? t(`zatcaSettingsPage.history.state.${state}`)
    : state;
}

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
  const { t, locale } = useTranslation();
  const [submissions, setSubmissions] = useState<ZatcaSubmission[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setSubmissions(null);
    setError(null);
    listAllZatcaSubmissions()
      .then((page) => setSubmissions(page.submissions))
      .catch((err) => setError(err instanceof ApiError ? err.message : t("zatcaSettingsPage.history.loadError")));
  }
  useEffect(load, []);

  return (
    <Card className="p-5">
      <h2 className="mb-1 font-semibold text-stone-800">{t("zatcaSettingsPage.history.heading")}</h2>
      <p className="mb-4 text-sm text-stone-500">{t("zatcaSettingsPage.history.description")}</p>
      {error && <ErrorState message={error} onRetry={load} />}
      {!error && !submissions && <Skeleton rows={3} />}
      {!error && submissions && submissions.length === 0 && <EmptyState message={t("zatcaSettingsPage.history.emptyMessage")} />}
      {!error && submissions && submissions.length > 0 && (
        <div className="space-y-2">
          {submissions.map((s) => (
            <div key={s.id} className="rounded-lg border border-stone-200 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-stone-800">{t("zatcaSettingsPage.history.icvAndEnv", { icv: s.icv, env: s.environment === "production" ? t("zatcaSettingsPage.history.envProduction") : t("zatcaSettingsPage.history.envSimulation") })}</span>
                <Badge tone={submissionStateTone(s.state)}>{submissionStateLabel(t, s.state)}</Badge>
              </div>
              <p className="mt-1 text-xs text-stone-400">{t("zatcaSettingsPage.history.dateAndRetries", { date: formatDateTime(s.createdAt, locale), count: s.retryCount })}</p>
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
  const { t } = useTranslation();
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
      setError(err instanceof ApiError ? err.message : t("zatcaSettingsPage.identity.genericError"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="p-5">
      <h2 className="mb-1 font-semibold text-stone-800">{t("zatcaSettingsPage.identity.heading")}</h2>
      <p className="mb-4 text-sm text-stone-500">
        {t("zatcaSettingsPage.identity.description")}
      </p>
      <dl className="mb-4 grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
        <Field label={t("zatcaSettingsPage.identity.legalNameLabel")} value={identity.legalName ?? "—"} />
        <Field label={t("zatcaSettingsPage.identity.addressLabel")} value={identity.address ?? "—"} />
      </dl>
      <Can permission="zatca.configure">
        <form onSubmit={onSubmit} className="grid grid-cols-1 gap-3 border-t border-stone-100 pt-4 sm:grid-cols-2">
          {error && (
            <div className="sm:col-span-2">
              <ErrorState message={error} />
            </div>
          )}
          <label className="text-sm text-stone-600">
            {t("zatcaSettingsPage.identity.vatNumberLabel")}
            <input
              value={vatNumber}
              onChange={(e) => setVatNumber(e.target.value)}
              className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="text-sm text-stone-600">
            {t("zatcaSettingsPage.identity.commercialRegistrationLabel")}
            <input
              value={commercialRegistration}
              onChange={(e) => setCommercialRegistration(e.target.value)}
              className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
            />
          </label>
          <Button type="submit" disabled={submitting} className="sm:col-span-2">
            {submitting ? t("zatcaSettingsPage.saving") : t("common.save")}
          </Button>
        </form>
      </Can>
      {!identity.vatNumber && !identity.commercialRegistration && (
        <p className="mt-2 text-xs text-warning-700">{t("zatcaSettingsPage.identity.missingWarning")}</p>
      )}
    </Card>
  );
}

// --- Step 2+: EGS units ---------------------------------------------------

function EgsUnitsCard({ units, identity, onChanged }: { units: ZatcaEgsUnit[]; identity: ZatcaConfig["identity"]; onChanged: () => void }) {
  const { t } = useTranslation();
  const [showCreate, setShowCreate] = useState(false);

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-stone-800">{t("zatcaSettingsPage.egsUnits.heading")}</h2>
          <p className="mt-1 text-sm text-stone-500">
            {t("zatcaSettingsPage.egsUnits.description")}
          </p>
        </div>
        <Can permission="zatca.configure">
          <Button size="sm" onClick={() => setShowCreate((v) => !v)}>
            {showCreate ? t("common.cancel") : t("zatcaSettingsPage.egsUnits.newUnit")}
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
        <EmptyState message={t("zatcaSettingsPage.egsUnits.emptyMessage")} />
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
  const { t } = useTranslation();
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
      setError(err instanceof ApiError ? err.message : t("zatcaSettingsPage.egsUnits.form.genericError"));
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
        placeholder={t("zatcaSettingsPage.egsUnits.form.namePlaceholder")}
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="rounded-md border border-stone-300 px-3 py-2 text-sm sm:col-span-2"
      />
      <select
        value={environment}
        onChange={(e) => setEnvironment(e.target.value as ZatcaEnvironment)}
        className="rounded-md border border-stone-300 px-3 py-2 text-sm"
      >
        <option value="simulation">{t("zatcaSettingsPage.egsUnits.form.simulationOption")}</option>
        <option value="production">{t("zatcaSettingsPage.egsUnits.form.productionOption")}</option>
      </select>
      <Button type="submit" disabled={submitting || !name.trim()} className="sm:col-span-3">
        {submitting ? t("zatcaSettingsPage.egsUnits.form.creating") : t("zatcaSettingsPage.egsUnits.form.create")}
      </Button>
    </form>
  );
}

function EgsUnitRow({ unit, identity, onChanged }: { unit: ZatcaEgsUnit; identity: ZatcaConfig["identity"]; onChanged: () => void }) {
  const { t, locale } = useTranslation();
  const [showCredential, setShowCredential] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState<ZatcaVerifyConnectionResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const summary = connectionSummary(t, unit);
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
      setError(err instanceof ApiError ? err.message : t("zatcaSettingsPage.egsUnits.row.verifyError"));
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
      setError(err instanceof ApiError ? err.message : t("zatcaSettingsPage.egsUnits.row.deactivateError"));
    }
  }

  async function onClearCredential() {
    setError(null);
    try {
      await clearZatcaCredential(unit.id);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("zatcaSettingsPage.egsUnits.row.clearCredentialError"));
    }
  }

  return (
    <div className="rounded-lg border border-stone-200 p-4">
      {error && <ErrorState message={error} />}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium text-stone-800">{unit.name}</p>
          <p className="mt-0.5 text-xs text-stone-400">
            {t("zatcaSettingsPage.egsUnits.row.envAndCreatedAt", { env: unit.environment === "production" ? t("zatcaSettingsPage.egsUnits.row.envProduction") : t("zatcaSettingsPage.egsUnits.row.envSimulation"), date: formatDateTime(unit.createdAt, locale) })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={statusTone[unit.status]}>{t(`zatcaSettingsPage.status.${unit.status}`)}</Badge>
          <Badge tone="neutral">{t("zatcaSettingsPage.egsUnits.row.csidStatusLabel", { status: t(`zatcaSettingsPage.csidStatus.${unit.csidStatus}`) })}</Badge>
        </div>
      </div>

      <p className={`mt-2 text-sm ${summary.tone === "success" ? "text-success-700" : summary.tone === "danger" ? "text-danger-700" : summary.tone === "warning" ? "text-warning-700" : "text-stone-500"}`}>
        {summary.text}
      </p>

      {certExpiring && (
        <p className="mt-1 text-xs text-warning-700">{t("zatcaSettingsPage.egsUnits.row.certificateExpiringSoon", { date: formatDateTime(unit.certificateExpiresAt!, locale) })}</p>
      )}
      {unit.lastCommunicationAt && (
        <p className="mt-1 text-xs text-stone-400">{t("zatcaSettingsPage.egsUnits.row.lastCommunication", { date: formatDateTime(unit.lastCommunicationAt, locale) })}</p>
      )}

      {verifyResult && (
        <div className="mt-2 rounded-md bg-stone-50 p-2 text-xs text-stone-600">
          {t("zatcaSettingsPage.egsUnits.row.lastVerifyResult", { detail: verifyResult.detail ?? (verifyResult.connected ? t("zatcaSettingsPage.egsUnits.row.verifyConnected") : t("zatcaSettingsPage.egsUnits.row.verifyNotConnected")) })}
          {verifyResult.correlationId && <span className="block text-stone-400">{t("zatcaSettingsPage.egsUnits.row.correlationId", { id: verifyResult.correlationId })}</span>}
        </div>
      )}

      <Can permission="zatca.configure">
        <div className="mt-3 flex flex-wrap gap-2 border-t border-stone-100 pt-3">
          {!unit.hasCredential ? (
            <Button size="sm" variant="secondary" onClick={() => setShowCredential(true)}>
              {t("zatcaSettingsPage.egsUnits.row.linkCredential")}
            </Button>
          ) : (
            <Button size="sm" variant="secondary" onClick={onClearCredential}>
              {t("zatcaSettingsPage.egsUnits.row.removeCredential")}
            </Button>
          )}
          <Can permission="zatca.submit">
            <Button size="sm" disabled={verifying} onClick={onVerify}>
              {verifying ? t("zatcaSettingsPage.egsUnits.row.verifying") : t("zatcaSettingsPage.egsUnits.row.verifyConnection")}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setShowOnboarding((v) => !v)}>
              {showOnboarding ? t("zatcaSettingsPage.egsUnits.row.hideOnboarding") : t("zatcaSettingsPage.egsUnits.row.showOnboarding")}
            </Button>
          </Can>
          {unit.status !== "deactivated" && (
            <Button size="sm" variant="secondary" onClick={onDeactivate}>
              {t("zatcaSettingsPage.egsUnits.row.deactivateUnit")}
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
  const { t } = useTranslation();
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
      setError(err instanceof ApiError ? err.message : t("zatcaSettingsPage.credentialModal.genericError"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={t("zatcaSettingsPage.credentialModal.title")}>
      <form onSubmit={onSubmit} className="space-y-3">
        <p className="text-sm text-stone-500">
          {t("zatcaSettingsPage.credentialModal.description")}
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
          {t("zatcaSettingsPage.credentialModal.secretLabel")}
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
            {t("common.cancel")}
          </Button>
          <Button type="submit" size="sm" disabled={submitting || !binarySecurityToken || !secret}>
            {submitting ? t("zatcaSettingsPage.saving") : t("common.save")}
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
