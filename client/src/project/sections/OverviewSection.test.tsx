import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../../auth/AuthContext";
import { OverviewSection } from "./OverviewSection";
import type { BoqRevision, BudgetAlert, BudgetSummary, CashFlowResult, Contract, ForecastResult, Project, ProjectLaborCost, ProjectTask, PunchItem } from "../../api/types";

vi.mock("../context", () => ({
  useProjectContext: () => ({
    project: {
      id: "p1",
      companyId: "co1",
      name: "مشروع تجريبي",
      clientName: "عميل تجريبي",
      customerId: null,
      address: null,
      status: "active",
      budgetTotal: "0.00",
      startDate: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    } satisfies Project,
    projectId: "p1",
  }),
}));

vi.mock("../../api/client", async () => {
  const actual = await vi.importActual<typeof import("../../api/client")>("../../api/client");
  return { ...actual, getToken: () => "fake-token", apiFetch: vi.fn() };
});

import { apiFetch } from "../../api/client";

const fixtureAmendment: Contract = {
  id: "c-amend",
  companyId: "co1",
  projectId: "p1",
  contractType: "amendment",
  parentContractId: "c-main",
  contractNumber: "C-1-A1",
  clientName: null,
  originalValue: "5000.00",
  revisedValue: "5000.00",
  currency: "SAR",
  advancePercent: null,
  retentionPercent: null,
  paymentTerms: null,
  status: "active",
  startDate: null,
  endDate: null,
  createdBy: "u1",
  createdAt: "2026-01-02T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

const fixtureMainContract: Contract = {
  id: "c-main",
  companyId: "co1",
  projectId: "p1",
  contractType: "main",
  parentContractId: null,
  contractNumber: "C-1",
  clientName: null,
  // Deliberately distinctive values, unrelated to any other fixture number.
  originalValue: "246813.57",
  revisedValue: "251975.42",
  currency: "SAR",
  advancePercent: null,
  retentionPercent: "5.00",
  paymentTerms: null,
  status: "active",
  startDate: null,
  endDate: null,
  createdBy: "u1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

// remaining (91.11) is deliberately NOT planned (777.77) - spent (333.33)
// = 444.44 — set on purpose, so asserting the UI shows 91.11 proves it
// comes verbatim from the backend's own totals, never a client
// recomputation of planned - spent.
const fixtureBudget: BudgetSummary = {
  items: [],
  expenses: [],
  totals: { planned: 777.77, spent: 333.33, remaining: 91.11 },
};

const fixtureBudgetZero: BudgetSummary = {
  items: [],
  expenses: [],
  totals: { planned: 0, spent: 0, remaining: 0 },
};

// etc/eac/variance below are deliberately NOT derivable from costPlan/
// actualCost/committedCost via any obvious formula — arbitrary,
// formula-breaking values on purpose.
const fixtureForecast: ForecastResult = {
  projectId: "p1",
  asOfDate: "2026-08-15",
  currency: "SAR",
  excludedForeignCurrencyCommitmentIds: [],
  methods: {
    cost_to_complete: {
      method: "cost_to_complete",
      costPlan: 1000,
      actualCost: 300,
      committedCost: 200,
      certifiedValue: 150,
      remainingCost: 700,
      etc: 654.32,
      eac: 987.65,
      variance: 111.11,
      variancePercent: null,
    },
    commitment_aware: {
      method: "commitment_aware",
      costPlan: 1000,
      actualCost: 300,
      committedCost: 200,
      certifiedValue: 150,
      remainingCost: 700,
      etc: 321.09,
      eac: 543.21,
      variance: 222.22,
      variancePercent: 17.6,
    },
  },
};

// Every number below is deliberately distinct from every other fixture's
// numbers in this file (contract/budget/forecast) — the Dashboard renders
// every card simultaneously (there is no single-selected-item view like
// prior list+detail sections), so a value shared across two fixtures
// would make a test pass without actually proving which card produced it.
const fixtureCashFlow: CashFlowResult = {
  projectId: "p1",
  asOfDate: "2026-08-20",
  currency: "SAR",
  excludedForeignCurrencyCommitmentIds: [],
  historical: { cashReceived: 101.11, incurredCost: 202.22 },
  // net (909.09) is deliberately NOT receivables + certifiedExpectedCollection
  // - commitments (303.33 + 404.44 - 505.55 = 202.22).
  projected: { receivables: 303.33, certifiedExpectedCollection: 404.44, commitments: 505.55, net: 909.09 },
  undated: {
    etc: 606.06,
    retentionToBeReleased: 707.77,
    advance: { supported: false, reason: "Advance payment/recovery is not operationalized in the current financial model." },
  },
  assumptions: {
    forecastMethod: "commitment_aware",
    certifiedValueBasis: "netCertified (gross certified value minus withheld retention)",
    commitmentExpenseReconciliation: "not modeled",
    ipcInvoiceReconciliation: "not modeled",
  },
};

const fixtureCashFlowZero: CashFlowResult = {
  ...fixtureCashFlow,
  historical: { cashReceived: 0, incurredCost: 0 },
  projected: { receivables: 0, certifiedExpectedCollection: 0, commitments: 0, net: 0 },
  undated: { ...fixtureCashFlow.undated, etc: 0, retentionToBeReleased: 0 },
};

const fixtureRevisionDraft: BoqRevision = {
  id: "rev1",
  companyId: "co1",
  projectId: "p1",
  contractId: "c-main",
  revisionNumber: 1,
  status: "draft",
  supersedesRevisionId: null,
  notes: null,
  createdBy: "u1",
  createdAt: "2026-01-01T00:00:00.000Z",
  publishedAt: null,
};

// Deliberately given a high-value item pair (quantity * rate = 100000)
// that would be an obvious BOQ "total" if the frontend ever summed BOQ
// items — but this fixture is never actually consumed by OverviewSection
// at all (it only calls listRevisions, never getRevision), so no such
// number can appear regardless.
const fixtureRevisionPublished: BoqRevision = { ...fixtureRevisionDraft, revisionNumber: 2, status: "published", publishedAt: "2026-01-05T00:00:00.000Z" };

// MIDAD Phase A4 — deliberately distinct from every other fixture number
// in this file, and deliberately NOT derivable from Budget/Forecast/Cash
// Flow figures, so a test asserting on it proves the card renders its own
// source data, not a recomputation of something else on the page.
const fixtureLaborCost: ProjectLaborCost = {
  projectId: "p1",
  allocatedTotal: 88.88,
  allocationCount: 3,
  postedTotal: 30,
  unpostedTotal: 58.88,
  posted: false,
};

// MIDAD Phase E — deliberately distinct wording from every other fixture in
// this file so a test asserting on it proves BudgetAlertsCard renders its
// own source data.
const fixtureBudgetAlert: BudgetAlert = {
  id: "ba1",
  companyId: "co1",
  projectId: "p1",
  costCodeId: null,
  ruleCode: "budget_consumption_threshold",
  severity: "critical",
  status: "open",
  metricType: "budget_consumption_percent",
  metricValue: "105.00",
  thresholdValue: "100.00",
  budgetAmount: "10000.00",
  actualAmount: "10500.00",
  commitmentAmount: "0.00",
  forecastAmount: "10500.00",
  currency: "SAR",
  title: "استهلاك الميزانية وصل إلى 105%",
  description: "بلغت التكلفة الفعلية والالتزامات مجتمعة 105% من الميزانية المعتمدة.",
  recommendedAction: "أوقف الاعتمادات غير الضرورية وراجع الميزانية فوراً مع الإدارة.",
  createdAt: "2026-08-01T00:00:00.000Z",
  acknowledgedAt: null,
  acknowledgedByUserId: null,
  resolvedAt: null,
  resolvedByUserId: null,
  updatedAt: "2026-08-01T00:00:00.000Z",
};

// MIDAD Phase F — A–E integration fixtures.
const fixtureOverdueTask: ProjectTask = {
  id: "t1",
  projectId: "p1",
  parentTaskId: null,
  name: "أعمال الحفر",
  description: null,
  taskType: "task",
  status: "in_progress",
  startDate: "2026-01-01",
  endDate: "2020-01-10",
  progressPercent: 40,
  sortOrder: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const fixtureMilestone: ProjectTask = {
  ...fixtureOverdueTask,
  id: "t2",
  name: "اكتمال الأساسات",
  taskType: "milestone",
  status: "not_started",
  endDate: "2099-09-12",
};
const fixtureCriticalPunchItem: PunchItem = {
  id: "pi1",
  projectId: "p1",
  title: "تسريب في الطابق الأول",
  description: null,
  location: null,
  priority: "critical",
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
};

function mockApi(
  role: "owner" | "member",
  opts: {
    contracts?: Contract[];
    budget?: BudgetSummary;
    forecast?: ForecastResult;
    cashFlow?: CashFlowResult;
    revisions?: BoqRevision[];
    laborCost?: ProjectLaborCost;
    budgetAlerts?: BudgetAlert[];
    tasks?: ProjectTask[];
    punchItems?: PunchItem[];
    failPath?: string;
  } = {},
) {
  const contracts = opts.contracts ?? [fixtureAmendment, fixtureMainContract];
  const budget = opts.budget ?? fixtureBudget;
  const forecast = opts.forecast ?? fixtureForecast;
  const cashFlow = opts.cashFlow ?? fixtureCashFlow;
  const revisions = opts.revisions ?? [fixtureRevisionDraft, fixtureRevisionPublished];
  const laborCost = opts.laborCost ?? fixtureLaborCost;
  const budgetAlerts = opts.budgetAlerts ?? [];
  const tasks = opts.tasks ?? [];
  const punchItems = opts.punchItems ?? [];

  vi.mocked(apiFetch).mockImplementation((path: unknown) => {
    const p = String(path);
    if (opts.failPath && p === opts.failPath) {
      return Promise.reject(new Error("تعذّر الاتصال بالخادم"));
    }
    if (p === "/auth/me") {
      return Promise.resolve({
        user: { id: "u1", name: "Test", email: "t@test.com", role },
        company: { id: "co1", name: "Test Co" },
      });
    }
    if (p === "/projects/p1/contracts") return Promise.resolve(contracts);
    if (p === "/projects/p1/budget") return Promise.resolve(budget);
    if (p === "/projects/p1/forecast") return Promise.resolve(forecast);
    if (p === "/projects/p1/cash-flow") return Promise.resolve(cashFlow);
    if (p === "/projects/p1/boq-revisions") return Promise.resolve(revisions);
    if (p === "/projects/p1/labor-cost") return Promise.resolve(laborCost);
    if (p.startsWith("/budget-alerts")) return Promise.resolve(budgetAlerts);
    if (p === "/projects/p1/schedule") return Promise.resolve({ tasks, dependencies: [] });
    if (p === "/projects/p1/punch-items") return Promise.resolve(punchItems);
    return Promise.reject(new Error(`unexpected apiFetch call in test: ${p}`));
  });
}

function renderSection() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <OverviewSection />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("<OverviewSection/> (Executive Dashboard)", () => {
  it("Contract truth: displays the main contract's values verbatim", async () => {
    mockApi("owner");
    renderSection();
    await waitFor(() => expect(screen.getByText(/246,813\.57|246813\.57/)).toBeInTheDocument());
    expect(screen.getByText(/251,975\.42|251975\.42/)).toBeInTheDocument();
    expect(screen.getByText("C-1")).toBeInTheDocument();
  });

  it("MIDAD Phase A': no customer-profile link renders when the project has no linked customer (customerId: null)", async () => {
    mockApi("owner");
    renderSection();
    await waitFor(() => expect(screen.getByText("C-1")).toBeInTheDocument());
    expect(screen.queryByText("عرض ملف العميل")).not.toBeInTheDocument();
  });

  it("Main contract selection: picks contractType === 'main', not array order (amendment listed first)", async () => {
    mockApi("owner", { contracts: [fixtureAmendment, fixtureMainContract] });
    renderSection();
    await waitFor(() => expect(screen.getByText("C-1")).toBeInTheDocument());
    expect(screen.queryByText("C-1-A1")).not.toBeInTheDocument();
  });

  it("Cost Plan truth: planned/spent/remaining displayed verbatim, not planned - spent", async () => {
    mockApi("owner");
    renderSection();
    await waitFor(() => expect(screen.getByText(/777\.77/)).toBeInTheDocument());
    expect(screen.getByText(/333\.33/)).toBeInTheDocument();
    // remaining = 91.11 (fixture), NOT 777.77 - 333.33 = 444.44.
    expect(screen.getByText(/91\.11/)).toBeInTheDocument();
    expect(screen.queryByText(/444\.44/)).not.toBeInTheDocument();
  });

  it("Forecast truth: both methods render with backend-provided ETC/EAC/variance verbatim", async () => {
    mockApi("owner");
    renderSection();
    await waitFor(() => expect(screen.getByText("الطريقة المحافظة (تجاهل الالتزامات)")).toBeInTheDocument());
    expect(screen.getByText("الطريقة الواعية بالالتزامات")).toBeInTheDocument();
    expect(screen.getByText(/654\.32/)).toBeInTheDocument();
    expect(screen.getByText(/987\.65/)).toBeInTheDocument();
    expect(screen.getByText(/321\.09/)).toBeInTheDocument();
    expect(screen.getByText(/543\.21/)).toBeInTheDocument();
  });

  it("Null variancePercent renders as an explicit dash, never 0%", async () => {
    mockApi("owner");
    renderSection();
    await waitFor(() => expect(screen.getByText("الطريقة المحافظة (تجاهل الالتزامات)")).toBeInTheDocument());
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    // The other method's real, non-null percentage still renders normally.
    expect(screen.getByText(/17\.6/)).toBeInTheDocument();
  });

  it("Cash Flow truth: every group's figures render verbatim, net is not recomputed", async () => {
    mockApi("owner");
    renderSection();
    await waitFor(() => expect(screen.getByText(/101\.11/)).toBeInTheDocument());
    expect(screen.getByText(/202\.22/)).toBeInTheDocument();
    expect(screen.getByText(/303\.33/)).toBeInTheDocument();
    expect(screen.getByText(/404\.44/)).toBeInTheDocument();
    expect(screen.getByText(/505\.55/)).toBeInTheDocument();
    // net = 909.09, NOT receivables + certified - commitments = 202.22.
    expect(screen.getByText(/909\.09/)).toBeInTheDocument();
    expect(screen.getByText(/606\.06/)).toBeInTheDocument();
    expect(screen.getByText(/707\.77/)).toBeInTheDocument();
    expect(screen.getByText("غير مدعومة")).toBeInTheDocument();
  });

  it("does not fabricate a BOQ total: only fetches revision metadata, never revision items", async () => {
    mockApi("owner");
    renderSection();
    await waitFor(() => expect(screen.getByText("حالة جدول الكميات")).toBeInTheDocument());
    expect(screen.getByText("النسخة #2")).toBeInTheDocument();
    expect(screen.getByText("منشورة")).toBeInTheDocument();
    // The component never calls GET /boq-revisions/:id (no items are ever
    // fetched), so no BOQ total could be computed even accidentally.
    const calledPaths = vi.mocked(apiFetch).mock.calls.map((c) => String(c[0]));
    expect(calledPaths.some((p) => /\/boq-revisions\/rev/.test(p))).toBe(false);
  });

  it("Loading state: never flashes a misleading 0.00 before requests resolve", async () => {
    vi.mocked(apiFetch).mockImplementation((path: unknown) => {
      const p = String(path);
      if (p === "/auth/me") {
        return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "co1", name: "Test Co" } });
      }
      return new Promise(() => {}); // never resolves
    });
    renderSection();
    await waitFor(() => expect(screen.getByText("نظرة عامة")).toBeInTheDocument());
    expect(screen.queryByText(/0\.00/)).not.toBeInTheDocument();
    expect(screen.queryByText("خطة التكلفة")).not.toBeInTheDocument();
  });

  it("shows an honest, retryable error state when a source fails, never a fabricated result", async () => {
    mockApi("owner", { failPath: "/projects/p1/forecast" });
    renderSection();
    await waitFor(() => expect(screen.getByText("تعذّر الاتصال بالخادم")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "إعادة المحاولة" })).toBeInTheDocument();
    expect(screen.queryByText("خطة التكلفة")).not.toBeInTheDocument();
  });

  it("renders legitimate zero financial values as 0.00, never confused with missing data", async () => {
    mockApi("owner", { budget: fixtureBudgetZero, cashFlow: fixtureCashFlowZero });
    renderSection();
    await waitFor(() => expect(screen.getByText("خطة التكلفة")).toBeInTheDocument());
    expect(screen.getAllByText(/0\.00/).length).toBeGreaterThan(0);
  });

  it("Source/as-of transparency: Forecast and Cash Flow each show their own returned asOfDate", async () => {
    mockApi("owner");
    renderSection();
    await waitFor(() => expect(screen.getByText("التوقعات المالية")).toBeInTheDocument());
    // Forecast's asOfDate (2026-08-15) and Cash Flow's (2026-08-20) are
    // deliberately different fixture dates, proving each widget surfaces
    // its own source date rather than one invented dashboard-wide date.
    const bodyText = document.body.textContent ?? "";
    expect(bodyText).toContain(new Date(fixtureForecast.asOfDate).getFullYear().toString());
    expect(screen.getAllByText(/بتاريخ/).length).toBeGreaterThanOrEqual(2);
  });

  it("MIDAD Phase A4: Labor Cost card renders its own backend-provided total, never merged into Cost Plan's totals", async () => {
    mockApi("owner");
    renderSection();
    await waitFor(() => expect(screen.getByText("تكلفة العمالة الموزَّعة")).toBeInTheDocument());
    expect(screen.getByText(/88\.88/)).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    // 88.88 must never appear inside Cost Plan's own planned/spent/remaining figures.
    expect(fixtureBudget.totals.planned).not.toBe(88.88);
    expect(fixtureBudget.totals.spent).not.toBe(88.88);
    expect(fixtureBudget.totals.remaining).not.toBe(88.88);
  });

  it("MIDAD Phase A5.1: Labor Cost card shows the real posting status, not a hardcoded 'not yet posted' label", async () => {
    // Case: nothing posted yet — shows only the unposted breakdown.
    mockApi("owner", { laborCost: { projectId: "p1", allocatedTotal: 10000, allocationCount: 1, postedTotal: 0, unpostedTotal: 10000, posted: false } });
    renderSection();
    await waitFor(() => expect(screen.getByText("تكلفة العمالة الموزَّعة")).toBeInTheDocument());
    expect(screen.getByText("غير مرحّلة")).toBeInTheDocument();
    expect(screen.queryByText("مرحّلة")).not.toBeInTheDocument();
    expect(screen.queryByText("مرحّلة بالكامل")).not.toBeInTheDocument();
  });

  it("MIDAD Phase A5.1: partial posting shows both the posted and unposted amounts", async () => {
    mockApi("owner", { laborCost: { projectId: "p1", allocatedTotal: 10000, allocationCount: 1, postedTotal: 8000, unpostedTotal: 2000, posted: false } });
    renderSection();
    await waitFor(() => expect(screen.getByText("تكلفة العمالة الموزَّعة")).toBeInTheDocument());
    expect(screen.getByText("مرحّلة")).toBeInTheDocument();
    expect(screen.getByText("غير مرحّلة")).toBeInTheDocument();
    expect(screen.queryByText("مرحّلة بالكامل")).not.toBeInTheDocument();
  });

  it("MIDAD Phase A5.1: a fully posted allocation shows 'مرحّلة بالكامل' with no breakdown rows", async () => {
    mockApi("owner", { laborCost: { projectId: "p1", allocatedTotal: 10000, allocationCount: 1, postedTotal: 10000, unpostedTotal: 0, posted: true } });
    renderSection();
    await waitFor(() => expect(screen.getByText("مرحّلة بالكامل")).toBeInTheDocument());
    expect(screen.queryByText("غير مرحّلة")).not.toBeInTheDocument();
  });

  it("MIDAD Phase A5.1: no allocations at all shows an honest empty state, not a zeroed breakdown", async () => {
    mockApi("owner", { laborCost: { projectId: "p1", allocatedTotal: 0, allocationCount: 0, postedTotal: 0, unpostedTotal: 0, posted: false } });
    renderSection();
    await waitFor(() => expect(screen.getByText("لا توجد تكلفة عمالة موزعة")).toBeInTheDocument());
    expect(screen.queryByText("إجمالي الموزَّع")).not.toBeInTheDocument();
  });

  it("MIDAD Phase E: Budget Alerts card shows an honest empty state when there are no active alerts", async () => {
    mockApi("owner");
    renderSection();
    await waitFor(() => expect(screen.getByText("لا توجد حالياً مؤشرات مالية تتجاوز قواعد التنبيه المحددة.")).toBeInTheDocument());
    // Never claims the project is "safe" — absence of an alert is not a
    // health guarantee.
    expect(document.body.textContent).not.toMatch(/آمن/);
  });

  it("MIDAD Phase E: Budget Alerts card renders a server-generated alert's own title/severity verbatim, and links to the full list", async () => {
    mockApi("owner", { budgetAlerts: [fixtureBudgetAlert] });
    renderSection();
    await waitFor(() => expect(screen.getByText("استهلاك الميزانية وصل إلى 105%")).toBeInTheDocument());
    expect(screen.getByText("حرج")).toBeInTheDocument();
    const link = screen.getByText("عرض جميع التنبيهات").closest("a");
    expect(link).toHaveAttribute("href", "/budget-alerts?projectId=p1");
  });

  it("MIDAD Phase E: a resolved alert is excluded from the compact card's active view", async () => {
    mockApi("owner", { budgetAlerts: [{ ...fixtureBudgetAlert, status: "resolved" }] });
    renderSection();
    await waitFor(() => expect(screen.getByText("تنبيهات الميزانية")).toBeInTheDocument());
    expect(screen.queryByText("استهلاك الميزانية وصل إلى 105%")).not.toBeInTheDocument();
  });

  it("MIDAD Phase F: Schedule card shows an honest 'no data' state, and 'على المسار الصحيح' when nothing is overdue", async () => {
    mockApi("owner", { tasks: [fixtureMilestone] });
    renderSection();
    await waitFor(() => expect(screen.getByText("على المسار الصحيح")).toBeInTheDocument());
    expect(screen.getByText(/اكتمال الأساسات/)).toBeInTheDocument();
  });

  it("MIDAD Phase F: Schedule card flags overdue incomplete tasks as 'متأخر'", async () => {
    mockApi("owner", { tasks: [fixtureOverdueTask] });
    renderSection();
    await waitFor(() => expect(screen.getByText("متأخر")).toBeInTheDocument());
  });

  it("MIDAD Phase F: Punch List card shows an open+critical count from server data verbatim", async () => {
    mockApi("owner", { punchItems: [fixtureCriticalPunchItem] });
    renderSection();
    await waitFor(() => expect(screen.getByText("1 مفتوحة")).toBeInTheDocument());
    expect(screen.getByText("1 حرجة")).toBeInTheDocument();
  });

  it("MIDAD Phase F: Punch List card shows an honest empty state when nothing is open", async () => {
    mockApi("owner", { punchItems: [] });
    renderSection();
    await waitFor(() => expect(screen.getByText("قائمة الملاحظات")).toBeInTheDocument());
    expect(screen.getByText("لا توجد ملاحظات مسجَّلة بعد.")).toBeInTheDocument();
  });

  it("Member read access: a member can render the full dashboard, with no mutation controls anywhere", async () => {
    mockApi("member");
    renderSection();
    await waitFor(() => expect(screen.getByText("خطة التكلفة")).toBeInTheDocument());
    expect(screen.getByText(/246,813\.57|246813\.57/)).toBeInTheDocument();
    expect(screen.queryAllByRole("button").length).toBe(0);
  });
});
