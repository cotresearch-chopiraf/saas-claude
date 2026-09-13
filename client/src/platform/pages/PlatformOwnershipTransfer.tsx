import { useEffect, useState, type FormEvent } from "react";
import { PlatformLayout } from "../components/PlatformLayout";
import { PageHeader, Card, Button, ErrorState, Skeleton, EmptyState } from "../../ui";
import { ApiError } from "../../api/client";
import { usePlatformAuth } from "../auth/PlatformAuthContext";
import { listOwnershipTransferCandidates, transferOwnership } from "../api/ownershipTransfer";
import type { OwnershipTransferCandidate, OwnershipTransferResult } from "../api/types";
import { useTranslation } from "../../i18n/I18nProvider";

// MIDAD Final Pre-Launch audit, Phase 22 (UX) — Phase 9's Ownership
// Transfer (server/src/routes/platformOwnershipTransfer.ts). Only
// platform_owner holds the "ownershipTransfer.manage" capability the
// backend requires, so a non-owner reaching this page simply sees the
// backend's own 403 surface via loadError — no client-side role gate
// duplicates that enforcement.
export function PlatformOwnershipTransfer() {
  const { t } = useTranslation();
  const { operator } = usePlatformAuth();
  const [candidates, setCandidates] = useState<OwnershipTransferCandidate[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>("");
  const [confirmationEmail, setConfirmationEmail] = useState("");
  const [reason, setReason] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<OwnershipTransferResult | null>(null);

  function load() {
    setCandidates(null);
    setLoadError(null);
    listOwnershipTransferCandidates()
      .then((page) => setCandidates(page.operators.filter((o) => o.id !== operator?.id)))
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : t("platformOwnershipTransferPage.loadError")));
  }

  useEffect(load, []);

  const selectedCandidate = candidates?.find((c) => c.id === selected);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!selectedCandidate) return;
    setBusy(true);
    setSubmitError(null);
    try {
      const res = await transferOwnership({ newOwnerOperatorId: selectedCandidate.id, confirmationEmail, reason });
      setResult(res);
    } catch (err) {
      setSubmitError(err instanceof ApiError ? err.message : t("common.errorGeneric"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PlatformLayout>
      <PageHeader title={t("platformOwnershipTransferPage.title")} subtitle={t("platformOwnershipTransferPage.subtitle")} />

      {result ? (
        <Card className="p-5">
          <p className="font-semibold text-stone-800">{t("platformOwnershipTransferPage.result.title")}</p>
          <p className="mt-2 text-sm text-stone-600">
            {t("platformOwnershipTransferPage.result.summary", { previous: result.previousOwner.email, next: result.newOwner.email })}
          </p>
          <p className="mt-1 text-xs text-stone-400">
            {t("platformOwnershipTransferPage.result.revokedSessions", { count: result.revokedSessionCount })}
          </p>
        </Card>
      ) : loadError ? (
        <ErrorState message={loadError} onRetry={load} />
      ) : !candidates ? (
        <Skeleton rows={4} />
      ) : candidates.length === 0 ? (
        <EmptyState message={t("platformOwnershipTransferPage.emptyMessage")} />
      ) : (
        <Card className="max-w-lg p-5">
          <form onSubmit={onSubmit} className="space-y-3">
            {submitError && <ErrorState message={submitError} />}
            <label className="block text-sm">
              <span className="mb-1 block text-stone-600">{t("platformOwnershipTransferPage.form.newOwner")}</span>
              <select
                required
                value={selected}
                onChange={(e) => {
                  setSelected(e.target.value);
                  setConfirmationEmail("");
                }}
                className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
              >
                <option value="" disabled>
                  {t("platformOwnershipTransferPage.form.selectOperator")}
                </option>
                {candidates.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.email}) — {c.role}
                  </option>
                ))}
              </select>
            </label>
            {selectedCandidate && (
              <label className="block text-sm">
                <span className="mb-1 block text-stone-600">
                  {t("platformOwnershipTransferPage.form.confirmationEmail", { email: selectedCandidate.email })}
                </span>
                <input
                  required
                  type="email"
                  value={confirmationEmail}
                  onChange={(e) => setConfirmationEmail(e.target.value)}
                  className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
                />
              </label>
            )}
            <label className="block text-sm">
              <span className="mb-1 block text-stone-600">{t("platformOwnershipTransferPage.form.reason")}</span>
              <textarea
                required
                minLength={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={2}
                className="w-full rounded-md border border-stone-300 px-3 py-2 text-sm"
              />
            </label>
            <Button type="submit" variant="danger" disabled={busy || !selectedCandidate}>
              {busy ? t("platformOwnershipTransferPage.form.transferring") : t("platformOwnershipTransferPage.form.transfer")}
            </Button>
          </form>
        </Card>
      )}
    </PlatformLayout>
  );
}
