import { FormEvent, useEffect, useState } from "react";
import { Layout } from "../components/Layout";
import { apiFetch, ApiError } from "../api/client";
import type { CompanyInvite, CompanyMember } from "../api/types";

const roleLabel: Record<string, string> = { owner: "مالك", member: "عضو" };

export function Team() {
  const [members, setMembers] = useState<CompanyMember[]>([]);
  const [invites, setInvites] = useState<CompanyInvite[]>([]);
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function load() {
    apiFetch<CompanyMember[]>("/company/members").then(setMembers);
    apiFetch<CompanyInvite[]>("/company/invites").then(setInvites).catch(() => setInvites([]));
  }
  useEffect(load, []);

  async function invite(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      await apiFetch("/company/invites", { method: "POST", body: JSON.stringify({ email, role: "member" }) });
      setEmail("");
      setNotice("أُرسلت الدعوة (رابطها مطبوع في سجل الخادم إلى أن يُربط مزوّد بريد حقيقي)");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر إرسال الدعوة");
    }
  }

  return (
    <Layout>
      <h1 className="mb-6 text-2xl font-bold text-stone-800">الفريق</h1>

      <h3 className="mb-2 font-semibold text-stone-700">الأعضاء</h3>
      <ul className="mb-6 divide-y divide-stone-100 rounded-lg border border-stone-200 bg-white">
        {members.map((m) => (
          <li key={m.id} className="flex items-center justify-between p-3 text-sm">
            <div>
              <p className="text-stone-800">{m.name}</p>
              <p className="text-stone-500">{m.email}</p>
            </div>
            <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-600">{roleLabel[m.role]}</span>
          </li>
        ))}
      </ul>

      {invites.length > 0 && (
        <>
          <h3 className="mb-2 font-semibold text-stone-700">دعوات بانتظار القبول</h3>
          <ul className="mb-6 divide-y divide-stone-100 rounded-lg border border-stone-200 bg-white">
            {invites.map((inv) => (
              <li key={inv.id} className="p-3 text-sm text-stone-600">{inv.email}</li>
            ))}
          </ul>
        </>
      )}

      <h3 className="mb-2 font-semibold text-stone-700">دعوة عضو جديد</h3>
      {error && <div className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {notice && <div className="mb-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</div>}
      <form onSubmit={invite} className="flex gap-2">
        <input
          type="email"
          required
          placeholder="البريد الإلكتروني"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="flex-1 rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <button className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white">إرسال دعوة</button>
      </form>
    </Layout>
  );
}
