import type { ProjectTask } from "../../api/types";

// MIDAD Phase C1 — pure display/layout helpers for the Gantt view. None of
// these compute a financial value or an authoritative progress figure —
// they only derive hierarchy ORDER and pixel geometry from data the backend
// already returned and validated. WBS numbering ("1.2.3") is display-only,
// recomputed on every render from parentTaskId + sortOrder/createdAt — the
// database id stays the sole authoritative identity, per this phase's own
// explicit instruction never to store an editable WBS number.

export interface ScheduleRow {
  task: ProjectTask;
  depth: number;
  wbsNumber: string;
}

// Depth-first, sortOrder-then-createdAt within each sibling group — a
// deterministic order given the same input every time, with no separate
// "reorder" endpoint needed: PATCHing a task's own sortOrder is enough.
export function buildScheduleRows(tasks: ProjectTask[]): ScheduleRow[] {
  const childrenOf = new Map<string | null, ProjectTask[]>();
  for (const task of tasks) {
    const key = task.parentTaskId;
    const list = childrenOf.get(key) ?? [];
    list.push(task);
    childrenOf.set(key, list);
  }
  for (const list of childrenOf.values()) {
    list.sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt));
  }

  const rows: ScheduleRow[] = [];
  function visit(parentId: string | null, depth: number, prefix: string) {
    const children = childrenOf.get(parentId) ?? [];
    children.forEach((task, index) => {
      const wbsNumber = prefix ? `${prefix}.${index + 1}` : `${index + 1}`;
      rows.push({ task, depth, wbsNumber });
      visit(task.id, depth + 1, wbsNumber);
    });
  }
  visit(null, 0, "");
  return rows;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function parseDateOnly(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function dayDiff(from: string, to: string): number {
  return Math.round((parseDateOnly(to).getTime() - parseDateOnly(from).getTime()) / MS_PER_DAY);
}

export function addDays(date: string, days: number): string {
  const d = parseDateOnly(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function todayDateOnly(): string {
  return new Date().toISOString().slice(0, 10);
}

export type ZoomLevel = "day" | "week" | "month";

// Pixels per day at each zoom level — a simple, understandable scale
// factor, not a full calendar-aware layout engine (per this phase's own
// "keep it simple" boundary).
export const ZOOM_PX_PER_DAY: Record<ZoomLevel, number> = { day: 32, week: 12, month: 4 };

export interface TimelineRange {
  start: string;
  end: string;
  totalDays: number;
}

// A little padding on both sides so the first/last bar isn't flush against
// the timeline edge, and a sane fallback range when there are no tasks yet.
export function computeTimelineRange(tasks: ProjectTask[]): TimelineRange {
  if (tasks.length === 0) {
    const start = todayDateOnly();
    return { start, end: addDays(start, 30), totalDays: 30 };
  }
  let minStart = tasks[0].startDate;
  let maxEnd = tasks[0].endDate;
  for (const t of tasks) {
    if (t.startDate < minStart) minStart = t.startDate;
    if (t.endDate > maxEnd) maxEnd = t.endDate;
  }
  const start = addDays(minStart, -3);
  const end = addDays(maxEnd, 3);
  return { start, end, totalDays: Math.max(1, dayDiff(start, end)) };
}

export interface MonthMarker {
  label: string;
  offsetDays: number;
}

// One marker per calendar month boundary inside the range, for the
// timeline's header row. Month names come from Intl.DateTimeFormat for
// the active locale — the same approach formatDate/formatMoney already
// use — rather than a hardcoded Arabic-only name list.
export function computeMonthMarkers(range: TimelineRange, locale: string = "ar"): MonthMarker[] {
  const monthFormatter = new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" });
  const markers: MonthMarker[] = [];
  const startDate = parseDateOnly(range.start);
  let cursor = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1));
  if (cursor < startDate) cursor = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth() + 1, 1));
  const endDate = parseDateOnly(range.end);
  while (cursor <= endDate) {
    const cursorStr = cursor.toISOString().slice(0, 10);
    markers.push({ label: monthFormatter.format(cursor), offsetDays: dayDiff(range.start, cursorStr) });
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }
  return markers;
}
