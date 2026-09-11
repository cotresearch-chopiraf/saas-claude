import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Layout } from "../components/Layout";
import { PageHeader } from "../ui/PageHeader";
import { Card } from "../ui/Card";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { FinancialTable, type FinancialColumn } from "../ui/FinancialTable";
import { ErrorState } from "../ui/ErrorState";
import { Can } from "../auth/Can";
import { formatDate } from "../lib/format";
import { listCustomers, createCustomer, updateCustomer } from "../api/customers";
import { ApiError } from "../api/client";
import type { Customer, CustomerStatus } from "../api/types";
import { useTranslation } from "../i18n/I18nProvider";

const statusTone: Record<CustomerStatus, "success" | "neutral"> = { active: "success", inactive: "neutral" };

// MIDAD Phase A' — the Customer domain UI, deliberately minimal (mirrors
// pages/Suppliers.tsx exactly) — a company-wide directory, not a CRM.
// Global nav page (not project-scoped), consuming the existing, verified
// server/src/routes/customers.ts.
export function Customers() {
  const { t, locale } = useTranslation();
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  function load() {
    setError(null);
    setCustomers(null);
    listCustomers()
      .then(setCustomers)
      .catch((err) => setError(err instanceof Error ? err.message : t("customersPage.loadError")));
  }
  useEffect(load, []);

  const columns: FinancialColumn<Customer>[] = [
    { key: "name", header: t("customersPage.columns.name"), render: (c) => c.name },
    { key: "contactName", header: t("customersPage.columns.contactName"), render: (c) => c.contactName ?? "—" },
    { key: "taxId", header: t("customersPage.columns.taxId"), render: (c) => c.taxId ?? "—" },
    { key: "email", header: t("customersPage.columns.email"), render: (c) => c.email ?? "—" },
    { key: "phone", header: t("customersPage.columns.phone"), render: (c) => c.phone ?? "—" },
    { key: "status", header: t("customersPage.columns.status"), render: (c) => <Badge tone={statusTone[c.status]}>{t(`customerDetail.status.${c.status}`)}</Badge> },
    { key: "createdAt", header: t("customersPage.columns.createdAt"), render: (c) => formatDate(c.createdAt, locale) },
  ];

  return (
    <Layout>
      <PageHeader
        title={t("customersPage.title")}
        subtitle={t("customersPage.subtitle")}
        actions={
          <Can permission="customer.manage">
            <Button size="sm" onClick={() => setShowCreate((v) => !v)}>
              {showCreate ? t("common.cancel") : t("customersPage.newCustomer")}
            </Button>
          </Can>
        }
      />

      {showCreate && (
        <Can permission="customer.manage">
          <div className="mb-6">
            <CustomerForm
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
        rows={customers}
        rowKey={(c) => c.id}
        error={error}
        onRetry={load}
        emptyMessage={t("customersPage.emptyMessage")}
        rowActions={(c) => (
          <div className="flex justify-end gap-3">
            <Link to={`/customers/${c.id}`} className="text-sm text-primary hover:underline">
              {t("customersPage.view")}
            </Link>
            <Can permission="customer.manage">
              <CustomerRowActions customer={c} onChanged={load} />
            </Can>
          </div>
        )}
      />
    </Layout>
  );
}

function CustomerForm({ onCreated }: { onCreated: (customer: Customer) => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [contactName, setContactName] = useState("");
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
      const customer = await createCustomer({
        name,
        contactName: contactName || undefined,
        taxId: taxId || undefined,
        email: email || undefined,
        phone: phone || undefined,
        address: address || undefined,
      });
      onCreated(customer);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("customersPage.form.genericError"));
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
          placeholder={t("customersPage.form.namePlaceholder")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <input
          placeholder={t("customersPage.form.contactNamePlaceholder")}
          value={contactName}
          onChange={(e) => setContactName(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <input
          placeholder={t("customersPage.form.taxIdPlaceholder")}
          value={taxId}
          onChange={(e) => setTaxId(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <input
          type="email"
          placeholder={t("customersPage.form.emailPlaceholder")}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <input
          placeholder={t("customersPage.form.phonePlaceholder")}
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <input
          placeholder={t("customersPage.form.addressPlaceholder")}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <Button type="submit" disabled={submitting}>
          {submitting ? t("customersPage.form.saving") : t("customersPage.form.save")}
        </Button>
      </form>
    </Card>
  );
}

function CustomerRowActions({ customer, onChanged }: { customer: Customer; onChanged: () => void }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(customer.name);
  const [contactName, setContactName] = useState(customer.contactName ?? "");
  const [email, setEmail] = useState(customer.email ?? "");
  const [phone, setPhone] = useState(customer.phone ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSave() {
    setBusy(true);
    setError(null);
    try {
      await updateCustomer(customer.id, {
        name,
        contactName: contactName || undefined,
        email: email || undefined,
        phone: phone || undefined,
      });
      setEditing(false);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("customersPage.rowActions.saveError"));
    } finally {
      setBusy(false);
    }
  }

  async function onToggleStatus() {
    setBusy(true);
    setError(null);
    try {
      await updateCustomer(customer.id, { status: customer.status === "active" ? "inactive" : "active" });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("customersPage.rowActions.statusError"));
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
            value={contactName}
            onChange={(e) => setContactName(e.target.value)}
            placeholder={t("customersPage.rowActions.contactNamePlaceholder")}
            className="w-24 rounded-md border border-stone-300 px-2 py-1 text-xs"
          />
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t("customersPage.rowActions.emailPlaceholder")}
            className="w-32 rounded-md border border-stone-300 px-2 py-1 text-xs"
          />
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder={t("customersPage.rowActions.phonePlaceholder")}
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
        {t("customersPage.rowActions.edit")}
      </button>
      <button type="button" onClick={onToggleStatus} disabled={busy} className="text-sm text-stone-500 hover:underline">
        {customer.status === "active" ? t("customersPage.rowActions.deactivate") : t("customersPage.rowActions.reactivate")}
      </button>
    </div>
  );
}
