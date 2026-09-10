import { FormEvent, useEffect, useState } from "react";
import { Layout } from "../components/Layout";
import { apiFetch, ApiError, getToken } from "../api/client";
import { PageHeader } from "../ui/PageHeader";
import { Card } from "../ui/Card";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { ErrorState } from "../ui/ErrorState";
import type { CompanySettings } from "../api/types";

export function Settings() {
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
      setNotice("تم حفظ معلومات الشركة");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر الحفظ");
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
      if (!res.ok) throw new Error(body.error ?? "تعذّر رفع الشعار");
      setNotice("تم رفع الشعار — سيظهر تلقائياً على كل عروض الأسعار والفواتير");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذّر رفع الشعار");
    } finally {
      setUploading(false);
    }
  }

  if (!settings) return null;

  return (
    <Layout>
      <PageHeader title="إعدادات الشركة" subtitle="الشعار، معلومات الشركة، والميزات الاختيارية." />

      {error && (
        <div className="mb-4">
          <ErrorState message={error} />
        </div>
      )}
      {notice && <p className="mb-4 rounded-md bg-success-50 px-3 py-2 text-sm text-success-700">{notice}</p>}

      <Card className="mb-6 p-5">
        <h3 className="mb-3 font-semibold text-stone-700">شعار الشركة (يظهر تلقائياً في ترويسة كل مستند)</h3>
        <div className="flex items-center gap-4">
          {settings.logoPath && (
            <img src={settings.logoPath} alt="الشعار الحالي" className="h-16 w-auto rounded border border-stone-200 p-1" />
          )}
          <label className="cursor-pointer rounded-md border border-stone-300 px-4 py-2 text-sm text-stone-600 hover:border-primary">
            {uploading ? "جارٍ الرفع..." : "اختيار صورة"}
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
        <h3 className="font-semibold text-stone-700">معلومات الشركة (تُملأ تلقائياً في كل عرض سعر وفاتورة)</h3>
        <input
          placeholder="العنوان"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <input
            placeholder="الرقم الضريبي / السجل التجاري"
            value={taxId}
            onChange={(e) => setTaxId(e.target.value)}
            className="rounded-md border border-stone-300 px-3 py-2 text-sm"
          />
          <input
            placeholder="الهاتف"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="rounded-md border border-stone-300 px-3 py-2 text-sm"
          />
        </div>
        <label className="block text-sm text-stone-600">
          نسبة الضريبة الافتراضية (%) — تُطبَّق تلقائياً على كل فاتورة وعرض سعر جديد
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
        <Button type="submit">حفظ</Button>
        </Card>
      </form>

      <Card className="p-5">
        <h3 className="mb-1 font-semibold text-stone-700">الميزات الاختيارية</h3>
        <p className="mb-3 text-sm text-stone-500">فعّلي أو عطّلي أي ميزة حسب حاجة شركتك — لا حاجة لاستخدام ما لا تريدين.</p>
        <div className="flex items-center justify-between rounded-md border border-stone-200 p-3">
          <div>
            <p className="text-sm font-medium text-stone-800">الفوترة</p>
            <p className="text-xs text-stone-500">إنشاء فواتير رسمية بترقيم وضريبة تلقائيين</p>
          </div>
          <button onClick={toggleInvoicing} aria-label={`تبديل ميزة الفوترة، الحالة الحالية: ${settings.featureFlags.invoicing ? "مُفعَّلة" : "معطَّلة"}`}>
            <Badge tone={settings.featureFlags.invoicing ? "success" : "neutral"}>
              {settings.featureFlags.invoicing ? "مُفعَّلة" : "معطَّلة"}
            </Badge>
          </button>
        </div>
      </Card>
    </Layout>
  );
}
