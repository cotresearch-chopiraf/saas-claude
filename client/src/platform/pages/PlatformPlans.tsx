import { useEffect, useState, type FormEvent } from "react";
import { PlatformLayout } from "../components/PlatformLayout";
import { PageHeader, Card, Badge, Button, ErrorState, Skeleton, EmptyState, Modal } from "../../ui";
import { ApiError } from "../../api/client";
import { listPlans, createPlan, updatePlan } from "../api/plans";
import type { Plan, PlanLimits } from "../api/types";
import { useTranslation } from "../../i18n/I18nProvider";

// MIDAD Final Pre-Launch audit, Phase 22 (UX) — Phase 3's plan registry
// CRUD (server/src/routes/platformPlans.ts). Per-organization assignment
// lives on PlatformOrganizationDetail.tsx (it needs an organization
// context this page doesn't have).
export function PlatformPlans() {
  const { t } = useTranslation();
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Plan | null>(null);

  function load() {
    setPlans(null);
    setError(null);
    listPlans()
      .then((page) => setPlans(page.plans))
      .catch((err) => setError(err instanceof ApiError ? err.message : t("platformPlansPage.loadError")));
  }

  useEffect(load, []);

  return (
    <PlatformLayout>
      <PageHeader
        title={t("platformPlansPage.title")}
        subtitle={t("platformPlansPage.subtitle")}
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            {t("platformPlansPage.createPlan")}
          </Button>
        }
      />

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : !plans ? (
        <Skeleton rows={4} />
      ) : plans.length === 0 ? (
        <EmptyState message={t("platformPlansPage.emptyMessage")} />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {plans.map((plan) => (
            <Card key={plan.id} className="p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-semibold text-stone-800">{plan.name}</p>
                  <p className="text-xs text-stone-400">{plan.key}</p>
                </div>
                <Badge tone={plan.isActive ? "success" : "neutral"}>
                  {plan.isActive ? t("platformPlansPage.active") : t("platformPlansPage.inactive")}
                </Badge>
              </div>
              {plan.description && <p className="mt-2 text-sm text-stone-500">{plan.description}</p>}
              <dl className="mt-3 grid grid-cols-2 gap-1 text-xs text-stone-600">
                <div>{t("platformPlansPage.limits.maxUsers")}: {plan.limits.maxUsers ?? t("platformPlansPage.unlimited")}</div>
                <div>{t("platformPlansPage.limits.maxProjects")}: {plan.limits.maxProjects ?? t("platformPlansPage.unlimited")}</div>
                <div>{t("platformPlansPage.limits.maxStorageMb")}: {plan.limits.maxStorageMb ?? t("platformPlansPage.unlimited")}</div>
                <div>{t("platformPlansPage.limits.maxInvoicesPerMonth")}: {plan.limits.maxInvoicesPerMonth ?? t("platformPlansPage.unlimited")}</div>
              </dl>
              <div className="mt-3 text-end">
                <Button size="sm" variant="secondary" onClick={() => setEditing(plan)}>
                  {t("platformPlansPage.edit")}
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {creating && <PlanFormModal onClose={() => setCreating(false)} onSaved={() => { setCreating(false); load(); }} />}
      {editing && (
        <PlanFormModal plan={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
      )}
    </PlatformLayout>
  );
}

function PlanFormModal({ plan, onClose, onSaved }: { plan?: Plan; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const isEdit = Boolean(plan);
  const [key, setKey] = useState(plan?.key ?? "");
  const [name, setName] = useState(plan?.name ?? "");
  const [description, setDescription] = useState(plan?.description ?? "");
  const [isActive, setIsActive] = useState(plan?.isActive ?? true);
  const [limits, setLimits] = useState<PlanLimits>(plan?.limits ?? {});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function limitField(field: keyof PlanLimits, value: string) {
    setLimits((prev) => ({ ...prev, [field]: value.trim() === "" ? null : Number(value) }));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (isEdit && plan) {
        await updatePlan(plan.key, { name, description, isActive, limits });
      } else {
        await createPlan({ key, name, description, isActive, limits });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("common.errorGeneric"));
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={isEdit ? t("platformPlansPage.editPlan") : t("platformPlansPage.createPlan")}>
      <form onSubmit={onSubmit} className="space-y-3">
        {error && <ErrorState message={error} />}
        {!isEdit && (
          <input
            required
            placeholder={t("platformPlansPage.form.key")}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
          />
        )}
        <input
          required
          placeholder={t("platformPlansPage.form.name")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <textarea
          placeholder={t("platformPlansPage.form.description")}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <label className="flex items-center gap-2 text-sm text-stone-600">
          <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
          {t("platformPlansPage.form.isActive")}
        </label>
        <div className="grid grid-cols-2 gap-2">
          <input
            type="number"
            placeholder={t("platformPlansPage.limits.maxUsers")}
            value={limits.maxUsers ?? ""}
            onChange={(e) => limitField("maxUsers", e.target.value)}
            className="rounded-md border border-stone-300 px-3 py-2 text-sm"
          />
          <input
            type="number"
            placeholder={t("platformPlansPage.limits.maxProjects")}
            value={limits.maxProjects ?? ""}
            onChange={(e) => limitField("maxProjects", e.target.value)}
            className="rounded-md border border-stone-300 px-3 py-2 text-sm"
          />
          <input
            type="number"
            placeholder={t("platformPlansPage.limits.maxStorageMb")}
            value={limits.maxStorageMb ?? ""}
            onChange={(e) => limitField("maxStorageMb", e.target.value)}
            className="rounded-md border border-stone-300 px-3 py-2 text-sm"
          />
          <input
            type="number"
            placeholder={t("platformPlansPage.limits.maxInvoicesPerMonth")}
            value={limits.maxInvoicesPerMonth ?? ""}
            onChange={(e) => limitField("maxInvoicesPerMonth", e.target.value)}
            className="rounded-md border border-stone-300 px-3 py-2 text-sm"
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" size="sm" disabled={busy}>
            {busy ? t("platformPlansPage.saving") : t("common.save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
