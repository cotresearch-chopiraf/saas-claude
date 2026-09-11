import { useEffect, useState, type FormEvent } from "react";
import { Layout } from "../components/Layout";
import { PageHeader } from "../ui/PageHeader";
import { Card } from "../ui/Card";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { FinancialTable, type FinancialColumn } from "../ui/FinancialTable";
import { ErrorState } from "../ui/ErrorState";
import { Can } from "../auth/Can";
import { formatDate } from "../lib/format";
import { listSuppliers, createSupplier, updateSupplier } from "../api/suppliers";
import { ApiError } from "../api/client";
import type { Supplier, SupplierStatus, SupplierType } from "../api/types";
import { useTranslation } from "../i18n/I18nProvider";

const statusTone: Record<SupplierStatus, "success" | "neutral"> = { active: "success", inactive: "neutral" };

// Global nav page (not project-scoped) — the Supplier domain UI, per the
// UI-02 discovery: a deliberately minimal company-wide directory
// (name/type/tax id/contact/status), consuming the existing, verified
// server/src/routes/suppliers.ts exactly. No calculation of any kind
// applies to this domain — every field is plain stored master data.
export function Suppliers() {
  const { t, locale } = useTranslation();
  const [suppliers, setSuppliers] = useState<Supplier[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  function load() {
    setError(null);
    setSuppliers(null);
    listSuppliers()
      .then(setSuppliers)
      .catch((err) => setError(err instanceof Error ? err.message : t("suppliersPage.loadError")));
  }
  useEffect(load, []);

  const columns: FinancialColumn<Supplier>[] = [
    { key: "name", header: t("suppliersPage.columns.name"), render: (s) => s.name },
    { key: "type", header: t("suppliersPage.columns.type"), render: (s) => t(`suppliersPage.type.${s.type}`) },
    { key: "taxId", header: t("suppliersPage.columns.taxId"), render: (s) => s.taxId ?? "—" },
    { key: "email", header: t("suppliersPage.columns.email"), render: (s) => s.email ?? "—" },
    { key: "phone", header: t("suppliersPage.columns.phone"), render: (s) => s.phone ?? "—" },
    { key: "status", header: t("suppliersPage.columns.status"), render: (s) => <Badge tone={statusTone[s.status]}>{t(`suppliersPage.status.${s.status}`)}</Badge> },
    { key: "createdAt", header: t("suppliersPage.columns.createdAt"), render: (s) => formatDate(s.createdAt, locale) },
  ];

  return (
    <Layout>
      <PageHeader
        title={t("suppliersPage.title")}
        actions={
          <Can permission="supplier.manage">
            <Button size="sm" onClick={() => setShowCreate((v) => !v)}>
              {showCreate ? t("common.cancel") : t("suppliersPage.newSupplier")}
            </Button>
          </Can>
        }
      />

      {showCreate && (
        <Can permission="supplier.manage">
          <div className="mb-6">
            <SupplierForm
              onCreated={() => {
                setShowCreate(false);
                load();
              }}
            />
          </div>
        </Can>
      )}

      <FinancialTable
        columns={columns}
        rows={suppliers}
        rowKey={(s) => s.id}
        error={error}
        onRetry={load}
        emptyMessage={t("suppliersPage.emptyMessage")}
        rowActions={(s) => (
          <Can permission="supplier.manage">
            <SupplierRowActions supplier={s} onChanged={load} />
          </Can>
        )}
      />
    </Layout>
  );
}

function SupplierForm({ onCreated }: { onCreated: (supplier: Supplier) => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [type, setType] = useState<SupplierType>("supplier");
  const [taxId, setTaxId] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const supplier = await createSupplier({
        name,
        type,
        taxId: taxId || undefined,
        email: email || undefined,
        phone: phone || undefined,
        address: address || undefined,
      });
      onCreated(supplier);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("suppliersPage.form.genericError"));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="p-5">
      <form onSubmit={onSubmit} className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {error && (
          <div className="sm:col-span-3">
            <ErrorState message={error} />
          </div>
        )}
        <input
          required
          placeholder={t("suppliersPage.form.namePlaceholder")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <select
          value={type}
          onChange={(e) => setType(e.target.value as SupplierType)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        >
          <option value="supplier">{t("suppliersPage.type.supplier")}</option>
          <option value="subcontractor">{t("suppliersPage.type.subcontractor")}</option>
        </select>
        <input
          placeholder={t("suppliersPage.form.taxIdPlaceholder")}
          value={taxId}
          onChange={(e) => setTaxId(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <input
          type="email"
          placeholder={t("suppliersPage.form.emailPlaceholder")}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <input
          placeholder={t("suppliersPage.form.phonePlaceholder")}
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <input
          placeholder={t("suppliersPage.form.addressPlaceholder")}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <Button type="submit" disabled={submitting}>
          {submitting ? t("suppliersPage.form.saving") : t("suppliersPage.form.save")}
        </Button>
      </form>
    </Card>
  );
}

function SupplierRowActions({ supplier, onChanged }: { supplier: Supplier; onChanged: () => void }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(supplier.name);
  const [taxId, setTaxId] = useState(supplier.taxId ?? "");
  const [email, setEmail] = useState(supplier.email ?? "");
  const [phone, setPhone] = useState(supplier.phone ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSave() {
    setBusy(true);
    setError(null);
    try {
      await updateSupplier(supplier.id, {
        name,
        taxId: taxId || undefined,
        email: email || undefined,
        phone: phone || undefined,
      });
      setEditing(false);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("suppliersPage.rowActions.saveError"));
    } finally {
      setBusy(false);
    }
  }

  async function onToggleStatus() {
    setBusy(true);
    setError(null);
    try {
      await updateSupplier(supplier.id, { status: supplier.status === "active" ? "inactive" : "active" });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("suppliersPage.rowActions.statusError"));
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <div className="flex flex-col items-end gap-1">
        {error && <span className="text-xs text-danger-600">{error}</span>}
        <div className="flex flex-wrap justify-end gap-1">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-28 rounded-md border border-stone-300 px-2 py-1 text-xs"
          />
          <input
            value={taxId}
            onChange={(e) => setTaxId(e.target.value)}
            placeholder={t("suppliersPage.rowActions.taxIdPlaceholder")}
            className="w-24 rounded-md border border-stone-300 px-2 py-1 text-xs"
          />
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t("suppliersPage.rowActions.emailPlaceholder")}
            className="w-32 rounded-md border border-stone-300 px-2 py-1 text-xs"
          />
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder={t("suppliersPage.rowActions.phonePlaceholder")}
            className="w-24 rounded-md border border-stone-300 px-2 py-1 text-xs"
          />
          <Button size="sm" onClick={onSave} disabled={busy}>
            {t("common.save")}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setEditing(false)} disabled={busy}>
            {t("common.cancel")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-end gap-3">
      {error && <span className="text-xs text-danger-600">{error}</span>}
      <button type="button" onClick={() => setEditing(true)} className="text-sm text-primary hover:underline">
        {t("suppliersPage.rowActions.edit")}
      </button>
      <button type="button" onClick={onToggleStatus} disabled={busy} className="text-sm text-stone-500 hover:underline">
        {supplier.status === "active" ? t("suppliersPage.rowActions.deactivate") : t("suppliersPage.rowActions.reactivate")}
      </button>
    </div>
  );
}
