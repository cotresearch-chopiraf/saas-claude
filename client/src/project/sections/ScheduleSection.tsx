import { useEffect, useMemo, useState, type FormEvent } from "react";
import { PageHeader } from "../../ui/PageHeader";
import { Card } from "../../ui/Card";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { Skeleton } from "../../ui/Skeleton";
import { EmptyState } from "../../ui/EmptyState";
import { ErrorState } from "../../ui/ErrorState";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Can } from "../../auth/Can";
import { ApiError } from "../../api/client";
import {
  getProjectSchedule,
  createProjectTask,
  updateProjectTask,
  deleteProjectTask,
  createTaskDependency,
  deleteTaskDependency,
  type CreateTaskInput,
} from "../../api/projectSchedule";
import type { ProjectSchedule, ProjectTask, ProjectTaskDependency, ProjectTaskStatus, ProjectTaskType } from "../../api/types";
import { useProjectContext } from "../context";
import {
  buildScheduleRows,
  computeTimelineRange,
  computeMonthMarkers,
  dayDiff,
  todayDateOnly,
  ZOOM_PX_PER_DAY,
  type ZoomLevel,
  type ScheduleRow,
} from "./scheduleUtils";

// MIDAD Phase C1 — Gantt Scheduling Foundation. Its own project section
// ("الجدولة"), deliberately independent of "التقدم" (Measurement/IPC
// physical progress — a different concept) and "التشغيل" (the flat
// to-do-checklist Tasks/Daily Log). No financial figure appears anywhere
// on this screen — task.progressPercent is scheduling data only, never
// derived from and never feeding budget/actual-cost/IPC.

const statusLabel: Record<ProjectTaskStatus, string> = {
  not_started: "لم تبدأ",
  in_progress: "قيد التنفيذ",
  completed: "مكتملة",
  on_hold: "متوقفة",
};
const statusTone: Record<ProjectTaskStatus, "neutral" | "info" | "success" | "warning"> = {
  not_started: "neutral",
  in_progress: "info",
  completed: "success",
  on_hold: "warning",
};
const zoomLabel: Record<ZoomLevel, string> = { day: "يوم", week: "أسبوع", month: "شهر" };

