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
import { useTranslation } from "../../i18n/I18nProvider";

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
  const { t } = useTranslation();
  return (
    <div className="rounded-md border border-danger-200 bg-danger-50 p-3 text-sm text-danger-800">
      <p className="font-medium">{presented.title}</p>
      <p className="mt-1">{presented.message}</p>
      <p className="mt-1 text-xs text-danger-600">
        {presented.retryGuidanceText}
        {presented.needsAdminOrSupport && t("zatcaOnboardingPanel.needsAdminOrSupportSuffix")}
      </p>
    </div>
  );
}

// Password-style, cleared on unmount/after each attempt (state lives only
// in the calling step's own component, which resets it) — never persisted
// anywhere, never logged, never stored in localStorage/sessionStorage. See
// this Center's overall security review for the full audit of this claim.
function OtpInput({ value, onChange, egsUnitName }: { value: string; onChange: (v: string) => void; egsUnitName: string }) {
  const { t } = useTranslation();
  return (
    <label className="block text-sm text-stone-600">
      {t("zatcaOnboardingPanel.otp.label", { name: egsUnitName })}
      <input
        type="password"
        autoComplete="off"
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t("zatcaOnboardingPanel.otp.placeholder")}
        className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
      />
      <span className="mt-1 block text-xs text-stone-400">
        {t("zatcaOnboardingPanel.otp.description")}
      </span>
    </label>
  );
}

