import { useState, type ChangeEvent } from "react";
import { PlatformLayout } from "../components/PlatformLayout";
import { PageHeader, Card, Button, ErrorState } from "../../ui";
import { ApiError } from "../../api/client";
import { validateTenantImport, confirmTenantImport } from "../api/tenantData";
import type { TenantExportBundle, TenantImportPreview, TenantImportResult } from "../api/types";
import { useTranslation } from "../../i18n/I18nProvider";

// MIDAD Final Pre-Launch audit, Phase 22 (UX) — Phase 10-11's Tenant
// Import (server/src/routes/platformTenantData.ts). Export lives as a
// button on PlatformOrganizationDetail.tsx (it needs one specific
// organization's context); import is its own page since it starts from a
// file, not from an existing organization. Flow: pick file -> validate
// (side-effect-free preview) -> type the company name back -> confirm.
export function PlatformTenantImport() {
  const { t } = useTranslation();
  const [bundle, setBundle] = useState<TenantExportBundle | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [preview, setPreview] = useState<TenantImportPreview | null>(null);
  const [validating, setValidating] = useState(false);
  const [confirmationCompanyName, setConfirmationCompanyName] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [result, setResult] = useState<TenantImportResult | null>(null);

  async function onFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileError(null);
    setPreview(null);
    setResult(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as TenantExportBundle;
      setBundle(parsed);
      setValidating(true);
      const p = await validateTenantImport(parsed);
      setPreview(p);
    } catch (err) {
      setFileError(err instanceof ApiError ? err.message : t("platformTenantImportPage.invalidFile"));
    } finally {
      setValidating(false);
    }
  }

  async function onConfirm() {
    if (!bundle || !preview) return;
    setConfirming(true);
    setConfirmError(null);
    try {
      const res = await confirmTenantImport(bundle, confirmationCompanyName);
      setResult(res);
    } catch (err) {
      setConfirmError(err instanceof ApiError ? err.message : t("common.errorGeneric"));
    } finally {
      setConfirming(false);
    }
  }

  return (
    <PlatformLayout>
      <PageHeader title={t("platformTenantImportPage.title")} subtitle={t("platformTenantImportPage.subtitle")} />

      {result ? (
        <Card className="max-w-lg p-5">
          <p className="font-semibold text-stone-800">{t("platformTenantImportPage.result.title")}</p>
          <p className="mt-2 text-sm text-stone-600">{t("platformTenantImportPage.result.summary", { name: result.companyName })}</p>
          {result.passwordResetRequiredForImportedUsers && (
            <p className="mt-2 text-xs text-warning-700">{t("platformTenantImportPage.result.passwordResetNote")}</p>
          )}
        </Card>
      ) : (
        <Card className="max-w-lg space-y-4 p-5">
          <div>
            <label className="mb-1 block text-sm text-stone-600">{t("platformTenantImportPage.chooseFile")}</label>
            <input type="file" accept="application/json" onChange={onFileChange} className="text-sm" />
          </div>
          {fileError && <ErrorState message={fileError} />}
          {validating && <p className="text-sm text-stone-500">{t("platformTenantImportPage.validating")}</p>}

          {preview && (
            <div className="space-y-2 rounded-md border border-stone-200 p-3 text-sm">
              <p>
                {t("platformTenantImportPage.preview.companyName")}: <span className="font-medium">{preview.companyName}</span>
              </p>
              <p>{t("platformTenantImportPage.preview.checksum")}: {preview.checksumValid ? t("common.yes") : t("common.no")}</p>
              <p>{t("platformTenantImportPage.preview.schemaCompatible")}: {preview.schemaCompatible ? t("common.yes") : t("common.no")}</p>
              <p>{t("platformTenantImportPage.preview.companyIdAlreadyExists")}: {preview.companyIdAlreadyExists ? t("common.yes") : t("common.no")}</p>
              {preview.blockers.length > 0 && (
                <ul className="list-inside list-disc text-danger-700">
                  {preview.blockers.map((b) => (
                    <li key={b}>{t(`platformTenantImportPage.blockers.${b}`)}</li>
                  ))}
                </ul>
              )}

              {preview.canImport && (
                <div className="mt-3 space-y-2 border-t border-stone-200 pt-3">
                  {confirmError && <ErrorState message={confirmError} />}
                  <label className="block text-sm">
                    <span className="mb-1 block text-stone-600">
                      {t("platformTenantImportPage.confirmationLabel", { name: preview.companyName })}
                    </span>
                    <input
                      value={confirmationCompanyName}
                      onChange={(e) => setConfirmationCompanyName(e.target.value)}
                      className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
                    />
                  </label>
                  <Button
                    variant="danger"
                    disabled={confirming || confirmationCompanyName !== preview.companyName}
                    onClick={onConfirm}
                  >
                    {confirming ? t("platformTenantImportPage.importing") : t("platformTenantImportPage.confirmImport")}
                  </Button>
                </div>
              )}
            </div>
          )}
        </Card>
      )}
    </PlatformLayout>
  );
}
