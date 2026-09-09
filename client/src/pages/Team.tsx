import { FormEvent, useEffect, useState } from "react";
import { Layout } from "../components/Layout";
import { apiFetch, ApiError } from "../api/client";
import { Can } from "../auth/Can";
import type { CompanyInvite, CompanyMember, CompanyRole } from "../api/types";

const roleLabel: Record<string, string> = { owner: "مالك", member: "عضو" };
const statusLabel: Record<string, string> = { active: "نشط", deactivated: "معطّل" };

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
      // Recovered — the backend already reports whether the invite email
      // actually sent (emailDelivered, server/src/routes/company.ts) via
      // MAIL_PROVIDER; this page previously ignored it and always showed a
      // dev-facing "look in the server log" message, even in a real
      // deployment where the email was genuinely delivered. Never claims
      // delivery when the backend didn't confirm it.
      const result = await apiFetch<{ emailDelivered: boolean }>("/company/invites", {
        method: "POST",
        body: JSON.stringify({ email, role: "member" }),
      });
      setEmail("");
      setNotice(
        result.emailDelivered
          ? "أُرسلت الدعوة عبر البريد الإلكتروني."
          : "تعذّر إرسال البريد الإلكتروني — لم يتم إعداد مزوّد بريد حقيقي بعد. شارِكي رابط الدعوة يدوياً من سجلات الخادم.",
      );
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
          <MemberRow key={m.id} member={m} onChanged={load} />
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

// MIDAD Phase A — role change / deactivate / reactivate. Gated by the same
// company.manage permission the invite form above is authoritatively
// enforced by server-side (see server/src/routes/company.ts's requireOwner);
// mirrored client-side here only as a UX courtesy, per auth/permissions.ts.
function MemberRow({ member, onChanged }: { member: CompanyMember; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function patch(body: { role?: CompanyRole; status?: "active" | "deactivated" }) {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/company/members/${member.id}`, { method: "PATCH", body: JSON.stringify(body) });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر حفظ التغيير");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex items-center justify-between gap-3 p-3 text-sm">
      <div>
        <p className="text-stone-800">{member.name}</p>
        <p className="text-stone-500">{member.email}</p>
        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>
      <div className="flex items-center gap-2">
        <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-600">
          {statusLabel[member.status]}
        </span>
        <Can permission="company.manage">
          <select
            value={member.role}
            disabled={busy}
            onChange={(e) => patch({ role: e.target.value as CompanyRole })}
            className="rounded-md border border-stone-300 px-2 py-1 text-xs"
          >
            <option value="owner">مالك</option>
            <option value="member">عضو</option>
          </select>
          <button
            type="button"
            disabled={busy}
            onClick={() => patch({ status: member.status === "active" ? "deactivated" : "active" })}
            className="text-xs text-stone-500 hover:underline disabled:opacity-50"
          >
            {member.status === "active" ? "إلغاء التفعيل" : "إعادة التفعيل"}
          </button>
        </Can>
        <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs text-stone-600">{roleLabel[member.role]}</span>
      </div>
    </li>
  );
}
