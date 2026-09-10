import { describe, it, expect } from "vitest";
import { buildScheduleRows, dayDiff, addDays, computeTimelineRange, computeMonthMarkers } from "./scheduleUtils";
import type { ProjectTask } from "../../api/types";

function task(overrides: Partial<ProjectTask> & Pick<ProjectTask, "id" | "name">): ProjectTask {
  return {
    projectId: "p1",
    parentTaskId: null,
    description: null,
    taskType: "task",
    status: "not_started",
    startDate: "2026-01-01",
    endDate: "2026-01-05",
    progressPercent: 0,
    sortOrder: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildScheduleRows", () => {
  it("computes deterministic WBS numbering from hierarchy + sortOrder", () => {
    const earthworks = task({ id: "t1", name: "الأعمال الترابية", sortOrder: 0 });
    const structure = task({ id: "t2", name: "الهيكل", sortOrder: 1 });
    const excavation = task({ id: "t3", name: "الحفر", parentTaskId: "t1", sortOrder: 0 });
    const backfilling = task({ id: "t4", name: "الردم", parentTaskId: "t1", sortOrder: 1 });
    const foundations = task({ id: "t5", name: "الأساسات", parentTaskId: "t2", sortOrder: 0 });

    const rows = buildScheduleRows([structure, foundations, backfilling, earthworks, excavation]);

    expect(rows.map((r) => [r.wbsNumber, r.task.name, r.depth])).toEqual([
      ["1", "الأعمال الترابية", 0],
      ["1.1", "الحفر", 1],
      ["1.2", "الردم", 1],
      ["2", "الهيكل", 0],
      ["2.1", "الأساسات", 1],
    ]);
  });

  it("orders siblings by sortOrder, falling back to createdAt for ties", () => {
    const a = task({ id: "a", name: "ب أولاً بالترتيب", sortOrder: 1, createdAt: "2026-01-01T00:00:00.000Z" });
    const b = task({ id: "b", name: "أ حسب وقت الإنشاء", sortOrder: 1, createdAt: "2026-01-02T00:00:00.000Z" });
    const c = task({ id: "c", name: "يأتي أولاً", sortOrder: 0, createdAt: "2026-01-03T00:00:00.000Z" });

    const rows = buildScheduleRows([a, b, c]);
    expect(rows.map((r) => r.task.id)).toEqual(["c", "a", "b"]);
  });

  it("an empty task list produces an empty row list", () => {
    expect(buildScheduleRows([])).toEqual([]);
  });
});

describe("date helpers", () => {
  it("dayDiff computes whole-day differences without timezone drift", () => {
    expect(dayDiff("2026-01-01", "2026-01-10")).toBe(9);
    expect(dayDiff("2026-01-10", "2026-01-01")).toBe(-9);
    expect(dayDiff("2026-01-01", "2026-01-01")).toBe(0);
  });

  it("addDays round-trips with dayDiff", () => {
    expect(addDays("2026-01-01", 9)).toBe("2026-01-10");
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
  });
});

describe("computeTimelineRange", () => {
  it("spans from the earliest start to the latest end, with small padding", () => {
    const tasks = [task({ id: "t1", name: "a", startDate: "2026-02-01", endDate: "2026-02-10" }), task({ id: "t2", name: "b", startDate: "2026-01-15", endDate: "2026-03-01" })];
    const range = computeTimelineRange(tasks);
    expect(range.start < "2026-01-15").toBe(true);
    expect(range.end > "2026-03-01").toBe(true);
  });

  it("falls back to a sane default range when there are no tasks", () => {
    const range = computeTimelineRange([]);
    expect(range.totalDays).toBe(30);
  });
});

describe("computeMonthMarkers", () => {
  it("returns one marker per calendar month boundary inside the range", () => {
    const range = computeTimelineRange([task({ id: "t1", name: "a", startDate: "2026-01-20", endDate: "2026-03-05" })]);
    const markers = computeMonthMarkers(range);
    expect(markers.map((m) => m.label)).toEqual(["فبراير", "مارس"]);
  });
});
