import { FormEvent, useEffect, useState } from "react";
import { apiFetch, ApiError } from "../api/client";
import type { Task, TaskStatus } from "../api/types";
import { Skeleton } from "../ui/Skeleton";
import { ErrorState } from "../ui/ErrorState";
import { EmptyState } from "../ui/EmptyState";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { Can } from "../auth/Can";
import { useTranslation } from "../i18n/I18nProvider";

// Same neutral-for-not-active-work convention this app already uses for
// project status (Dashboard's statusTone maps "completed" to "neutral", not
// "success") — only in_progress is visually distinct here.
const statusTone: Record<TaskStatus, "neutral" | "warning"> = {
  todo: "neutral",
  in_progress: "warning",
  done: "neutral",
};

const nextStatus: Record<TaskStatus, TaskStatus> = {
  todo: "in_progress",
  in_progress: "done",
  done: "todo",
};

export function TaskPanel({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  // Slice AA — null means "not loaded yet" (distinct from an empty list),
  // matching the loading/error/empty-state pattern the rest of the
  // product already uses (FinancialTable.tsx).
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [assigneeName, setAssigneeName] = useState("");
  const [pendingDelete, setPendingDelete] = useState<Task | null>(null);

  function load() {
    setError(null);
    apiFetch<Task[]>(`/projects/${projectId}/tasks`)
      .then(setTasks)
      .catch((err) => setError(err instanceof ApiError ? err.message : t("operations.taskPanel.loadError")));
  }

  useEffect(load, [projectId]);

  async function addTask(e: FormEvent) {
    e.preventDefault();
    await apiFetch(`/projects/${projectId}/tasks`, {
      method: "POST",
      body: JSON.stringify({ title, assigneeName: assigneeName || undefined }),
    });
    setTitle("");
    setAssigneeName("");
    load();
  }

  async function cycleStatus(task: Task) {
    await apiFetch(`/projects/${projectId}/tasks/${task.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: nextStatus[task.status] }),
    });
    load();
  }

  async function confirmRemove() {
    if (!pendingDelete) return;
    await apiFetch(`/projects/${projectId}/tasks/${pendingDelete.id}`, { method: "DELETE" });
    setPendingDelete(null);
    load();
  }

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (tasks === null) return <Skeleton rows={3} />;

  return (
    <div>
      {tasks.length === 0 ? (
        <EmptyState message={t("operations.taskPanel.emptyMessage")} />
      ) : (
        <ul className="divide-y divide-stone-100 rounded-lg border border-stone-200 bg-white">
          {tasks.map((task) => (
            <li key={task.id} className="flex items-center justify-between gap-3 p-3">
              <div>
                <p className={task.status === "done" ? "text-stone-400 line-through" : "text-stone-800"}>
                  {task.title}
                </p>
                {task.assigneeName && <p className="text-xs text-stone-500">{task.assigneeName}</p>}
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => cycleStatus(task)} aria-label={t("operations.taskPanel.toggleStatusAriaLabel", { status: t(`operations.taskPanel.status.${task.status}`) })}>
                  <Badge tone={statusTone[task.status]}>{t(`operations.taskPanel.status.${task.status}`)}</Badge>
                </button>
                <Can permission="task.delete">
                  <button
                    onClick={() => setPendingDelete(task)}
                    className="text-stone-300 hover:text-red-500"
                    aria-label={t("operations.taskPanel.deleteAriaLabel")}
                  >
                    ✕
                  </button>
                </Can>
              </div>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={addTask} className="mt-3 flex gap-2">
        <input
          required
          placeholder={t("operations.taskPanel.newTaskPlaceholder")}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="flex-1 rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <input
          placeholder={t("operations.taskPanel.assigneePlaceholder")}
          value={assigneeName}
          onChange={(e) => setAssigneeName(e.target.value)}
          className="w-40 rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <Button type="submit">{t("operations.taskPanel.add")}</Button>
      </form>

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t("operations.taskPanel.deleteConfirm.title")}
        message={t("operations.taskPanel.deleteConfirm.message", { title: pendingDelete?.title ?? "" })}
        destructive
        onConfirm={confirmRemove}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
