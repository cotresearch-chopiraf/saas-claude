import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { AuthProvider } from "../../auth/AuthContext";
import { I18nProvider } from "../../i18n/I18nProvider";
import { PunchListSection } from "./PunchListSection";
import type { CompanyMember, PunchItem } from "../../api/types";

vi.mock("../context", () => ({
  useProjectContext: () => ({ project: null, projectId: "p1" }),
}));

vi.mock("../../api/client", async () => {
  const actual = await vi.importActual<typeof import("../../api/client")>("../../api/client");
  return { ...actual, getToken: () => "fake-token", apiFetch: vi.fn() };
});

import { apiFetch } from "../../api/client";

function item(overrides: Partial<PunchItem> & Pick<PunchItem, "id" | "title">): PunchItem {
  return {
    projectId: "p1",
    description: null,
    location: "الدور الأرضي — Zone A",
    priority: "medium",
    status: "open",
    assignedToUserId: null,
    dueDate: null,
    resolutionDescription: null,
    resolvedAt: null,
    resolvedByUserId: null,
    verifiedAt: null,
    verifiedByUserId: null,
    closedAt: null,
    closedByUserId: null,
    createdBy: "u1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const member: CompanyMember = { id: "u1", name: "أحمد", email: "a@test.com", role: "owner", status: "active", createdAt: "2026-01-01T00:00:00.000Z" };

const openItem = item({ id: "i1", title: "تسرب مياه في المنطقة الشمالية", priority: "high", status: "open" });
const inProgressItem = item({ id: "i2", title: "شرخ في الجدار", status: "in_progress" });
const closedItem = item({ id: "i3", title: "ملاحظة مغلقة", status: "closed" });

function mockApi(opts: { items?: PunchItem[]; members?: CompanyMember[] } = {}) {
  const items = opts.items ?? [openItem, inProgressItem];
  const members = opts.members ?? [member];
  vi.mocked(apiFetch).mockImplementation(async (path: unknown) => {
    const p = String(path);
    if (p === "/auth/me") {
      return { user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "co1", name: "Test Co" } };
    }
    if (p === "/company/members") return members;
    if (p.startsWith("/projects/p1/punch-items")) {
      if (p.includes("status=in_progress")) return items.filter((i) => i.status === "in_progress");
      return items;
    }
    throw new Error(`unexpected apiFetch call in test: ${p}`);
  });
}

function renderSection() {
  return render(
    <I18nProvider>
      <AuthProvider>
        <PunchListSection />
      </AuthProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("unexpected global fetch call in test"))),
  );
});

