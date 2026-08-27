import { FormEvent, useEffect, useState } from "react";
import { apiFetch } from "../api/client";
import type { DailyLog } from "../api/types";

const todayIso = () => new Date().toISOString().slice(0, 10);

export function DailyLogsPanel({ projectId }: { projectId: string }) {
  const [logs, setLogs] = useState<DailyLog[]>([]);
  const [note, setNote] = useState("");
  const [logDate, setLogDate] = useState(todayIso());

  function load() {
    apiFetch<DailyLog[]>(`/projects/${projectId}/daily-logs`).then(setLogs);
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

  async function removeLog(log: DailyLog) {
    await apiFetch(`/projects/${projectId}/daily-logs/${log.id}`, { method: "DELETE" });
    load();
  }

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
          placeholder="ماذا حدث في الموقع اليوم؟"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="flex-1 rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <button className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white">تسجيل</button>
      </form>

      <ul className="space-y-2">
        {logs.map((log) => (
          <li key={log.id} className="flex items-start justify-between gap-3 rounded-lg border border-stone-200 bg-white p-3">
            <div>
              <p className="text-xs font-medium text-stone-400">{log.logDate}</p>
              <p className="text-stone-700">{log.note}</p>
            </div>
            <button onClick={() => removeLog(log)} className="text-stone-300 hover:text-red-500" aria-label="حذف السجل">
              ✕
            </button>
          </li>
        ))}
        {logs.length === 0 && (
          <li className="rounded-lg border border-dashed border-stone-300 p-4 text-center text-stone-400">
            لا توجد سجلات يومية بعد
          </li>
        )}
      </ul>
    </div>
  );
}
