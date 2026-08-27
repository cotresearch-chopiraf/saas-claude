import { FormEvent, useEffect, useState } from "react";
import { apiFetch } from "../api/client";
import type { Task, TaskStatus } from "../api/types";

const statusLabel: Record<TaskStatus, string> = {
  todo: "لم تبدأ",
  in_progress: "جارية",
  done: "منتهية",
};

const nextStatus: Record<TaskStatus, TaskStatus> = {
  todo: "in_progress",
  in_progress: "done",
  done: "todo",
};

export function TaskPanel({ projectId }: { projectId: string }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [title, setTitle] = useState("");
  const [assigneeName, setAssigneeName] = useState("");

  function load() {
    apiFetch<Task[]>(`/projects/${projectId}/tasks`).then(setTasks);
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

  async function removeTask(task: Task) {
    await apiFetch(`/projects/${projectId}/tasks/${task.id}`, { method: "DELETE" });
    load();
  }

  return (
    <div>
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
              <button
                onClick={() => cycleStatus(task)}
                className={`rounded-full px-2 py-0.5 text-xs ${
                  task.status === "done"
                    ? "bg-stone-200 text-stone-600"
                    : task.status === "in_progress"
                      ? "bg-amber-100 text-amber-700"
                      : "bg-stone-100 text-stone-600"
                }`}
              >
                {statusLabel[task.status]}
              </button>
              <button onClick={() => removeTask(task)} className="text-stone-300 hover:text-red-500" aria-label="حذف المهمة">
                ✕
              </button>
            </div>
          </li>
        ))}
        {tasks.length === 0 && <li className="p-4 text-center text-stone-400">لا توجد مهام بعد</li>}
      </ul>

      <form onSubmit={addTask} className="mt-3 flex gap-2">
        <input
          required
          placeholder="مهمة جديدة"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="flex-1 rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <input
          placeholder="المسؤول"
          value={assigneeName}
          onChange={(e) => setAssigneeName(e.target.value)}
          className="w-40 rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <button className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white">إضافة</button>
      </form>
    </div>
  );
}