export function ScheduleSection() {
  const { projectId } = useProjectContext();
  const [schedule, setSchedule] = useState<ProjectSchedule | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editingTask, setEditingTask] = useState<ProjectTask | null>(null);
  const [pendingDeleteTask, setPendingDeleteTask] = useState<ProjectTask | null>(null);
  const [pendingDeleteDependency, setPendingDeleteDependency] = useState<ProjectTaskDependency | null>(null);
  const [statusFilter, setStatusFilter] = useState<ProjectTaskStatus | "all">("all");
  const [nameFilter, setNameFilter] = useState("");
  const [zoom, setZoom] = useState<ZoomLevel>("week");

  function load() {
    setError(null);
    setSchedule(null);
    getProjectSchedule(projectId)
      .then(setSchedule)
      .catch((err) => setError(err instanceof ApiError ? err.message : "تعذّر تحميل الجدول الزمني"));
  }
  useEffect(load, [projectId]);

  const rows = useMemo(() => (schedule ? buildScheduleRows(schedule.tasks) : []), [schedule]);
  const filteredRows = useMemo(
    () =>
      rows.filter((row) => {
        if (statusFilter !== "all" && row.task.status !== statusFilter) return false;
        if (nameFilter.trim() && !row.task.name.includes(nameFilter.trim())) return false;
        return true;
      }),
    [rows, statusFilter, nameFilter],
  );

  async function confirmDeleteTask() {
    if (!pendingDeleteTask) return;
    await deleteProjectTask(projectId, pendingDeleteTask.id);
    setPendingDeleteTask(null);
    load();
  }
  async function confirmDeleteDependency() {
    if (!pendingDeleteDependency) return;
    await deleteTaskDependency(projectId, pendingDeleteDependency.id);
    setPendingDeleteDependency(null);
    load();
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="الجدول الزمني" />
        <ErrorState message={error} onRetry={load} />
      </div>
    );
  }
  if (schedule === null) {
    return (
      <div className="space-y-6">
        <PageHeader title="الجدول الزمني" />
        <Skeleton rows={5} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="الجدول الزمني"
        actions={
          <Button
            size="sm"
            onClick={() => {
              setEditingTask(null);
              setShowCreate((v) => !v);
            }}
          >
            {showCreate ? "إلغاء" : "+ مهمة جديدة"}
          </Button>
        }
      />

      {(showCreate || editingTask) && (
        <TaskForm
          projectId={projectId}
          tasks={schedule.tasks}
          editingTask={editingTask}
          onSaved={() => {
            setShowCreate(false);
            setEditingTask(null);
            load();
          }}
          onCancel={() => {
            setShowCreate(false);
            setEditingTask(null);
          }}
        />
      )}

      {schedule.tasks.length === 0 ? (
        <EmptyState message="لا توجد مهام أو معالم في الجدول الزمني بعد" />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <input
              placeholder="بحث بالاسم"
              value={nameFilter}
              onChange={(e) => setNameFilter(e.target.value)}
              className="rounded-md border border-stone-300 px-3 py-1.5 text-sm"
            />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as ProjectTaskStatus | "all")}
              className="rounded-md border border-stone-300 px-3 py-1.5 text-sm"
            >
              <option value="all">كل الحالات</option>
              {(Object.keys(statusLabel) as ProjectTaskStatus[]).map((value) => (
                <option key={value} value={value}>
                  {statusLabel[value]}
                </option>
              ))}
            </select>
            <div className="flex items-center gap-1 rounded-md border border-stone-300 p-0.5">
              {(["day", "week", "month"] as const).map((z) => (
                <button
                  key={z}
                  type="button"
                  onClick={() => setZoom(z)}
                  className={`rounded px-2 py-1 text-xs ${zoom === z ? "bg-primary text-white" : "text-stone-600 hover:bg-stone-100"}`}
                >
                  {zoomLabel[z]}
                </button>
              ))}
            </div>
          </div>

          {filteredRows.length === 0 ? (
            <EmptyState message="لا توجد مهام مطابقة لعوامل التصفية الحالية" />
          ) : (
            <Card className="overflow-hidden p-0">
              <GanttChart
                rows={filteredRows}
                zoom={zoom}
                onEdit={(task) => {
                  setShowCreate(false);
                  setEditingTask(task);
                }}
                onDelete={(task) => setPendingDeleteTask(task)}
              />
            </Card>
          )}

          <DependenciesPanel
            projectId={projectId}
            tasks={schedule.tasks}
            dependencies={schedule.dependencies}
            onChanged={load}
            onDeleteRequested={(dep) => setPendingDeleteDependency(dep)}
          />
        </>
      )}

      <ConfirmDialog
        open={pendingDeleteTask !== null}
        title="حذف المهمة"
        message={`هل تريد حذف "${pendingDeleteTask?.name ?? ""}"؟ سيتم حذف أي روابط مرتبطة بها. لا يمكن التراجع عن هذا الإجراء.`}
        destructive
        onConfirm={confirmDeleteTask}
        onCancel={() => setPendingDeleteTask(null)}
      />
      <ConfirmDialog
        open={pendingDeleteDependency !== null}
        title="حذف الربط"
        message="هل تريد حذف هذا الربط بين المهمتين؟ لن يؤثر ذلك على المهمتين أنفسهما."
        destructive
        onConfirm={confirmDeleteDependency}
        onCancel={() => setPendingDeleteDependency(null)}
      />
    </div>
  );
}

// Fixed row height shared by BOTH the task list and the timeline so the
// two stay vertically aligned — they live in the same flex row and scroll
// vertically together as one unit; only the timeline half additionally
// scrolls horizontally (mobile: task list stays put, timeline scrolls).
const ROW_HEIGHT = 56;
const HEADER_HEIGHT = 32;

