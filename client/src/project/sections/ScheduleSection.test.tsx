import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { AuthProvider } from "../../auth/AuthContext";
import { ScheduleSection } from "./ScheduleSection";
import type { ProjectSchedule, ProjectTask, ProjectTaskDependency } from "../../api/types";

vi.mock("../context", () => ({
  useProjectContext: () => ({ project: null, projectId: "p1" }),
}));

vi.mock("../../api/client", async () => {
  const actual = await vi.importActual<typeof import("../../api/client")>("../../api/client");
  return { ...actual, getToken: () => "fake-token", apiFetch: vi.fn() };
});

import { apiFetch } from "../../api/client";

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

const earthworks = task({ id: "t1", name: "الأعمال الترابية", sortOrder: 0 });
const excavation = task({ id: "t2", name: "الحفر", parentTaskId: "t1", sortOrder: 0, progressPercent: 40, status: "in_progress" });
const milestone = task({ id: "t3", name: "معلم التسليم", taskType: "milestone", startDate: "2026-02-01", endDate: "2026-02-01" });
const dependency: ProjectTaskDependency = {
  id: "d1",
  projectId: "p1",
  predecessorTaskId: "t1",
  successorTaskId: "t2",
  dependencyType: "FS",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function scheduleFixture(overrides: Partial<ProjectSchedule> = {}): ProjectSchedule {
  return { tasks: [earthworks, excavation, milestone], dependencies: [dependency], ...overrides };
}

function mockAuthAndApi(role: "owner" | "member", scheduleHandler: (path: string, options?: unknown) => unknown) {
  vi.mocked(apiFetch).mockImplementation(async (path: unknown, options?: unknown) => {
    const p = String(path);
    if (p === "/auth/me") {
      return { user: { id: "u1", name: "Test", email: "t@test.com", role }, company: { id: "co1", name: "Test Co" } };
    }
    return scheduleHandler(p, options);
  });
}

function renderSection() {
  return render(
    <AuthProvider>
      <ScheduleSection />
    </AuthProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("unexpected global fetch call in test"))),
  );
});

