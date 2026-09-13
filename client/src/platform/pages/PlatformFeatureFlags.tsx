import { useEffect, useState, type FormEvent } from "react";
import { PlatformLayout } from "../components/PlatformLayout";
import { PageHeader, Card, Badge, Button, ErrorState, Skeleton, EmptyState, Modal } from "../../ui";
import { ApiError } from "../../api/client";
import { listFeatureFlags, createFeatureFlag, updateFeatureFlag, listFeatureFlagOverrides, setFeatureFlagOverride, clearFeatureFlagOverride } from "../api/featureFlags";
import type { FeatureFlag, FeatureFlagOverride } from "../api/types";
import { useTranslation } from "../../i18n/I18nProvider";

// MIDAD Final Pre-Launch audit, Phase 22 (UX) — Phase 2/15's feature-flag
// registry + per-company override CRUD (server/src/routes/
// platformFeatureFlags.ts) — the "Future Feature Delivery System" itself
// is the backend; this is its first real operator-facing UI.
export function PlatformFeatureFlags() {
  const { t } = useTranslation();
  const [flags, setFlags] = useState<FeatureFlag[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<FeatureFlag | null>(null);
  const [overridesFor, setOverridesFor] = useState<FeatureFlag | null>(null);

  function load() {
    setFlags(null);
    setError(null);
    listFeatureFlags()
      .then((page) => setFlags(page.flags))
      .catch((err) => setError(err instanceof ApiError ? err.message : t("platformFeatureFlagsPage.loadError")));
  }

  useEffect(load, []);

  return (
    <PlatformLayout>
      <PageHeader
        title={t("platformFeatureFlagsPage.title")}
        subtitle={t("platformFeatureFlagsPage.subtitle")}
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            {t("platformFeatureFlagsPage.createFlag")}
          </Button>
        }
      />

      {error ? (
        <ErrorState message={error} onRetry={load} />
      ) : !flags ? (
        <Skeleton rows={4} />
      ) : flags.length === 0 ? (
        <EmptyState message={t("platformFeatureFlagsPage.emptyMessage")} />
      ) : (
        <Card className="divide-y divide-stone-100">
          {flags.map((flag) => (
            <div key={flag.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
              <div className="min-w-0">
                <p className="font-medium text-stone-800">{flag.key}</p>
                <p className="text-xs text-stone-500">{flag.description}</p>
                {flag.enabledEnvironments && flag.enabledEnvironments.length > 0 && (
                  <p className="mt-0.5 text-xs text-stone-400">{t("platformFeatureFlagsPage.environments")}: {flag.enabledEnvironments.join(", ")}</p>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={flag.globalEnabled ? "success" : "neutral"}>
                  {flag.globalEnabled ? t("platformFeatureFlagsPage.globallyOn") : t("platformFeatureFlagsPage.globallyOff")}
                </Badge>
                <Badge tone={flag.defaultEnabledForOrgs ? "info" : "neutral"}>
                  {flag.defaultEnabledForOrgs ? t("platformFeatureFlagsPage.defaultOn") : t("platformFeatureFlagsPage.defaultOff")}
                </Badge>
                <Button size="sm" variant="secondary" onClick={() => setOverridesFor(flag)}>
                  {t("platformFeatureFlagsPage.overrides")}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setEditing(flag)}>
                  {t("common.edit")}
                </Button>
              </div>
            </div>
          ))}
        </Card>
      )}

      {creating && <FlagFormModal onClose={() => setCreating(false)} onSaved={() => { setCreating(false); load(); }} />}
      {editing && <FlagFormModal flag={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      {overridesFor && <OverridesModal flag={overridesFor} onClose={() => setOverridesFor(null)} />}
    </PlatformLayout>
  );
}

function FlagFormModal({ flag, onClose, onSaved }: { flag?: FeatureFlag; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const isEdit = Boolean(flag);
  const [key, setKey] = useState(flag?.key ?? "");
  const [description, setDescription] = useState(flag?.description ?? "");
  const [globalEnabled, setGlobalEnabled] = useState(flag?.globalEnabled ?? false);
  const [defaultEnabledForOrgs, setDefaultEnabledForOrgs] = useState(flag?.defaultEnabledForOrgs ?? false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (isEdit && flag) {
        await updateFeatureFlag(flag.key, { description, globalEnabled, defaultEnabledForOrgs });
      } else {
        await createFeatureFlag({ key, description, globalEnabled, defaultEnabledForOrgs });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("common.errorGeneric"));
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={isEdit ? t("platformFeatureFlagsPage.editFlag") : t("platformFeatureFlagsPage.createFlag")}>
      <form onSubmit={onSubmit} className="space-y-3">
        {error && <ErrorState message={error} />}
        {!isEdit && (
          <input
            required
            placeholder={t("platformFeatureFlagsPage.form.key")}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
          />
        )}
        <textarea
          required
          minLength={3}
          placeholder={t("platformFeatureFlagsPage.form.description")}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={2}
          className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <label className="flex items-center gap-2 text-sm text-stone-600">
          <input type="checkbox" checked={globalEnabled} onChange={(e) => setGlobalEnabled(e.target.checked)} />
          {t("platformFeatureFlagsPage.form.globalEnabled")}
        </label>
        <label className="flex items-center gap-2 text-sm text-stone-600">
          <input type="checkbox" checked={defaultEnabledForOrgs} onChange={(e) => setDefaultEnabledForOrgs(e.target.checked)} />
          {t("platformFeatureFlagsPage.form.defaultEnabledForOrgs")}
        </label>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" size="sm" disabled={busy}>
            {busy ? t("common.saving") : t("common.save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function OverridesModal({ flag, onClose }: { flag: FeatureFlag; onClose: () => void }) {
  const { t } = useTranslation();
  const [overrides, setOverrides] = useState<FeatureFlagOverride[] | null>(null);
  const [companyId, setCompanyId] = useState("");
  const [error, setError] = useState<string | null>(null);

  function load() {
    listFeatureFlagOverrides(flag.key)
      .then((page) => setOverrides(page.overrides))
      .catch((err) => setError(err instanceof ApiError ? err.message : t("common.errorGeneric")));
  }

  useEffect(load, [flag.key]);

  async function onAdd(enabled: boolean) {
    if (!companyId.trim()) return;
    setError(null);
    try {
      await setFeatureFlagOverride(flag.key, companyId.trim(), enabled);
      setCompanyId("");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("common.errorGeneric"));
    }
  }

  async function onClear(id: string) {
    setError(null);
    try {
      await clearFeatureFlagOverride(flag.key, id);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("common.errorGeneric"));
    }
  }

  return (
    <Modal open onClose={onClose} title={t("platformFeatureFlagsPage.overridesModal.title", { key: flag.key })}>
      <div className="space-y-3">
        {error && <ErrorState message={error} />}
        <p className="text-xs text-stone-500">{t("platformFeatureFlagsPage.overridesModal.description")}</p>
        <div className="flex gap-2">
          <input
            placeholder={t("platformFeatureFlagsPage.overridesModal.companyIdPlaceholder")}
            value={companyId}
            onChange={(e) => setCompanyId(e.target.value)}
            className="flex-1 rounded-md border border-stone-300 px-3 py-2 text-sm"
          />
          <Button size="sm" variant="secondary" onClick={() => onAdd(true)}>
            {t("platformFeatureFlagsPage.overridesModal.forceOn")}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => onAdd(false)}>
            {t("platformFeatureFlagsPage.overridesModal.forceOff")}
          </Button>
        </div>
        {!overrides ? (
          <Skeleton rows={2} />
        ) : overrides.length === 0 ? (
          <EmptyState message={t("platformFeatureFlagsPage.overridesModal.emptyMessage")} />
        ) : (
          <ul className="divide-y divide-stone-100 rounded-md border border-stone-200">
            {overrides.map((o) => (
              <li key={o.id} className="flex items-center justify-between px-3 py-2 text-sm">
                <span className="font-mono text-xs">{o.companyId}</span>
                <div className="flex items-center gap-2">
                  <Badge tone={o.enabled ? "success" : "danger"}>
                    {o.enabled ? t("platformFeatureFlagsPage.overridesModal.forceOn") : t("platformFeatureFlagsPage.overridesModal.forceOff")}
                  </Badge>
                  <Button size="sm" variant="ghost" onClick={() => onClear(o.companyId)}>
                    {t("common.delete")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}
