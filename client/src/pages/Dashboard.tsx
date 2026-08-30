import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Layout } from "../components/Layout";
import { apiFetch } from "../api/client";
import { listCustomers } from "../api/customers";
import type { Customer, Project } from "../api/types";

const statusLabel: Record<Project["status"], string> = {
  active: "نشط",
  on_hold: "متوقف مؤقتاً",
  completed: "مكتمل",
};

const statusColor: Record<Project["status"], string> = {
  active: "bg-emerald-100 text-emerald-700",
  on_hold: "bg-amber-100 text-amber-700",
  completed: "bg-stone-200 text-stone-600",
};

export function Dashboard() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);

  function load() {
    apiFetch<Project[]>("/projects").then(setProjects).finally(() => setLoading(false));
  }

  useEffect(load, []);

  return (
    <Layout>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-stone-800">المشاريع</h1>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white"
        >
          {showForm ? "إلغاء" : "+ مشروع جديد"}
        </button>
      </div>

      {showForm && (
        <NewProjectForm
          onCreated={() => {
            setShowForm(false);
            load();
          }}
        />
      )}

      {loading ? (
        <p className="text-stone-500">جارٍ التحميل...</p>
      ) : projects.length === 0 ? (
        <p className="rounded-lg border border-dashed border-stone-300 p-8 text-center text-stone-500">
          لا توجد مشاريع بعد. أنشئ أول مشروع لبدء تتبع الميزانية والمهام.
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {projects.map((p) => (
            <Link
              key={p.id}
              to={`/projects/${p.id}`}
              className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm transition hover:border-primary"
            >
              <div className="mb-2 flex items-start justify-between gap-2">
                <h2 className="font-semibold text-stone-800">{p.name}</h2>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${statusColor[p.status]}`}>
                  {statusLabel[p.status]}
                </span>
              </div>
              {p.clientName && <p className="text-sm text-stone-500">العميل: {p.clientName}</p>}
              <p className="mt-2 text-sm font-medium text-stone-700">
                الميزانية: {Number(p.budgetTotal).toLocaleString("ar")} $
              </p>
            </Link>
          ))}
        </div>
      )}
    </Layout>
  );
}

function NewProjectForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [clientName, setClientName] = useState("");
  // MIDAD Phase A' — an entirely optional, independent link to a
  // first-class Customer. Never required, never derived from/synced with
  // clientName above — a project may set either, both, or neither.
  const [customerId, setCustomerId] = useState("");
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [budgetTotal, setBudgetTotal] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listCustomers()
      .then(setCustomers)
      .catch(() => setCustomers([]));
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await apiFetch("/projects", {
        method: "POST",
        body: JSON.stringify({ name, clientName, customerId: customerId || undefined, budgetTotal: budgetTotal || 0 }),
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "تعذّر إنشاء المشروع");
    }
  }

  return (
    <form onSubmit={onSubmit} className="mb-6 grid gap-3 rounded-lg border border-stone-200 bg-white p-5 sm:grid-cols-3">
      {error && <div className="col-span-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      <input
        required
        placeholder="اسم المشروع"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="rounded-md border border-stone-300 px-3 py-2 text-sm"
      />
      <input
        placeholder="اسم العميل"
        value={clientName}
        onChange={(e) => setClientName(e.target.value)}
        className="rounded-md border border-stone-300 px-3 py-2 text-sm"
      />
      <select
        value={customerId}
        onChange={(e) => setCustomerId(e.target.value)}
        className="rounded-md border border-stone-300 px-3 py-2 text-sm"
      >
        <option value="">ربط بعميل (اختياري)</option>
        {customers.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <input
        type="number"
        min="0"
        placeholder="الميزانية الإجمالية ($)"
        value={budgetTotal}
        onChange={(e) => setBudgetTotal(e.target.value)}
        className="rounded-md border border-stone-300 px-3 py-2 text-sm"
      />
      <button type="submit" className="col-span-3 rounded-md bg-primary py-2 text-sm font-medium text-white sm:col-span-1">
        حفظ المشروع
      </button>
    </form>
  );
}
