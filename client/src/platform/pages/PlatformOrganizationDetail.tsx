import { useEffect, useState, type FormEvent } from "react";
import { useParams, Link } from "react-router-dom";
import { PlatformLayout } from "../components/PlatformLayout";
import { PageHeader, Card, Badge, Button, ErrorState, Skeleton, EmptyState, ConfirmDialog, Modal, FinancialTable, type FinancialColumn } from "../../ui";
import { ApiError } from "../../api/client";
import { formatDateTime } from "../../lib/format";
import {
  getOrganization,
  listOrganizationUsers,
  suspendOrganization,
  reactivateOrganization,
  revokeOrganizationSessions,
  setOrganizationUserStatus,
  revokeOrganizationUserSessions,
} from "../api/orgUsers";
import { listPlans, assignPlan } from "../api/plans";
import { exportOrganization } from "../api/tenantData";
import type { OrganizationDetail, PlatformOrgUser, Plan } from "../api/types";
import { useTranslation } from "../../i18n/I18nProvider";

// MIDAD Final Pre-Launch audit, Phase 22 (UX) — the client surface for
// Phases 4 (org detail/status), 5 (per-org user management), 3 (plan
// assignment), and 10-11 (tenant export) — grouped on one page because
// every one of them operates on the same single organization, not because
// their backends are related.
export function PlatformOrganizationDetail() {
  const { id } = useParams<{ id: string }>();
  const { t, locale } = useTranslation();
  const [org, setOrg] = useState<OrganizationDetail | null>(null);
  const [orgError, setOrgError] = useState<string | null>(null);
  const [users, setUsers] = useState<PlatformOrgUser[] | null>(null);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [plans, setPlans] = useState<Plan[] | null>(null);

  const [suspendOpen, setSuspendOpen] = useState(false);
  const [suspendReason, setSuspendReason] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  const [revokeOrgOpen, setRevokeOrgOpen] = useState(false);
  const [userActionFor, setUserActionFor] = useState<PlatformOrgUser | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportNotice, setExportNotice] = useState<string | null>(null);

  function loadOrg() {
    if (!id) return;
    setOrg(null);
    setOrgError(null);
    getOrganization(id)
      .then(setOrg)
      .catch((err) => setOrgError(err instanceof ApiError ? err.message : t("platformOrgDetailPage.loadError")));
  }

  function loadUsers() {
    if (!id) return;
    setUsers(null);
    setUsersError(null);
    listOrganizationUsers(id)
      .then((page) => setUsers(page.users))
      .catch((err) => setUsersError(err instanceof ApiError ? err.message : t("platformOrgDetailPage.usersLoadError")));
  }

  useEffect(() => {
    loadOrg();
    loadUsers();
    listPlans()
      .then((page) => setPlans(page.plans))
      .catch(() => setPlans([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function onSuspendConfirm() {
    if (!id) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await suspendOrganization(id, suspendReason);
      setSuspendOpen(false);
      setSuspendReason("");
      loadOrg();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t("common.errorGeneric"));
    } finally {
      setActionBusy(false);
    }
  }

  async function onReactivate() {
    if (!id) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await reactivateOrganization(id);
      loadOrg();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t("common.errorGeneric"));
    } finally {
      setActionBusy(false);
    }
  }

  async function onRevokeOrgConfirm() {
    if (!id) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await revokeOrganizationSessions(id, t("platformOrgDetailPage.revokeSessionsDefaultReason"));
      setRevokeOrgOpen(false);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t("common.errorGeneric"));
    } finally {
      setActionBusy(false);
    }
  }

  async function onAssignPlan(planKey: string) {
    if (!id) return;
    setActionError(null);
    try {
      await assignPlan(id, planKey || null);
      loadOrg();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : t("common.errorGeneric"));
    }
  }

  async function onExport() {
    if (!id || !org) return;
    setExporting(true);
    setExportNotice(null);
    try {
      const bundle = await exportOrganization(id);
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `midad-export-${org.name}-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setExportNotice(t("platformOrgDetailPage.exportSuccess"));
    } catch (err) {
      setExportNotice(err instanceof ApiError ? err.message : t("common.errorGeneric"));
    } finally {
      setExporting(false);
    }
  }

  const userColumns: FinancialColumn<PlatformOrgUser>[] = [
    { key: "name", header: t("platformOrgDetailPage.users.columns.name"), render: (u) => u.name },
    { key: "email", header: t("platformOrgDetailPage.users.columns.email"), render: (u) => u.email },
    { key: "role", header: t("platformOrgDetailPage.users.columns.role"), render: (u) => u.role },
    {
      key: "status",
      header: t("platformOrgDetailPage.users.columns.status"),
      render: (u) => <Badge tone={u.status === "active" ? "success" : "neutral"}>{t(`platformOrgDetailPage.users.status.${u.status}`)}</Badge>,
    },
  ];

  if (orgError) {
    return (
      <PlatformLayout>
        <ErrorState message={orgError} onRetry={loadOrg} />
      </PlatformLayout>
    );
  }

  if (!org) {
    return (
      <PlatformLayout>
        <Skeleton rows={6} />
      </PlatformLayout>
    );
  }

  return (
    <PlatformLayout>
      <PageHeader
        title={org.name}
        subtitle={t("platformOrgDetailPage.subtitle")}
        actions={
          <div className="flex items-center gap-2">
            <Badge tone={org.status === "active" ? "success" : "danger"}>{t(`platformOrgDetailPage.orgStatus.${org.status}`)}</Badge>
            <Link to="/platform/organizations" className="text-sm text-primary hover:underline">
              {t("platformOrgDetailPage.backToList")}
            </Link>
          </div>
        }
      />

      {actionError && <div className="mb-4"><ErrorState message={actionError} /></div>}
      {exportNotice && <div className="mb-4"><ErrorState message={exportNotice} /></div>}

      <section className="mb-8 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Card className="p-4">
          <p className="text-xs text-stone-500">{t("platformOrgDetailPage.metrics.users")}</p>
          <p className="mt-1 text-lg font-bold text-stone-800">{org.usage.userCount}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-stone-500">{t("platformOrgDetailPage.metrics.projects")}</p>
          <p className="mt-1 text-lg font-bold text-stone-800">{org.usage.projectCount}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-stone-500">{t("platformOrgDetailPage.metrics.egsUnits")}</p>
          <p className="mt-1 text-lg font-bold text-stone-800">{org.zatca.egsUnitCount}</p>
        </Card>
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold text-stone-700">{t("platformOrgDetailPage.actionsHeading")}</h2>
        <div className="flex flex-wrap gap-2">
          {org.status === "active" ? (
            <Button variant="danger" size="sm" onClick={() => setSuspendOpen(true)}>
              {t("platformOrgDetailPage.suspend")}
            </Button>
          ) : (
            <Button variant="secondary" size="sm" disabled={actionBusy} onClick={onReactivate}>
              {t("platformOrgDetailPage.reactivate")}
            </Button>
          )}
          <Button variant="secondary" size="sm" onClick={() => setRevokeOrgOpen(true)}>
            {t("platformOrgDetailPage.revokeAllSessions")}
          </Button>
          <Button variant="secondary" size="sm" disabled={exporting} onClick={onExport}>
            {exporting ? t("platformOrgDetailPage.exporting") : t("platformOrgDetailPage.exportData")}
          </Button>
        </div>
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold text-stone-700">{t("platformOrgDetailPage.planHeading")}</h2>
        <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
          <span className="text-sm text-stone-700">{org.plan ? org.plan.name : t("platformOrgDetailPage.noPlan")}</span>
          {plans && (
            <select
              className="rounded-md border border-stone-300 px-3 py-2 text-sm"
              value={org.plan?.key ?? ""}
              onChange={(e) => onAssignPlan(e.target.value)}
            >
              <option value="">{t("platformOrgDetailPage.noPlan")}</option>
              {plans.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
        </Card>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-stone-700">{t("platformOrgDetailPage.users.heading")}</h2>
        {usersError ? (
          <ErrorState message={usersError} onRetry={loadUsers} />
        ) : !users ? (
          <Skeleton rows={3} />
        ) : users.length === 0 ? (
          <EmptyState message={t("platformOrgDetailPage.users.emptyMessage")} />
        ) : (
          <FinancialTable
            columns={userColumns}
            rows={users}
            rowKey={(u) => u.id}
            rowActions={(u) => (
              <Button size="sm" variant="secondary" onClick={() => setUserActionFor(u)}>
                {t("platformOrgDetailPage.users.manage")}
              </Button>
            )}
          />
        )}
      </section>

      <Modal open={suspendOpen} onClose={() => setSuspendOpen(false)} title={t("platformOrgDetailPage.suspendDialog.title")}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSuspendConfirm();
          }}
          className="space-y-3"
        >
          <p className="text-sm text-stone-600">{t("platformOrgDetailPage.suspendDialog.message")}</p>
          <textarea
            autoFocus
            required
            minLength={3}
            placeholder={t("platformOrgDetailPage.suspendDialog.reasonPlaceholder")}
            value={suspendReason}
            onChange={(e) => setSuspendReason(e.target.value)}
            rows={2}
            className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
          />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => setSuspendOpen(false)} disabled={actionBusy}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" variant="danger" size="sm" disabled={actionBusy}>
              {actionBusy ? t("platformOrgDetailPage.suspending") : t("platformOrgDetailPage.suspend")}
            </Button>
          </div>
        </form>
      </Modal>

      <ConfirmDialog
        open={revokeOrgOpen}
        title={t("platformOrgDetailPage.revokeSessionsDialog.title")}
        message={t("platformOrgDetailPage.revokeSessionsDialog.message")}
        confirmLabel={actionBusy ? t("platformOrgDetailPage.revoking") : t("platformOrgDetailPage.revokeAllSessions")}
        destructive
        onConfirm={onRevokeOrgConfirm}
        onCancel={() => setRevokeOrgOpen(false)}
      />

      {userActionFor && id && (
        <UserActionModal
          organizationId={id}
          user={userActionFor}
          onClose={() => setUserActionFor(null)}
          onDone={() => {
            setUserActionFor(null);
            loadUsers();
          }}
        />
      )}
    </PlatformLayout>
  );
}

function UserActionModal({
  organizationId,
  user,
  onClose,
  onDone,
}: {
  organizationId: string;
  user: PlatformOrgUser;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onToggleStatus(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const nextStatus = user.status === "active" ? "deactivated" : "active";
      await setOrganizationUserStatus(organizationId, user.id, nextStatus, nextStatus === "deactivated" ? reason : undefined);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("common.errorGeneric"));
      setBusy(false);
    }
  }

  async function onRevokeSessions() {
    setBusy(true);
    setError(null);
    try {
      await revokeOrganizationUserSessions(organizationId, user.id, t("platformOrgDetailPage.revokeSessionsDefaultReason"));
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("common.errorGeneric"));
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={t("platformOrgDetailPage.users.manageTitle", { name: user.name })}>
      <form onSubmit={onToggleStatus} className="space-y-3">
        {error && <ErrorState message={error} />}
        {user.status === "active" && (
          <textarea
            placeholder={t("platformOrgDetailPage.users.deactivateReasonPlaceholder")}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
          />
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={onRevokeSessions}>
            {t("platformOrgDetailPage.users.revokeSessions")}
          </Button>
          <Button type="submit" variant={user.status === "active" ? "danger" : "primary"} size="sm" disabled={busy}>
            {user.status === "active" ? t("platformOrgDetailPage.users.deactivate") : t("platformOrgDetailPage.users.activate")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