describe("<PunchListSection/>", () => {
  it("renders the list with status/priority labels and the summary counts", async () => {
    mockApi();
    renderSection();

    await waitFor(() => expect(screen.getByText("تسرب مياه في المنطقة الشمالية")).toBeInTheDocument());
    expect(screen.getByText("شرخ في الجدار")).toBeInTheDocument();
    expect(screen.getByText("عالية", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByText("مفتوحة", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByText("قيد التنفيذ", { selector: "span" })).toBeInTheDocument();
  });

  it("shows an honest empty state when no items match", async () => {
    mockApi({ items: [] });
    renderSection();
    await waitFor(() => expect(screen.getByText("لا توجد ملاحظات مطابقة")).toBeInTheDocument());
  });

  it("shows a retryable error state on API failure", async () => {
    const { ApiError } = await import("../../api/client");
    vi.mocked(apiFetch).mockImplementation(async (path: unknown) => {
      const p = String(path);
      if (p === "/auth/me") return { user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "co1", name: "Test Co" } };
      if (p === "/company/members") return [];
      throw new ApiError("تعذّر الاتصال بالخادم", 500);
    });
    renderSection();
    await waitFor(() => expect(screen.getByText("تعذّر الاتصال بالخادم")).toBeInTheDocument());
  });

  it("status filter re-fetches with the status query param", async () => {
    mockApi();
    renderSection();
    await waitFor(() => expect(screen.getByText("تسرب مياه في المنطقة الشمالية")).toBeInTheDocument());

    const statusSelect = screen.getAllByRole("combobox")[0];
    fireEvent.change(statusSelect, { target: { value: "in_progress" } });

    await waitFor(() => expect(screen.queryByText("تسرب مياه في المنطقة الشمالية")).not.toBeInTheDocument());
    expect(screen.getByText("شرخ في الجدار")).toBeInTheDocument();
  });

  it("creating an item posts the form fields", async () => {
    mockApi();
    let created = false;
    vi.mocked(apiFetch).mockImplementation(async (path: unknown, options?: unknown) => {
      const p = String(path);
      const opts = options as { method?: string; body?: string } | undefined;
      if (p === "/auth/me") return { user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "co1", name: "Test Co" } };
      if (p === "/company/members") return [member];
      if (p === "/projects/p1/punch-items" && opts?.method === "POST") {
        created = true;
        const body = JSON.parse(opts.body!);
        expect(body.title).toBe("ملاحظة جديدة");
        expect(body.priority).toBe("high");
        return item({ id: "i9", title: "ملاحظة جديدة", priority: "high" });
      }
      if (p.startsWith("/projects/p1/punch-items")) return created ? [openItem, inProgressItem, item({ id: "i9", title: "ملاحظة جديدة" })] : [openItem, inProgressItem];
      throw new Error(`unexpected: ${p}`);
    });
    renderSection();
    await waitFor(() => expect(screen.getByText("تسرب مياه في المنطقة الشمالية")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "+ ملاحظة جديدة" }));
    fireEvent.change(screen.getByPlaceholderText("العنوان"), { target: { value: "ملاحظة جديدة" } });
    const prioritySelect = screen.getAllByRole("combobox").find((el) => (el as HTMLSelectElement).value === "medium") as HTMLSelectElement;
    fireEvent.change(prioritySelect, { target: { value: "high" } });
    fireEvent.click(screen.getByRole("button", { name: "حفظ الملاحظة" }));

    await waitFor(() => expect(screen.getByText("ملاحظة جديدة")).toBeInTheDocument());
  });

  it("shows only the valid next actions for the item's current status, and none for a closed item", async () => {
    mockApi({ items: [openItem, closedItem] });
    renderSection();
    await waitFor(() => expect(screen.getByText("تسرب مياه في المنطقة الشمالية")).toBeInTheDocument());

    fireEvent.click(screen.getByText("تسرب مياه في المنطقة الشمالية"));
    await waitFor(() => expect(screen.getByRole("button", { name: "بدء العمل" })).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "تعيين" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "إغلاق" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "التحقق" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("ملاحظة مغلقة"));
    await waitFor(() => expect(screen.getAllByText("مغلقة").length).toBeGreaterThan(0));
    expect(screen.queryByRole("button", { name: "بدء العمل" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "إغلاق" })).not.toBeInTheDocument();
  });

  it("resolving an in-progress item requires a resolution description before submitting", async () => {
    mockApi({ items: [inProgressItem] });
    let statusBody: unknown = null;
    vi.mocked(apiFetch).mockImplementation(async (path: unknown, options?: unknown) => {
      const p = String(path);
      const opts = options as { method?: string; body?: string } | undefined;
      if (p === "/auth/me") return { user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "co1", name: "Test Co" } };
      if (p === "/company/members") return [member];
      if (p === "/projects/p1/punch-items/i2/status" && opts?.method === "POST") {
        statusBody = JSON.parse(opts.body!);
        return { ...inProgressItem, status: "resolved", resolutionDescription: (statusBody as { resolutionDescription: string }).resolutionDescription };
      }
      if (p.startsWith("/projects/p1/punch-items")) return [inProgressItem];
      throw new Error(`unexpected: ${p}`);
    });
    renderSection();
    await waitFor(() => expect(screen.getByText("شرخ في الجدار")).toBeInTheDocument());

    fireEvent.click(screen.getByText("شرخ في الجدار"));
    const resolveButton = await screen.findByRole("button", { name: "تحديد كمحلول" });
    fireEvent.click(resolveButton);

    // The resolution textarea now appears; the save button is disabled
    // until real text is entered.
    const saveButton = screen.getByRole("button", { name: "حفظ المعالجة" });
    expect(saveButton).toBeDisabled();

    const textarea = document.querySelector("textarea")!;
    fireEvent.change(textarea, { target: { value: "تم إصلاح الشرخ" } });
    expect(saveButton).not.toBeDisabled();
    fireEvent.click(saveButton);

    await waitFor(() => expect(statusBody).toEqual({ status: "resolved", resolutionDescription: "تم إصلاح الشرخ" }));
  });

  it("verifying a resolved item calls the status endpoint directly (no form)", async () => {
    const resolvedItem = item({ id: "i4", title: "جاهزة للتحقق", status: "resolved", resolutionDescription: "تم الإصلاح", resolvedAt: "2026-01-02T00:00:00.000Z", resolvedByUserId: "u1" });
    let calledVerify = false;
    vi.mocked(apiFetch).mockImplementation(async (path: unknown, options?: unknown) => {
      const p = String(path);
      const opts = options as { method?: string; body?: string } | undefined;
      if (p === "/auth/me") return { user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "co1", name: "Test Co" } };
      if (p === "/company/members") return [member];
      if (p === "/projects/p1/punch-items/i4/status" && opts?.method === "POST") {
        calledVerify = true;
        expect(JSON.parse(opts.body!)).toEqual({ status: "verified" });
        return { ...resolvedItem, status: "verified" };
      }
      if (p.startsWith("/projects/p1/punch-items")) return [resolvedItem];
      throw new Error(`unexpected: ${p}`);
    });
    renderSection();
    await waitFor(() => expect(screen.getByText("جاهزة للتحقق")).toBeInTheDocument());

    fireEvent.click(screen.getByText("جاهزة للتحقق"));
    const verifyButton = await screen.findByRole("button", { name: "التحقق" });
    fireEvent.click(verifyButton);

    await waitFor(() => expect(calledVerify).toBe(true));
  });
});
