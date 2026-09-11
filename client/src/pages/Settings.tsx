import { FormEvent, useEffect, useState } from "react";
import { Layout } from "../components/Layout";
import { apiFetch, ApiError, getToken } from "../api/client";
import { PageHeader } from "../ui/PageHeader";
import { Card } from "../ui/Card";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { ErrorState } from "../ui/ErrorState";
import type { CompanySettings } from "../api/types";
import { useTranslation } from "../i18n/I18nProvider";

export function Settings() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<CompanySettings | null>(null);
  const [address, setAddress] = useState("");
  const [taxId, setTaxId] = useState("");
  const [phone, setPhone] = useState("");
  const [taxRate, setTaxRate] = useState("0");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  function load() {
    apiFetch<CompanySettings>("/company/settings").then((s) => {
      setSettings(s);
      setAddress(s.address ?? "");
      setTaxId(s.taxId ?? "");
      setPhone(s.phone ?? "");
      setTaxRate(s.defaultTaxRatePercent);
    });
  }
  useEffect(load, []);

  async function saveProfile(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      await apiFetch("/company/settings", {
        method: "PATCH",
        body: JSON.stringify({ address, taxId, phone, defaultTaxRatePercent: taxRate }),
      });
      setNotice(t("settingsPage.profileSaved"));
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("settingsPage.saveError"));
    }
  }

  async function toggleInvoicing() {
    if (!settings) return;
    await apiFetch("/company/settings", {
      method: "PATCH",
      body: JSON.stringify({ featureFlags: { invoicing: !settings.featureFlags.invoicing } }),
    });
    load();
  }

  async function uploadLogo(file: File) {
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("logo", file);
      const res = await fetch("/api/company/logo", {
        method: "POST",
        headers: { Authorization: `Bearer ${getToken()}` },
        body: form,
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? t("settingsPage.logoUploadError"));
      setNotice(t("settingsPage.logoUploadedNotice"));
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("settingsPage.logoUploadError"));
    } finally {
      setUploading(false);
    }
  }

  if (!settings) return null;

  return (
    <Layout>
      <PageHeader title={t("settingsPage.title")} subtitle={t("settingsPage.subtitle")} />

      {error && (
        <div className="mb-4">
          <ErrorState message={error} />
        </div>
      )}
      {notice && <p className="mb-4 rounded-md bg-success-50 px-3 py-2 text-sm text-success-700">{notice}</p>}

      <Card className="mb-6 p-5">
        <h3 className="mb-3 font-semibold text-stone-700">{t("settingsPage.logo.heading")}</h3>
        <div className="flex items-center gap-4">
          {settings.logoPath && (
            <img src={settings.logoPath} alt={t("settingsPage.logo.currentAlt")} className="h-16 w-auto rounded border border-stone-200 p-1" />
          )}
          <label className="cursor-pointer rounded-md border border-stone-300 px-4 py-2 text-sm text-stone-600 hover:border-primary">
            {uploading ? t("settingsPage.logo.uploading") : t("settingsPage.logo.chooseImage")}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              className="hidden"
              disabled={uploading}
              onChange={(e) => e.target.files?.[0] && uploadLogo(e.target.files[0])}
            />
          </label>
        </div>
      </Card>

      <form onSubmit={saveProfile} className="mb-6">
        <Card className="space-y-3 p-5">
        <h3 className="font-semibold text-stone-700">{t("settingsPage.profile.heading")}</h3>
        <input
          placeholder={t("settingsPage.profile.addressPlaceholder")}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <input
            placeholder={t("settingsPage.profile.taxIdPlaceholder")}
            value={taxId}
            onChange={(e) => setTaxId(e.target.value)}
            className="rounded-md border border-stone-300 px-3 py-2 text-sm"
          />
          <input
            placeholder={t("settingsPage.profile.phonePlaceholder")}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="rounded-md border border-stone-300 px-3 py-2 text-sm"
          />
        </div>
        <label className="block text-sm text-stone-600">
          {t("settingsPage.profile.taxRateLabel")}
          <input
            type="number"
            min="0"
            max="100"
            step="0.01"
            value={taxRate}
            onChange={(e) => setTaxRate(e.target.value)}
            className="mt-1 w-40 rounded-md border border-stone-300 px-3 py-2 text-sm"
          />
        </label>
        <Button type="submit">{t("common.save")}</Button>
        </Card>
      </form>

      <Card className="p-5">
        <h3 className="mb-1 font-semibold text-stone-700">{t("settingsPage.features.heading")}</h3>
        <p className="mb-3 text-sm text-stone-500">{t("settingsPage.features.subtitle")}</p>
        <div className="flex items-center justify-between rounded-md border border-stone-200 p-3">
          <div>
            <p className="text-sm font-medium text-stone-800">{t("settingsPage.features.invoicing")}</p>
            <p className="text-xs text-stone-500">{t("settingsPage.features.invoicingDescription")}</p>
          </div>
          <button
            onClick={toggleInvoicing}
            aria-label={t("settingsPage.features.toggleAriaLabel", {
              status: settings.featureFlags.invoicing ? t("settingsPage.features.enabled") : t("settingsPage.features.disabled"),
            })}
          >
            <Badge tone={settings.featureFlags.invoicing ? "success" : "neutral"}>
              {settings.featureFlags.invoicing ? t("settingsPage.features.enabled") : t("settingsPage.features.disabled")}
            </Badge>
          </button>
        </div>
      </Card>
    </Layout>
  );
}
