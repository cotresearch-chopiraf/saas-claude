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

const typeLabel: Record<SupplierType, string> = { supplier: "مورد", subcontractor: "مقاول من الباطن" };
const statusLabel: Record<SupplierStatus, string> = { active: "نشط", inactive: "غير نشط" };
const statusTone: Record<SupplierStatus, "success" | "neutral"> = { active: "success", inactive: "neutral" };

// Global nav page (not project-scoped) — the Supplier domain UI, per the
// UI-02 discovery: a deliberately minimal company-wide directory
// (name/type/tax id/contact/status), consuming the existing, verified
// server/src/routes/suppliers.ts exactly. No calculation of any kind
// applies to this domain — every field is plain stored master data.
export function Suppliers() {
  const [suppliers, setSuppliers] = useState<Supplier[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  function load() {
    setError(null);
    setSuppliers(null);
    listSuppliers()
      .then(setSuppliers)
      .catch((err) => setError(err instanceof Error ? err.message : "تعذّر تحميل قائمة الموردين"));
  }
  useEffect(load, []);

  const columns: FinancialColumn<Supplier>[] = [
    { key: "name", header: "الاسم", render: (s) => s.name },
    { key: "type", header: "النوع", render: (s) => typeLabel[s.type] },
    { key: "taxId", header: "الرقم الضريبي", render: (s) => s.taxId ?? "—" },
    { key: "email", header: "البريد الإلكتروني", render: (s) => s.email ?? "—" },
    { key: "phone", header: "الهاتف", render: (s) => s.phone ?? "—" },
    { key: "status", header: "الحالة", render: (s) => <Badge tone={statusTone[s.status]}>{statusLabel[s.status]}</Badge> },
    { key: "createdAt", header: "تاريخ الإضافة", render: (s) => formatDate(s.createdAt) },
  ];

  return (
    <Layout>
      <PageHeader
        title="الموردون"
        actions={
          <Can permission="supplier.manage">
            <Button size="sm" onClick={() => setShowCreate((v) => !v)}>
              {showCreate ? "إلغاء" : "+ مورد جديد"}
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
        emptyMessage="لا يوجد موردون بعد"
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
      setError(err instanceof ApiError ? err.message : "تعذّر إضافة المورد");
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
          placeholder="اسم المورد"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <select
          value={type}
          onChange={(e) => setType(e.target.value as SupplierType)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        >
          <option value="supplier">مورد</option>
          <option value="subcontractor">مقاول من الباطن</option>
        </select>
        <input
          placeholder="الرقم الضريبي (اختياري)"
          value={taxId}
          onChange={(e) => setTaxId(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <input
          type="email"
          placeholder="البريد الإلكتروني (اختياري)"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <input
          placeholder="الهاتف (اختياري)"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <input
          placeholder="العنوان (اختياري)"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <Button type="submit" disabled={submitting}>
          {submitting ? "جارٍ الحفظ..." : "حفظ المورد"}
        </Button>
      </form>
    </Card>
  );
}

function SupplierRowActions({ supplier, onChanged }: { supplier: Supplier; onChanged: () => void }) {
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
      setError(err instanceof ApiError ? err.message : "تعذّر حفظ التعديل");
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
      setError(err instanceof ApiError ? err.message : "تعذّر تغيير حالة المورد");
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
            placeholder="الرقم الضريبي"
            className="w-24 rounded-md border border-stone-300 px-2 py-1 text-xs"
          />
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="البريد الإلكتروني"
            className="w-32 rounded-md border border-stone-300 px-2 py-1 text-xs"
          />
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="الهاتف"
            className="w-24 rounded-md border border-stone-300 px-2 py-1 text-xs"
          />
          <Button size="sm" onClick={onSave} disabled={busy}>
            حفظ
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setEditing(false)} disabled={busy}>
            إلغاء
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-end gap-3">
      {error && <span className="text-xs text-danger-600">{error}</span>}
      <button type="button" onClick={() => setEditing(true)} className="text-sm text-primary hover:underline">
        تعديل
      </button>
      <button type="button" onClick={onToggleStatus} disabled={busy} className="text-sm text-stone-500 hover:underline">
        {supplier.status === "active" ? "إلغاء التنشيط" : "إعادة التنشيط"}
      </button>
    </div>
  );
}