export function ZatcaOnboardingPanel({
  unit,
  identity,
  onChanged,
}: {
  unit: ZatcaEgsUnit;
  identity: ZatcaTenantIdentity;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState("csr");

  return (
    <div className="rounded-lg border border-stone-200 bg-stone-50/50 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium text-stone-700">{t("zatcaOnboardingPanel.header.title", { name: unit.name })}</p>
        <Badge tone="neutral">{t("zatcaOnboardingPanel.header.certificateStatus", { status: t(`zatcaSettingsPage.csidStatus.${unit.csidStatus}`) })}</Badge>
      </div>
      <Tabs
        items={[
          { key: "csr", label: t("zatcaOnboardingPanel.tabs.csr") },
          { key: "compliance-csid", label: t("zatcaOnboardingPanel.tabs.complianceCsid") },
          { key: "compliance-invoice", label: t("zatcaOnboardingPanel.tabs.complianceInvoice") },
          { key: "production-csid", label: t("zatcaOnboardingPanel.tabs.productionCsid") },
          { key: "renewal", label: t("zatcaOnboardingPanel.tabs.renewal") },
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
  const { t, locale } = useTranslation();
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
      .catch((err) => setLoadError(err instanceof Error ? err.message : t("zatcaOnboardingPanel.csr.loadError")));
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
      setPresentedError(presentZatcaError(err, t("zatcaOnboardingPanel.csr.genericError")));
    } finally {
      setSubmitting(false);
    }
  }

  if (current === undefined && !loadError) return <Skeleton rows={3} />;

  return (
    <div className="space-y-3">
      {loadError && <ErrorState message={loadError} onRetry={load} />}
      {current === null && <EmptyState message={t("zatcaOnboardingPanel.csr.emptyMessage")} />}
      {current && (
        <div className="rounded-md bg-white p-3 text-sm text-stone-600 ring-1 ring-stone-200">
          <p>
            {t("zatcaOnboardingPanel.csr.currentInfo", { invoiceType: current.invoiceType, date: formatDateTime(current.generatedAt, locale) })}
          </p>
          <p className="mt-1 text-xs text-stone-400">
            {t("zatcaOnboardingPanel.csr.replaceHint")}
          </p>
        </div>
      )}

      {!showForm ? (
        <Button size="sm" variant="secondary" onClick={() => setShowForm(true)}>
          {current ? t("zatcaOnboardingPanel.csr.newRequest") : t("zatcaOnboardingPanel.csr.startRequest")}
        </Button>
      ) : (
        <form onSubmit={onSubmit} className="space-y-3 rounded-md bg-white p-4 ring-1 ring-stone-200">
          <p className="text-xs text-stone-500">
            {t("zatcaOnboardingPanel.csr.formIntro")}
          </p>
          <OtpInput value={otp} onChange={setOtp} egsUnitName={unit.name} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <TextField label={t("zatcaOnboardingPanel.csr.fields.commonName")} value={fields.commonName} onChange={(v) => setFields({ ...fields, commonName: v })} />
            <TextField
              label={t("zatcaOnboardingPanel.csr.fields.organizationIdentifier")}
              value={fields.organizationIdentifier}
              onChange={(v) => setFields({ ...fields, organizationIdentifier: v })}
            />
            <TextField label={t("zatcaOnboardingPanel.csr.fields.organizationName")} value={fields.organizationName} onChange={(v) => setFields({ ...fields, organizationName: v })} />
            <TextField label={t("zatcaOnboardingPanel.csr.fields.organizationUnitName")} value={fields.organizationUnitName} onChange={(v) => setFields({ ...fields, organizationUnitName: v })} />
            <TextField label={t("zatcaOnboardingPanel.csr.fields.countryCode")} value={fields.countryCode} onChange={(v) => setFields({ ...fields, countryCode: v.toUpperCase() })} />
            <TextField label={t("zatcaOnboardingPanel.csr.fields.egsSerialNumber")} value={fields.egsSerialNumber} onChange={(v) => setFields({ ...fields, egsSerialNumber: v })} />
            <TextField label={t("zatcaOnboardingPanel.csr.fields.invoiceType")} value={fields.invoiceType} onChange={(v) => setFields({ ...fields, invoiceType: v })} />
            <TextField label={t("zatcaOnboardingPanel.csr.fields.location")} value={fields.location} onChange={(v) => setFields({ ...fields, location: v })} />
            <TextField label={t("zatcaOnboardingPanel.csr.fields.industry")} value={fields.industry} onChange={(v) => setFields({ ...fields, industry: v })} />
          </div>

          <button type="button" onClick={() => setShowOids((v) => !v)} className="text-xs text-primary underline">
            {showOids ? t("zatcaOnboardingPanel.csr.hideAdvanced") : t("zatcaOnboardingPanel.csr.showAdvanced")}
          </button>
          {showOids && (
            <div className="rounded-md bg-stone-50 p-3 text-xs text-stone-500">
              <p className="mb-2">
                {t("zatcaOnboardingPanel.csr.advancedHint")}
              </p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <TextField label={t("zatcaOnboardingPanel.csr.oidFields.egsSerialNumber")} value={oids.egsSerialNumber ?? ""} onChange={(v) => setOids({ ...oids, egsSerialNumber: v || undefined })} />
                <TextField label={t("zatcaOnboardingPanel.csr.oidFields.invoiceType")} value={oids.invoiceType ?? ""} onChange={(v) => setOids({ ...oids, invoiceType: v || undefined })} />
                <TextField label={t("zatcaOnboardingPanel.csr.oidFields.location")} value={oids.location ?? ""} onChange={(v) => setOids({ ...oids, location: v || undefined })} />
                <TextField label={t("zatcaOnboardingPanel.csr.oidFields.industry")} value={oids.industry ?? ""} onChange={(v) => setOids({ ...oids, industry: v || undefined })} />
              </div>
            </div>
          )}

          {presentedError && <ErrorPanel presented={presentedError} />}

          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={submitting}>
              {submitting ? t("zatcaOnboardingPanel.csr.creating") : t("zatcaOnboardingPanel.csr.create")}
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => setShowForm(false)}>
              {t("common.cancel")}
            </Button>
          </div>
        </form>
      )}

      {result && (
        <div className="rounded-md bg-success-50 p-3 text-sm text-success-800 ring-1 ring-success-200">
          <p className="font-medium">{t("zatcaOnboardingPanel.csr.successHeading")}</p>
          <p className="mt-1 text-xs">
            {t("zatcaOnboardingPanel.csr.successDescription")}
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
  const { t, locale } = useTranslation();
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
      .catch((err) => setLoadError(err instanceof Error ? err.message : t("zatcaOnboardingPanel.complianceCsid.loadError")));
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
      setRequestError(presentZatcaError(err, t("zatcaOnboardingPanel.complianceCsid.requestError")));
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
      setConfirmError(presentZatcaError(err, t("zatcaOnboardingPanel.complianceCsid.confirmError")));
    } finally {
      setConfirming(false);
    }
  }

  if (lifecycle === undefined && !loadError) return <Skeleton rows={3} />;

  return (
    <div className="space-y-5">
      {loadError && <ErrorState message={loadError} onRetry={load} />}

      <div>
        <h3 className="mb-1 text-sm font-semibold text-stone-800">{t("zatcaOnboardingPanel.complianceCsid.requestHeading")}</h3>
        {lifecycle === null && <EmptyState message={t("zatcaOnboardingPanel.complianceCsid.emptyMessage")} />}
        {lifecycle && (
          <div className="mb-2 rounded-md bg-white p-3 text-sm text-stone-600 ring-1 ring-stone-200">
            {t("zatcaOnboardingPanel.complianceCsid.existingInfo", { requestId: lifecycle.requestId, disposition: lifecycle.dispositionMessage, date: formatDateTime(lifecycle.startedAt, locale) })}
          </div>
        )}
        {!lifecycle && (
          <form onSubmit={onRequest} className="space-y-3 rounded-md bg-white p-4 ring-1 ring-stone-200">
            <OtpInput value={otp} onChange={setOtp} egsUnitName={unit.name} />
            <label className="block text-sm text-stone-600">
              {t("zatcaOnboardingPanel.complianceCsid.csrBase64Label")}
              <textarea
                required
                rows={3}
                value={csrBase64}
                onChange={(e) => setCsrBase64(e.target.value)}
                placeholder={t("zatcaOnboardingPanel.complianceCsid.csrBase64Placeholder")}
                className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 font-mono text-xs"
              />
            </label>
            {requestError && <ErrorPanel presented={requestError} />}
            <Button type="submit" size="sm" disabled={requesting}>
              {requesting ? t("zatcaOnboardingPanel.sendingToZatca") : t("zatcaOnboardingPanel.complianceCsid.requestAction")}
            </Button>
          </form>
        )}
        {requestResult && (
          <div className="mt-2 rounded-md bg-success-50 p-3 text-sm text-success-800 ring-1 ring-success-200">
            <p className="font-medium">{t("zatcaOnboardingPanel.complianceCsid.issuedHeading", { requestId: requestResult.requestId })}</p>
            <p className="mt-1 text-xs">
              {t("zatcaOnboardingPanel.complianceCsid.issuedDescription")}
            </p>
          </div>
        )}
      </div>

      <div className="border-t border-stone-200 pt-4">
        <h3 className="mb-1 text-sm font-semibold text-stone-800">{t("zatcaOnboardingPanel.complianceCsid.confirmHeading")}</h3>
        <p className="mb-2 text-xs text-stone-500">
          {t("zatcaOnboardingPanel.complianceCsid.confirmDescription")}
        </p>
        {unit.csidStatus === "compliance_issued" || unit.csidStatus === "production_issued" ? (
          <div className="rounded-md bg-success-50 p-3 text-sm text-success-700 ring-1 ring-success-200">
            {t("zatcaOnboardingPanel.complianceCsid.alreadyConfirmed")}
          </div>
        ) : (
          <form onSubmit={onConfirm} className="space-y-3 rounded-md bg-white p-4 ring-1 ring-stone-200">
            <label className="block text-sm text-stone-600">
              {t("zatcaOnboardingPanel.complianceCsid.tokenLabel")}
              <textarea
                required
                rows={3}
                value={confirmToken}
                onChange={(e) => setConfirmToken(e.target.value)}
                className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 font-mono text-xs"
              />
            </label>
            <label className="block text-sm text-stone-600">
              {t("zatcaSettingsPage.credentialModal.secretLabel")}
              <input
                required
                type="password"
                value={confirmSecret}
                onChange={(e) => setConfirmSecret(e.target.value)}
                className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
              />
            </label>
            {confirmError && <ErrorPanel presented={confirmError} />}
            {confirmed && <p className="text-sm text-success-700">{t("zatcaOnboardingPanel.complianceCsid.confirmedNotice")}</p>}
            <Button type="submit" size="sm" disabled={confirming || unit.csidStatus !== "compliance_pending"}>
              {confirming ? t("zatcaOnboardingPanel.complianceCsid.confirming") : t("zatcaOnboardingPanel.complianceCsid.confirmAction")}
            </Button>
            {unit.csidStatus !== "compliance_pending" && (
              <p className="text-xs text-warning-700">{t("zatcaOnboardingPanel.complianceCsid.needsCsrFirst", { status: t(`zatcaSettingsPage.csidStatus.${unit.csidStatus}`) })}</p>
            )}
          </form>
        )}
      </div>
    </div>
  );
}

// --- Step 3: Compliance Invoice (test) --------------------------------------

function ComplianceInvoiceStep({ unit }: { unit: ZatcaEgsUnit }) {
  const { t, locale } = useTranslation();
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
      .catch((err) => setLoadError(err instanceof Error ? err.message : t("zatcaOnboardingPanel.complianceInvoice.loadError")));
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
      setPresentedError(presentZatcaError(err, t("zatcaOnboardingPanel.complianceInvoice.submitError")));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-stone-500">
        {t("zatcaOnboardingPanel.complianceInvoice.intro")}
      </p>

      <form onSubmit={onSubmit} className="space-y-3 rounded-md bg-white p-4 ring-1 ring-stone-200">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block text-sm text-stone-600">
            {t("zatcaOnboardingPanel.complianceInvoice.documentTypeLabel")}
            <select value={documentType} onChange={(e) => setDocumentType(e.target.value as ZatcaComplianceDocumentType)} className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-sm">
              <option value="388">{t("zatcaOnboardingPanel.complianceInvoice.documentTypes.invoice")}</option>
              <option value="381">{t("zatcaOnboardingPanel.complianceInvoice.documentTypes.creditNote")}</option>
              <option value="383">{t("zatcaOnboardingPanel.complianceInvoice.documentTypes.debitNote")}</option>
            </select>
          </label>
          <label className="block text-sm text-stone-600">
            {t("zatcaOnboardingPanel.complianceInvoice.invoiceFamilyLabel")}
            <select value={invoiceFamily} onChange={(e) => setInvoiceFamily(e.target.value as ZatcaInvoiceFamily)} className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-sm">
              <option value="standard">{t("zatcaOnboardingPanel.complianceInvoice.invoiceFamilies.standard")}</option>
              <option value="simplified">{t("zatcaOnboardingPanel.complianceInvoice.invoiceFamilies.simplified")}</option>
            </select>
          </label>
        </div>
        <label className="block text-sm text-stone-600">
          {t("zatcaOnboardingPanel.complianceInvoice.documentContentLabel")}
          <textarea required rows={3} value={xml} onChange={(e) => setXml(e.target.value)} className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 font-mono text-xs" />
        </label>
        <label className="block text-sm text-stone-600">
          {t("zatcaOnboardingPanel.complianceInvoice.documentHashLabel")}
          <input required value={hash} onChange={(e) => setHash(e.target.value)} className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 font-mono text-xs" />
        </label>
        <label className="block text-sm text-stone-600">
          {t("zatcaOnboardingPanel.complianceInvoice.uuidLabel")}
          <div className="mt-1 flex gap-2">
            <input required value={uuid} onChange={(e) => setUuid(e.target.value)} className="block w-full rounded-md border border-stone-300 px-3 py-2 font-mono text-xs" />
            <Button type="button" size="sm" variant="secondary" onClick={() => setUuid(crypto.randomUUID())}>
              {t("zatcaOnboardingPanel.complianceInvoice.generate")}
            </Button>
          </div>
        </label>
        {presentedError && <ErrorPanel presented={presentedError} />}
        {outcome && <p className="text-sm text-stone-700">{t("zatcaOnboardingPanel.complianceInvoice.outcome", { outcome })}</p>}
        <Button type="submit" size="sm" disabled={submitting}>
          {submitting ? t("zatcaOnboardingPanel.complianceInvoice.submitting") : t("zatcaOnboardingPanel.complianceInvoice.submitAction")}
        </Button>
      </form>

      <div>
        <h3 className="mb-2 text-sm font-semibold text-stone-800">{t("zatcaOnboardingPanel.complianceInvoice.attemptsHeading")}</h3>
        {loadError && <ErrorState message={loadError} onRetry={load} />}
        {!loadError && attempts === null && <Skeleton rows={2} />}
        {!loadError && attempts && attempts.length === 0 && <EmptyState message={t("zatcaOnboardingPanel.complianceInvoice.attemptsEmptyMessage")} />}
        {!loadError && attempts && attempts.length > 0 && (
          <div className="space-y-2">
            {attempts.map((a) => (
              <div key={a.id} className="rounded-md border border-stone-200 bg-white p-2 text-xs text-stone-600">
                <span className="font-medium">{a.documentType}</span> · {a.invoiceFamily} ·{" "}
                {a.normalizedOutcome ?? a.errorCategory ?? "—"} · {formatDateTime(a.attemptedAt, locale)}
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
  const { t, locale } = useTranslation();
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
      .catch((err) => setLoadError(err instanceof Error ? err.message : t("zatcaOnboardingPanel.productionCsid.loadError")));
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
      setPresentedError(presentZatcaError(err, t("zatcaOnboardingPanel.productionCsid.requestError")));
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
      setConfirmError(presentZatcaError(err, t("zatcaOnboardingPanel.productionCsid.confirmError")));
    } finally {
      setConfirming(false);
    }
  }

  const complianceReady = unit.csidStatus === "compliance_issued";
  const productionActive = unit.csidStatus === "production_issued";

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge tone={complianceReady || productionActive ? "success" : "neutral"}>{t("zatcaOnboardingPanel.productionCsid.complianceBadge")}</Badge>
        <span className="text-stone-400">←</span>
        <Badge tone={productionActive ? "success" : "neutral"}>{t("zatcaOnboardingPanel.productionCsid.productionBadge")}</Badge>
        <span className="text-stone-400">{t("zatcaOnboardingPanel.productionCsid.separateEnvsNote")}</span>
      </div>

      {!complianceReady && !productionActive && (
        <ErrorState message={t("zatcaOnboardingPanel.productionCsid.notReadyError", { status: t(`zatcaSettingsPage.csidStatus.${unit.csidStatus}`) })} />
      )}

      <div>
        <h3 className="mb-1 text-sm font-semibold text-stone-800">{t("zatcaOnboardingPanel.productionCsid.requestHeading")}</h3>
        <div className="mb-2 rounded-md bg-warning-50 p-2 text-xs text-warning-800 ring-1 ring-warning-200">
          {t("zatcaOnboardingPanel.productionCsid.currentCcsidWarning")}
        </div>
        <Button size="sm" disabled={requesting || !complianceReady} onClick={onRequest}>
          {requesting ? t("zatcaOnboardingPanel.sendingToZatca") : t("zatcaOnboardingPanel.productionCsid.requestAction")}
        </Button>
        {presentedError && (
          <div className="mt-2">
            <ErrorPanel presented={presentedError} />
          </div>
        )}
        {result && (
          <div className="mt-2 rounded-md bg-success-50 p-3 text-sm text-success-800 ring-1 ring-success-200">
            {t("zatcaOnboardingPanel.productionCsid.issuedNotice", { requestId: result.requestId, disposition: result.dispositionMessage })}
          </div>
        )}
      </div>

      <div className="border-t border-stone-200 pt-4">
        <h3 className="mb-1 text-sm font-semibold text-stone-800">{t("zatcaOnboardingPanel.productionCsid.confirmHeading")}</h3>
        {productionActive ? (
          <div className="rounded-md bg-success-50 p-3 text-sm text-success-700 ring-1 ring-success-200">{t("zatcaOnboardingPanel.productionCsid.alreadyActive")}</div>
        ) : (
          <form onSubmit={onConfirm} className="space-y-3 rounded-md bg-white p-4 ring-1 ring-stone-200">
            <label className="block text-sm text-stone-600">
              {t("zatcaOnboardingPanel.productionCsid.tokenLabel")}
              <textarea required rows={3} value={confirmToken} onChange={(e) => setConfirmToken(e.target.value)} className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 font-mono text-xs" />
            </label>
            <label className="block text-sm text-stone-600">
              {t("zatcaSettingsPage.credentialModal.secretLabel")}
              <input required type="password" value={confirmSecret} onChange={(e) => setConfirmSecret(e.target.value)} className="mt-1 block w-full rounded-md border border-stone-300 px-3 py-2 text-sm" />
            </label>
            {confirmError && <ErrorPanel presented={confirmError} />}
            <Button type="submit" size="sm" disabled={confirming || !complianceReady}>
              {confirming ? t("zatcaOnboardingPanel.productionCsid.confirming") : t("zatcaOnboardingPanel.productionCsid.confirmAction")}
            </Button>
          </form>
        )}
      </div>

      <div className="border-t border-stone-200 pt-4">
        <h3 className="mb-2 text-sm font-semibold text-stone-800">{t("zatcaOnboardingPanel.productionCsid.operationsHeading")}</h3>
        {loadError && <ErrorState message={loadError} onRetry={load} />}
        {!loadError && operations === null && <Skeleton rows={2} />}
        {!loadError && operations && operations.length === 0 && <EmptyState message={t("zatcaOnboardingPanel.productionCsid.operationsEmptyMessage")} />}
        {!loadError && operations && operations.length > 0 && (
          <div className="space-y-2">
            {operations.map((o) => (
              <div key={o.id} className="rounded-md border border-stone-200 bg-white p-2 text-xs text-stone-600">
                <span className="font-medium">{o.operationType === "production_csid_onboarding" ? t("zatcaOnboardingPanel.productionCsid.operationType.onboarding") : t("zatcaOnboardingPanel.productionCsid.operationType.renewal")}</span> ·{" "}
                {o.internalStatus === "response_received" ? o.providerOutcome ?? t("zatcaOnboardingPanel.productionCsid.operationReceived") : t("zatcaOnboardingPanel.productionCsid.operationFailed", { category: o.errorCategory ?? "—" })} ·{" "}
                {formatDateTime(o.startedAt, locale)}
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
  const { t, locale } = useTranslation();
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
      setPresentedError(presentZatcaError(err, t("zatcaOnboardingPanel.renewal.genericError")));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="rounded-md bg-white p-3 text-sm text-stone-600 ring-1 ring-stone-200">
        <p>{t("zatcaOnboardingPanel.renewal.currentStatus", { status: t(`zatcaSettingsPage.csidStatus.${unit.csidStatus}`) })}</p>
        <p className="mt-1">
          {t("zatcaOnboardingPanel.renewal.expiresAt", { date: expiresAt ? formatDateTime(expiresAt, locale) : t("zatcaOnboardingPanel.renewal.unknownExpiry") })}
          {daysLeft !== null && daysLeft <= 30 && <span className="text-warning-700">{t("zatcaOnboardingPanel.renewal.expiresInDays", { days: daysLeft })}</span>}
        </p>
        {!eligible && <p className="mt-1 text-xs text-warning-700">{t("zatcaOnboardingPanel.renewal.notEligible")}</p>}
      </div>

      <p className="text-xs text-stone-500">
        {t("zatcaOnboardingPanel.renewal.intro")}
      </p>

      <form onSubmit={onSubmit} className="space-y-3 rounded-md bg-white p-4 ring-1 ring-stone-200">
        <OtpInput value={otp} onChange={setOtp} egsUnitName={unit.name} />
        <label className="block text-sm text-stone-600">
          {t("zatcaOnboardingPanel.renewal.csrLabel")}
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
              ? t("zatcaOnboardingPanel.renewal.issuedOutcome", { requestId: outcome.requestId, disposition: outcome.dispositionMessage })
              : t("zatcaOnboardingPanel.renewal.notEligibleOutcome", { disposition: outcome.dispositionMessage })}
          </div>
        )}
        <Button type="submit" size="sm" disabled={submitting || !eligible}>
          {submitting ? t("zatcaOnboardingPanel.sendingToZatca") : t("zatcaOnboardingPanel.renewal.requestAction")}
        </Button>
      </form>
    </div>
  );
}