function GanttChart({
  rows,
  zoom,
  onEdit,
  onDelete,
}: {
  rows: ScheduleRow[];
  zoom: ZoomLevel;
  onEdit: (task: ProjectTask) => void;
  onDelete: (task: ProjectTask) => void;
}) {
  const range = useMemo(() => computeTimelineRange(rows.map((r) => r.task)), [rows]);
  const monthMarkers = useMemo(() => computeMonthMarkers(range), [range]);
  const pxPerDay = ZOOM_PX_PER_DAY[zoom];
  const today = todayDateOnly();
  const todayOffsetDays = today >= range.start && today <= range.end ? dayDiff(range.start, today) : null;
  const timelineWidth = Math.max(range.totalDays * pxPerDay, 200);

  return (
    <div className="flex">
      {/* Task/WBS list — first in DOM so it renders on the visual right
          under this app's RTL direction, same convention
          ProjectSidebar.tsx's own comment documents. */}
      <div className="w-64 shrink-0 border-e border-stone-200">
        <div className="flex items-center border-b border-stone-200 bg-stone-50 px-3 text-xs font-semibold text-stone-500" style={{ height: HEADER_HEIGHT }}>
          المهمة
        </div>
        {rows.map((row) => (
          <div
            key={row.task.id}
            className="flex items-center justify-between gap-2 border-b border-stone-100 px-3"
            style={{ height: ROW_HEIGHT, paddingInlineStart: `${12 + row.depth * 16}px` }}
          >
            <div className="min-w-0">
              <p className="truncate text-sm text-stone-800" title={row.task.name}>
                <span className="me-1 text-stone-400">{row.wbsNumber}</span>
                {row.task.taskType === "milestone" && <span className="me-1 text-amber-500">◆</span>}
                {row.task.name}
              </p>
              <Badge tone={statusTone[row.task.status]}>{statusLabel[row.task.status]}</Badge>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button type="button" onClick={() => onEdit(row.task)} className="text-xs text-primary hover:underline">
                تعديل
              </button>
              <Can permission="projectTask.delete">
                <button type="button" onClick={() => onDelete(row.task)} className="text-stone-300 hover:text-danger-600" aria-label="حذف">
                  ✕
                </button>
              </Can>
            </div>
          </div>
        ))}
      </div>

      {/* Timeline — a date axis reads chronologically left-to-right even in
          an RTL app (the same convention MS Project's own Arabic edition
          uses for its Gantt view), so this region is deliberately LTR while
          everything else in the section stays RTL. Horizontally scrollable
          on its own — the task list never scrolls sideways, which is what
          keeps this usable on a phone (see this phase's own mobile
          guidance: task list + horizontal timeline scroll). */}
      <div className="flex-1 overflow-x-auto" dir="ltr">
        <div style={{ width: timelineWidth, position: "relative" }}>
          <div className="relative border-b border-stone-200 bg-stone-50" style={{ height: HEADER_HEIGHT }}>
            {monthMarkers.map((m) => (
              <div
                key={`${m.label}-${m.offsetDays}`}
                className="absolute top-0 border-s border-stone-200 px-1.5 text-xs text-stone-500"
                style={{ left: m.offsetDays * pxPerDay, lineHeight: `${HEADER_HEIGHT}px` }}
              >
                {m.label}
              </div>
            ))}
          </div>

          <div className="relative">
            {todayOffsetDays !== null && (
              <div
                className="pointer-events-none absolute top-0 z-10 w-px bg-danger-500"
                style={{ left: todayOffsetDays * pxPerDay, height: rows.length * ROW_HEIGHT }}
                title="اليوم"
              />
            )}
            {rows.map((row) => {
              const leftPx = dayDiff(range.start, row.task.startDate) * pxPerDay;
              if (row.task.taskType === "milestone") {
                return (
                  <div key={row.task.id} className="relative border-b border-stone-100" style={{ height: ROW_HEIGHT }}>
                    <div
                      className="absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rotate-45 bg-amber-500"
                      style={{ left: leftPx - 7 }}
                      title={row.task.name}
                    />
                  </div>
                );
              }
              const widthPx = Math.max(pxPerDay, (dayDiff(row.task.startDate, row.task.endDate) + 1) * pxPerDay);
              return (
                <div key={row.task.id} className="relative border-b border-stone-100" style={{ height: ROW_HEIGHT }}>
                  <div
                    className="absolute top-1/2 -translate-y-1/2 rounded bg-primary/20"
                    style={{ left: leftPx, width: widthPx, height: 16 }}
                    title={`${row.task.name} (${row.task.progressPercent}%)`}
                  >
                    <div className="h-full rounded bg-primary" style={{ width: `${row.task.progressPercent}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// Shared by both create and edit — the only difference is whether
// editingTask is supplied, matching ContractSection.tsx's ContractForm
// convention.
function TaskForm({
  projectId,
  tasks,
  editingTask,
  onSaved,
  onCancel,
}: {
  projectId: string;
  tasks: ProjectTask[];
  editingTask: ProjectTask | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(editingTask?.name ?? "");
  const [taskType, setTaskType] = useState<ProjectTaskType>(editingTask?.taskType ?? "task");
  const [parentTaskId, setParentTaskId] = useState<string>(editingTask?.parentTaskId ?? "");
  const [startDate, setStartDate] = useState(editingTask?.startDate ?? "");
  const [endDate, setEndDate] = useState(editingTask?.endDate ?? "");
  const [progressPercent, setProgressPercent] = useState(String(editingTask?.progressPercent ?? 0));
  const [status, setStatus] = useState<ProjectTaskStatus>(editingTask?.status ?? "not_started");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // A milestone's end date always mirrors its start date — the server
  // enforces this too, but the form should not even offer a contradicting
  // combination.
  function onTaskTypeChange(next: ProjectTaskType) {
    setTaskType(next);
    if (next === "milestone" && startDate) setEndDate(startDate);
  }
  function onStartDateChange(next: string) {
    setStartDate(next);
    if (taskType === "milestone") setEndDate(next);
  }

  const parentOptions = tasks.filter((t) => t.id !== editingTask?.id);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const input: CreateTaskInput = {
        name,
        taskType,
        status,
        startDate,
        endDate: taskType === "milestone" ? startDate : endDate,
        progressPercent: Number(progressPercent),
        parentTaskId: parentTaskId || null,
      };
      if (editingTask) {
        await updateProjectTask(projectId, editingTask.id, input);
      } else {
        await createProjectTask(projectId, input);
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر حفظ المهمة");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="p-5">
      <form onSubmit={onSubmit} className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {error && (
          <div className="sm:col-span-3">
            <ErrorState message={error} />
          </div>
        )}
        <input
          required
          placeholder="اسم المهمة"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm sm:col-span-2"
        />
        <select
          value={taskType}
          onChange={(e) => onTaskTypeChange(e.target.value as ProjectTaskType)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        >
          <option value="task">مهمة</option>
          <option value="milestone">معلم</option>
        </select>

        <select
          value={parentTaskId}
          onChange={(e) => setParentTaskId(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm sm:col-span-3"
        >
          <option value="">بدون مهمة أب</option>
          {parentOptions.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>

        <label className="text-xs text-stone-500 sm:col-span-3 sm:-mb-2">تاريخ البداية</label>
        <input
          required
          type="date"
          value={startDate}
          onChange={(e) => onStartDateChange(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        {taskType === "task" && (
          <>
            <label className="text-xs text-stone-500 sm:col-span-3 sm:-mb-2">تاريخ النهاية</label>
            <input
              required
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="rounded-md border border-stone-300 px-3 py-2 text-sm"
            />
          </>
        )}

        <input
          type="number"
          min="0"
          max="100"
          placeholder="نسبة الإنجاز %"
          value={progressPercent}
          onChange={(e) => setProgressPercent(e.target.value)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as ProjectTaskStatus)}
          className="rounded-md border border-stone-300 px-3 py-2 text-sm"
        >
          {(Object.keys(statusLabel) as ProjectTaskStatus[]).map((value) => (
            <option key={value} value={value}>
              {statusLabel[value]}
            </option>
          ))}
        </select>

        <div className="flex items-center gap-2 sm:col-span-3">
          <Button type="submit" size="sm" disabled={submitting}>
            {submitting ? "جارٍ الحفظ..." : editingTask ? "حفظ التعديلات" : "حفظ المهمة"}
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={onCancel}>
            إلغاء
          </Button>
        </div>
      </form>
    </Card>
  );
}

function DependenciesPanel({
  projectId,
  tasks,
  dependencies,
  onChanged,
  onDeleteRequested,
}: {
  projectId: string;
  tasks: ProjectTask[];
  dependencies: ProjectTaskDependency[];
  onChanged: () => void;
  onDeleteRequested: (dependency: ProjectTaskDependency) => void;
}) {
  const [predecessorTaskId, setPredecessorTaskId] = useState("");
  const [successorTaskId, setSuccessorTaskId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const nameById = useMemo(() => new Map(tasks.map((t) => [t.id, t.name])), [tasks]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!predecessorTaskId || !successorTaskId) return;
    setError(null);
    setSubmitting(true);
    try {
      await createTaskDependency(projectId, predecessorTaskId, successorTaskId);
      setPredecessorTaskId("");
      setSuccessorTaskId("");
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "تعذّر إنشاء الربط");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="p-5">
      <h2 className="mb-1 font-semibold text-stone-800">الروابط بين المهام</h2>
      <p className="mb-3 text-xs text-stone-500">المهمة التالية تبدأ بعد انتهاء المهمة السابقة.</p>

      {error && (
        <div className="mb-3">
          <ErrorState message={error} />
        </div>
      )}

      {dependencies.length === 0 ? (
        <EmptyState message="لا توجد روابط بين المهام بعد" />
      ) : (
        <ul className="mb-4 space-y-1">
          {dependencies.map((dep) => (
            <li key={dep.id} className="flex items-center justify-between rounded-md border border-stone-100 px-3 py-2 text-sm">
              <span>
                {nameById.get(dep.predecessorTaskId) ?? "—"} ← {nameById.get(dep.successorTaskId) ?? "—"}
              </span>
              <Can permission="projectTask.delete">
                <button type="button" onClick={() => onDeleteRequested(dep)} className="text-stone-300 hover:text-danger-600" aria-label="حذف الربط">
                  ✕
                </button>
              </Can>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={onSubmit} className="flex flex-wrap items-center gap-2">
        <select value={predecessorTaskId} onChange={(e) => setPredecessorTaskId(e.target.value)} className="rounded-md border border-stone-300 px-3 py-2 text-sm">
          <option value="">المهمة السابقة</option>
          {tasks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <span className="text-stone-400">←</span>
        <select value={successorTaskId} onChange={(e) => setSuccessorTaskId(e.target.value)} className="rounded-md border border-stone-300 px-3 py-2 text-sm">
          <option value="">المهمة التالية</option>
          {tasks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <Button type="submit" size="sm" disabled={submitting || !predecessorTaskId || !successorTaskId}>
          + ربط
        </Button>
      </form>
    </Card>
  );
}