describe("<ScheduleSection/>", () => {
  it("shows the loading skeleton, then hierarchy with WBS numbering and status badges", async () => {
    mockAuthAndApi("owner", (p) => (p === "/projects/p1/schedule" ? Promise.resolve(scheduleFixture()) : Promise.reject(new Error(`unexpected: ${p}`))));
    renderSection();

    await waitFor(() => expect(document.querySelector('p[title="الأعمال الترابية"]')).toBeInTheDocument());
    expect(document.querySelector('p[title="الحفر"]')).toBeInTheDocument();
    expect(screen.getByText("قيد التنفيذ", { selector: "span" })).toBeInTheDocument();
    expect(document.querySelector('p[title="معلم التسليم"]')).toBeInTheDocument();
    // WBS numbering: the top-level task is "1", its child is "1.1".
    expect(document.querySelector('p[title="الأعمال الترابية"]')?.textContent).toContain("1");
    expect(document.querySelector('p[title="الحفر"]')?.textContent).toContain("1.1");
  });

  it("shows an honest empty state when the project has no scheduling data yet", async () => {
    mockAuthAndApi("owner", (p) => (p === "/projects/p1/schedule" ? Promise.resolve({ tasks: [], dependencies: [] }) : Promise.reject(new Error(`unexpected: ${p}`))));
    renderSection();
    await waitFor(() => expect(screen.getByText("لا توجد مهام أو معالم في الجدول الزمني بعد")).toBeInTheDocument());
  });

  it("shows a retryable error state on API failure", async () => {
    const { ApiError } = await import("../../api/client");
    mockAuthAndApi("owner", (p) => (p === "/projects/p1/schedule" ? Promise.reject(new ApiError("تعذّر الاتصال بالخادم", 500)) : Promise.reject(new Error(`unexpected: ${p}`))));
    renderSection();
    await waitFor(() => expect(screen.getByText("تعذّر الاتصال بالخادم")).toBeInTheDocument());
  });

  it("status filter narrows the visible rows", async () => {
    mockAuthAndApi("owner", (p) => (p === "/projects/p1/schedule" ? Promise.resolve(scheduleFixture()) : Promise.reject(new Error(`unexpected: ${p}`))));
    renderSection();
    await waitFor(() => expect(document.querySelector('p[title="الأعمال الترابية"]')).toBeInTheDocument());

    const select = screen.getAllByRole("combobox").find((el) => (el as HTMLSelectElement).value === "all") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "in_progress" } });

    await waitFor(() => expect(document.querySelector('p[title="الأعمال الترابية"]')).not.toBeInTheDocument());
    expect(document.querySelector('p[title="الحفر"]')).toBeInTheDocument();
  });

  it("creating a task posts the form fields and reloads the schedule", async () => {
    let created = false;
    mockAuthAndApi("owner", (p, options) => {
      if (p === "/projects/p1/schedule") {
        return Promise.resolve(created ? scheduleFixture({ tasks: [...scheduleFixture().tasks, task({ id: "t9", name: "مهمة جديدة" })] }) : scheduleFixture());
      }
      if (p === "/projects/p1/schedule/tasks" && (options as { method?: string })?.method === "POST") {
        created = true;
        const body = JSON.parse((options as { body: string }).body);
        expect(body.name).toBe("مهمة جديدة");
        expect(body.startDate).toBe("2026-04-01");
        expect(body.endDate).toBe("2026-04-10");
        return Promise.resolve(task({ id: "t9", name: "مهمة جديدة", startDate: "2026-04-01", endDate: "2026-04-10" }));
      }
      return Promise.reject(new Error(`unexpected: ${p}`));
    });
    renderSection();
    await waitFor(() => expect(document.querySelector('p[title="الأعمال الترابية"]')).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "+ مهمة جديدة" }));
    fireEvent.change(screen.getByPlaceholderText("اسم المهمة"), { target: { value: "مهمة جديدة" } });
    const dateInputs = document.querySelectorAll('input[type="date"]');
    fireEvent.change(dateInputs[0], { target: { value: "2026-04-01" } });
    fireEvent.change(dateInputs[1], { target: { value: "2026-04-10" } });
    fireEvent.click(screen.getByRole("button", { name: "حفظ المهمة" }));

    await waitFor(() => expect(document.querySelector('p[title="مهمة جديدة"]')).toBeInTheDocument());
  });

  it("a milestone form locks the end date to the start date", async () => {
    mockAuthAndApi("owner", (p) => (p === "/projects/p1/schedule" ? Promise.resolve(scheduleFixture()) : Promise.reject(new Error(`unexpected: ${p}`))));
    renderSection();
    await waitFor(() => expect(document.querySelector('p[title="الأعمال الترابية"]')).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "+ مهمة جديدة" }));
    const typeSelect = screen.getByDisplayValue("مهمة");
    fireEvent.change(typeSelect, { target: { value: "milestone" } });

    // Only one date input remains for a milestone (the end-date field is
    // hidden entirely, never shown-but-disabled with a stale value).
    expect(document.querySelectorAll('input[type="date"]')).toHaveLength(1);
  });

  it("only an owner sees delete controls for tasks and dependencies (member-open create/update, owner-only delete)", async () => {
    mockAuthAndApi("member", (p) => (p === "/projects/p1/schedule" ? Promise.resolve(scheduleFixture()) : Promise.reject(new Error(`unexpected: ${p}`))));
    renderSection();
    await waitFor(() => expect(document.querySelector('p[title="الأعمال الترابية"]')).toBeInTheDocument());

    expect(screen.queryByRole("button", { name: "حذف" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "حذف الربط" })).not.toBeInTheDocument();
    // Create/edit stays available to a member.
    expect(screen.getByRole("button", { name: "+ مهمة جديدة" })).toBeInTheDocument();
    expect(screen.getAllByText("تعديل").length).toBeGreaterThan(0);
  });

  it("deleting a task requires confirmation, then calls DELETE and reloads", async () => {
    let deleted = false;
    mockAuthAndApi("owner", (p, options) => {
      if (p === "/projects/p1/schedule") {
        return Promise.resolve(deleted ? { tasks: [excavation, milestone], dependencies: [] } : scheduleFixture());
      }
      if (p === "/projects/p1/schedule/tasks/t1" && (options as { method?: string })?.method === "DELETE") {
        deleted = true;
        return Promise.resolve(undefined);
      }
      return Promise.reject(new Error(`unexpected: ${p}`));
    });
    renderSection();
    await waitFor(() => expect(document.querySelector('p[title="الأعمال الترابية"]')).toBeInTheDocument());

    const deleteButtons = screen.getAllByRole("button", { name: "حذف" });
    fireEvent.click(deleteButtons[0]);

    const dialog = await screen.findByText("حذف المهمة");
    const dialogContainer = dialog.closest("div")!.parentElement!;
    fireEvent.click(within(dialogContainer).getByRole("button", { name: "تأكيد" }));

    await waitFor(() => expect(document.querySelector('p[title="الأعمال الترابية"]')).not.toBeInTheDocument());
  });

  it("the dependencies panel lists existing links and explains FS in plain language", async () => {
    mockAuthAndApi("owner", (p) => (p === "/projects/p1/schedule" ? Promise.resolve(scheduleFixture()) : Promise.reject(new Error(`unexpected: ${p}`))));
    renderSection();
    await waitFor(() => expect(screen.getByText("المهمة التالية تبدأ بعد انتهاء المهمة السابقة.")).toBeInTheDocument());
    expect(screen.getByText(/الأعمال الترابية.*الحفر/)).toBeInTheDocument();
  });
});
