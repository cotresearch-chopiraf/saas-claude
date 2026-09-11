import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../auth/AuthContext";
import { I18nProvider } from "../i18n/I18nProvider";
import { BudgetAlerts } from "./BudgetAlerts";
import type { BudgetAlert, Project } from "../api/types";

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return { ...actual, getToken: () => "fake-token", apiFetch: vi.fn() };
});

import { apiFetch } from "../api/client";

const fixtureProject: Project = {
  id: "p1",
  companyId: "co1",
  name: "برج الرياض",
  clientName: null,
  customerId: null,
  address: null,
  status: "active",
  budgetTotal: "0.00",
  startDate: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const fixtureOpenCritical: BudgetAlert = {
  id: "ba1",
  companyId: "co1",
  projectId: "p1",
  costCodeId: null,
  ruleCode: "actual_commitments_over_budget",
  severity: "critical",
  status: "open",
  metricType: "exposure_over_budget_amount",
  metricValue: "1000000.00",
  thresholdValue: "0.00",
  budgetAmount: "20000000.00",
  actualAmount: "15000000.00",
  commitmentAmount: "6000000.00",
  forecastAmount: null,
  currency: "SAR",
  title: "التكلفة الفعلية والالتزامات تجاوزت الميزانية المعتمدة",
  description: "مجموع التكلفة الفعلية والالتزامات التعاقدية تجاوز الميزانية المعتمدة لهذا المشروع.",
  recommendedAction: "راجع الالتزامات المفتوحة فوراً — التكلفة الفعلية والالتزامات مجتمعة تجاوزت الميزانية المعتمدة بالفعل.",
  createdAt: "2026-08-01T00:00:00.000Z",
  acknowledgedAt: null,
  acknowledgedByUserId: null,
  resolvedAt: null,
  resolvedByUserId: null,
  updatedAt: "2026-08-01T00:00:00.000Z",
  project: { id: "p1", name: "برج الرياض" },
  costCode: null,
};

const fixtureAcknowledgedWarning: BudgetAlert = {
  ...fixtureOpenCritical,
  id: "ba2",
  ruleCode: "budget_consumption_threshold",
  severity: "warning",
  status: "acknowledged",
  metricType: "budget_consumption_percent",
  metricValue: "91.00",
  thresholdValue: "90.00",
  title: "استهلاك الميزانية وصل إلى 91%",
  description: "بلغت التكلفة الفعلية والالتزامات مجتمعة 91% من الميزانية المعتمدة (العتبة: 90%).",
  acknowledgedAt: "2026-08-02T00:00:00.000Z",
  acknowledgedByUserId: "u1",
  forecastAmount: null,
  commitmentAmount: null,
};

function mockApi(overrides: { alerts?: BudgetAlert[]; role?: "owner" | "member" } = {}) {
  const alerts = overrides.alerts ?? [fixtureOpenCritical, fixtureAcknowledgedWarning];
  const role = overrides.role ?? "owner";

  vi.mocked(apiFetch).mockImplementation(async (path: unknown, options?: unknown) => {
    const p = String(path);
    const method = (options as { method?: string })?.method;
    if (p === "/auth/me") return { user: { id: "u1", name: "Test", email: "t@test.com", role }, company: { id: "co1", name: "Test Co" } };
    if (p === "/projects") return [fixtureProject];
    if (p.startsWith("/budget-alerts/evaluate") && method === "POST") return { evaluatedProjectCount: 1, createdCount: 0 };
    if (p.startsWith("/budget-alerts/ba1/acknowledge") && method === "POST") return { ...fixtureOpenCritical, status: "acknowledged", acknowledgedAt: "2026-08-03T00:00:00.000Z", acknowledgedByUserId: "u1" };
    if (p.startsWith("/budget-alerts/ba1/resolve") && method === "POST") return { ...fixtureOpenCritical, status: "resolved", resolvedAt: "2026-08-03T00:00:00.000Z", resolvedByUserId: "u1" };
    if (p.startsWith("/budget-alerts/ba1")) return fixtureOpenCritical;
    if (p.startsWith("/budget-alerts")) return alerts;
    throw new Error(`unexpected apiFetch call in test: ${p}`);
  });
}

function renderPage() {
  return render(
    <I18nProvider>
    <MemoryRouter>
      <AuthProvider>
        <BudgetAlerts />
      </AuthProvider>
    </MemoryRouter>
    </I18nProvider>,
  );
}

describe("<BudgetAlerts/>", () => {
  it("renders the RTL page with the severity summary and top alerts", async () => {
    mockApi();
    renderPage();
    await waitFor(() => expect(screen.getByText("يحتاج إلى انتباه")).toBeInTheDocument());
    expect(document.querySelector('[dir="rtl"]')).toBeInTheDocument();
    expect(screen.getAllByText(/استهلاك الميزانية وصل إلى 91%/).length).toBeGreaterThan(0);
  });

  it("shows severity and status badges on each alert row", async () => {
    mockApi();
    renderPage();
    await waitFor(() => expect(screen.getAllByText(/التكلفة الفعلية والالتزامات تجاوزت الميزانية المعتمدة/).length).toBeGreaterThan(0));
    expect(screen.getAllByText("حرج").length).toBeGreaterThan(0);
    expect(screen.getAllByText("تحذير").length).toBeGreaterThan(0);
    expect(screen.getAllByText("مفتوح").length).toBeGreaterThan(0);
    expect(screen.getAllByText("تمت المشاهدة").length).toBeGreaterThan(0);
  });

  it("clicking an alert opens its detail view with explainability fields and money formatting", async () => {
    mockApi();
    renderPage();
    await waitFor(() => expect(screen.getAllByText(/التكلفة الفعلية والالتزامات تجاوزت الميزانية المعتمدة/).length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText(/التكلفة الفعلية والالتزامات تجاوزت الميزانية المعتمدة/)[0]);

    await waitFor(() => expect(screen.getByText("لماذا ظهر هذا التنبيه؟")).toBeInTheDocument());
    expect(screen.getByText("ماذا يجب أن أفعل؟")).toBeInTheDocument();
    // Money is rendered through the shared formatter (SAR symbol), never a
    // hard-coded "$".
    const bodyText = document.body.textContent ?? "";
    expect(bodyText).not.toContain("$");
    expect(bodyText).toMatch(/ر\.س|SAR/);
    expect(screen.getAllByText(/عند إنشاء التنبيه/).length).toBeGreaterThan(0);
  });

  it("acknowledge calls the dedicated endpoint and refreshes state", async () => {
    mockApi();
    renderPage();
    await waitFor(() => expect(screen.getAllByText(/التكلفة الفعلية والالتزامات تجاوزت الميزانية المعتمدة/).length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText(/التكلفة الفعلية والالتزامات تجاوزت الميزانية المعتمدة/)[0]);
    await waitFor(() => expect(screen.getByRole("button", { name: "تأكيد المشاهدة" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "تأكيد المشاهدة" }));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith("/budget-alerts/ba1/acknowledge", expect.objectContaining({ method: "POST" })),
    );
  });

  it("resolve calls the dedicated endpoint", async () => {
    mockApi();
    renderPage();
    await waitFor(() => expect(screen.getAllByText(/التكلفة الفعلية والالتزامات تجاوزت الميزانية المعتمدة/).length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText(/التكلفة الفعلية والالتزامات تجاوزت الميزانية المعتمدة/)[0]);
    await waitFor(() => expect(screen.getByRole("button", { name: "تحديد كمحلول" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "تحديد كمحلول" }));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith("/budget-alerts/ba1/resolve", expect.objectContaining({ method: "POST" })),
    );
  });

  it("a member cannot see acknowledge/resolve controls (UI-only mirror of the server gate)", async () => {
    mockApi({ role: "member" });
    renderPage();
    await waitFor(() => expect(screen.getAllByText(/التكلفة الفعلية والالتزامات تجاوزت الميزانية المعتمدة/).length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByText(/التكلفة الفعلية والالتزامات تجاوزت الميزانية المعتمدة/)[0]);
    await waitFor(() => expect(screen.getByText("لماذا ظهر هذا التنبيه؟")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "تأكيد المشاهدة" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "تحديد كمحلول" })).not.toBeInTheDocument();
  });

  it("honest empty state — never claims the project is 'safe'", async () => {
    mockApi({ alerts: [] });
    renderPage();
    await waitFor(() => expect(screen.getByText("لا توجد تنبيهات مالية حالية")).toBeInTheDocument());
    expect(screen.getAllByText("لا توجد حالياً مؤشرات مالية تتجاوز قواعد التنبيه المحددة.").length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/آمن/);
  });

  it("shows a retryable error state when the list fails to load", async () => {
    const { ApiError } = await import("../api/client");
    vi.mocked(apiFetch).mockImplementation(async (path: unknown) => {
      const p = String(path);
      if (p === "/auth/me") return { user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "co1", name: "Test Co" } };
      if (p === "/projects") return [];
      throw new ApiError("تعذّر الاتصال بالخادم", 500);
    });
    renderPage();
    await waitFor(() => expect(screen.getAllByText("تعذّر الاتصال بالخادم").length).toBeGreaterThan(0));
  });

  it("clicking 'تحديث التنبيهات' triggers server-side evaluation, never a client-computed alert", async () => {
    mockApi();
    renderPage();
    await waitFor(() => expect(screen.getByText("تحديث التنبيهات")).toBeInTheDocument());
    fireEvent.click(screen.getByText("تحديث التنبيهات"));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith("/budget-alerts/evaluate", expect.objectContaining({ method: "POST" })),
    );
  });

  it("filtering the list by status narrows the below-the-fold list (summary card is unaffected)", async () => {
    mockApi();
    renderPage();
    await waitFor(() => expect(screen.getAllByText(/التكلفة الفعلية والالتزامات تجاوزت الميزانية المعتمدة/).length).toBeGreaterThan(0));
    // Neither fixture is "resolved" — filtering to it empties the list
    // while the summary card (which always reflects active alerts) is
    // untouched by this filter.
    fireEvent.click(screen.getByRole("button", { name: "تم الحل" }));
    await waitFor(() => expect(screen.getByText("لا توجد تنبيهات مالية حالية")).toBeInTheDocument());
    expect(screen.getAllByText(/التكلفة الفعلية والالتزامات تجاوزت الميزانية المعتمدة/).length).toBeGreaterThan(0);
  });
});
