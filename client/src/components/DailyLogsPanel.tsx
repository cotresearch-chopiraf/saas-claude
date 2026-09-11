import { FormEvent, useEffect, useState } from "react";
import { apiFetch, ApiError } from "../api/client";
import type { DailyLog } from "../api/types";
import { Skeleton } from "../ui/Skeleton";
import { ErrorState } from "../ui/ErrorState";
import { EmptyState } from "../ui/EmptyState";
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Can } from "../auth/Can";
import { useTranslation } from "../i18n/I18nProvider";

const todayIso = () => new Date().toISOString().slice(0, 10);

export function DailyLogsPanel({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const [logs, setLogs] = useState<DailyLog[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [logDate, setLogDate] = useState(todayIso());
  const [pendingDelete, setPendingDelete] = useState<DailyLog | null>(null);

  function load() {
    setError(null);
    apiFetch<DailyLog[]>(`/projects/${projectId}/daily-logs`)
      .then(setLogs)
      .catch((err) => setError(err instanceof ApiError ? err.message : t("operations.dailyLogsPanel.loadError")));
  }

  useEffect(load, [projectId]);

  async function addLog(e: FormEvent) {
    e.preventDefault();
    await apiFetch(`/projects/${projectId}/daily-logs`, {
      method: "POST",
      body: JSON.stringify({ note, logDate }),
    });
    setNote("");
    setLogDate(todayIso());
    load();
  }

  async function confirmRemove() {
    if (!pendingDelete) return;
    await apiFetch(`/projects/${projectId}/daily-logs/${pendingDelete.id}`, { method: "DELETE" });
    setPendingDelete(null);
    load();
  }

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (logs === null) return <Skeleton rows={3} />;

  return (
    <div>
      <form onSubmit={addLog} className="mb-4 flex flex-wrap gap-2">
        <input
          type="date"
          value={logDate}
          onChange={(e) => setLogDate(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <input
          required
          placeholder={t("operations.dailyLogsPanel.notePlaceholder")}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="flex-1 rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <Button type="submit">{t("operations.dailyLogsPanel.record")}</Button>
      </form>

      {logs.length === 0 ? (
        <EmptyState message={t("operations.dailyLogsPanel.emptyMessage")} />
      ) : (
        <ul className="space-y-2">
          {logs.map((log) => (
            <li key={log.id} className="flex items-start justify-between gap-3 rounded-lg border border-stone-200 bg-white p-3">
              <div>
                <p className="text-xs font-medium text-stone-400">{log.logDate}</p>
                <p className="text-stone-700">{log.note}</p>
              </div>
              <Can permission="dailyLog.delete">
                <button
                  onClick={() => setPendingDelete(log)}
                  className="text-stone-300 hover:text-red-500"
                  aria-label={t("operations.dailyLogsPanel.deleteAriaLabel")}
                >
                  ✕
                </button>
              </Can>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t("operations.dailyLogsPanel.deleteConfirm.title")}
        message={t("operations.dailyLogsPanel.deleteConfirm.message")}
        destructive
        onConfirm={confirmRemove}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
