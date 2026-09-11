import { FormEvent, useEffect, useState } from "react";
import { Layout } from "../components/Layout";
import { apiFetch, ApiError } from "../api/client";
import { Can } from "../auth/Can";
import { PageHeader } from "../ui/PageHeader";
import { Card } from "../ui/Card";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { ErrorState } from "../ui/ErrorState";
import type { CompanyInvite, CompanyMember, CompanyRole } from "../api/types";
import { useTranslation } from "../i18n/I18nProvider";

export function Team() {
  const { t } = useTranslation();
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
          ? t("team.inviteSentByEmail")
          : t("team.inviteNoProvider"),
      );
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("team.inviteError"));
    }
  }

  return (
    <Layout>
      <PageHeader title={t("team.title")} subtitle={t("team.subtitle")} />

      <h3 className="mb-2 font-semibold text-stone-700">{t("team.membersHeading")}</h3>
      <ul className="mb-6 divide-y divide-stone-100 rounded-lg border border-stone-200 bg-white">
        {members.map((m) => (
          <MemberRow key={m.id} member={m} onChanged={load} />
        ))}
      </ul>

      {invites.length > 0 && (
        <>
          <h3 className="mb-2 font-semibold text-stone-700">{t("team.pendingInvitesHeading")}</h3>
          <ul className="mb-6 divide-y divide-stone-100 rounded-lg border border-stone-200 bg-white">
            {invites.map((inv) => (
              <li key={inv.id} className="p-3 text-sm text-stone-600">{inv.email}</li>
            ))}
          </ul>
        </>
      )}

      <h3 className="mb-2 font-semibold text-stone-700">{t("team.inviteHeading")}</h3>
      <Card className="p-5">
        <form onSubmit={invite} className="space-y-3">
          {error && <ErrorState message={error} />}
          {notice && <p className="rounded-md bg-success-50 px-3 py-2 text-sm text-success-700">{notice}</p>}
          <div className="flex gap-2">
            <input
              type="email"
              required
              placeholder={t("team.emailPlaceholder")}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="flex-1 rounded-md border border-stone-300 px-3 py-2 text-sm"
            />
            <Button type="submit">{t("team.sendInvite")}</Button>
          </div>
        </form>
      </Card>
    </Layout>
  );
}

// MIDAD Phase A — role change / deactivate / reactivate. Gated by the same
// company.manage permission the invite form above is authoritatively
// enforced by server-side (see server/src/routes/company.ts's requireOwner);
// mirrored client-side here only as a UX courtesy, per auth/permissions.ts.
function MemberRow({ member, onChanged }: { member: CompanyMember; onChanged: () => void }) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function patch(body: { role?: CompanyRole; status?: "active" | "deactivated" }) {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/company/members/${member.id}`, { method: "PATCH", body: JSON.stringify(body) });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("team.saveChangeError"));
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
        <Badge tone={member.status === "active" ? "success" : "neutral"}>{t(`team.status.${member.status}`)}</Badge>
        <Can permission="company.manage">
          <select
            value={member.role}
            disabled={busy}
            onChange={(e) => patch({ role: e.target.value as CompanyRole })}
            className="rounded-md border border-stone-300 px-2 py-1 text-xs"
          >
            <option value="owner">{t("team.role.owner")}</option>
            <option value="member">{t("team.role.member")}</option>
          </select>
          <button
            type="button"
            disabled={busy}
            onClick={() => patch({ status: member.status === "active" ? "deactivated" : "active" })}
            className="text-xs text-stone-500 hover:underline disabled:opacity-50"
          >
            {member.status === "active" ? t("team.deactivate") : t("team.reactivate")}
          </button>
        </Can>
        <Badge tone="neutral">{t(`team.role.${member.role}`)}</Badge>
      </div>
    </li>
  );
}
