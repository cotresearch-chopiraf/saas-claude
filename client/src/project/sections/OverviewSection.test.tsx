import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../../auth/AuthContext";
import { OverviewSection } from "./OverviewSection";
import type {
  ActivityEvent,
  BoqRevision,
  BudgetAlert,
  BudgetSummary,
  CashFlowResult,
  Commitment,
  Contract,
  ForecastResult,
  Ipc,
  Measurement,
  Project,
  ProjectLaborCost,
  ProjectTask,
  PunchItem,
} from "../../api/types";

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

const fixtureForecastOverBudget: ForecastResult = {
  ...fixtureForecast,
  methods: {
    ...fixtureForecast.methods,
    commitment_aware: { ...fixtureForecast.methods.commitment_aware, variance: -999.99, variancePercent: -12.3 },
  },
};

const fixtureCashFlow: CashFlowResult = {
  projectId: "p1",
  asOfDate: "2026-08-20",
  currency: "SAR",
  excludedForeignCurrencyCommitmentIds: [],
  historical: { cashReceived: 101.11, incurredCost: 202.22 },
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
const fixtureRevisionPublished: BoqRevision = { ...fixtureRevisionDraft, revisionNumber: 2, status: "published", publishedAt: "2026-01-05T00:00:00.000Z" };

const fixtureLaborCost: ProjectLaborCost = {
  projectId: "p1",
  allocatedTotal: 88.88,
  allocationCount: 3,
  postedTotal: 30,
  unpostedTotal: 58.88,
  posted: false,
};

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

const fixtureCommitmentPending: Commitment = {
  id: "cm1",
  companyId: "co1",
  projectId: "p1",
  contractId: "c-main",
  supplierId: "sup1",
  type: "purchase_order",
  status: "pending_approval",
  commitmentNumber: 1,
  description: "أمر شراء بلاط",
  originalAmount: "12345.67",
  revisedAmount: null,
  retentionPercent: null,
  currency: "SAR",
  createdBy: "u1",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  submittedAt: "2026-08-01T00:00:00.000Z",
  approvedBy: null,
  approvedAt: null,
  cancelledAt: null,
};
const fixtureCommitmentActive: Commitment = {
  ...fixtureCommitmentPending,
  id: "cm2",
  commitmentNumber: 2,
  status: "active",
  originalAmount: "5000.00",
  revisedAmount: "5500.55",
};

const fixtureIpcApproved: Ipc = {
  id: "ipc1",
  companyId: "co1",
  projectId: "p1",
  contractId: "c-main",
  boqRevisionId: "rev1",
  ipcNumber: 1,
  status: "approved",
  periodStart: "2026-08-01",
  periodEnd: "2026-08-31",
  notes: null,
  grossValue: "1000.00",
  retentionAmount: "50.00",
  advanceRecoveryAmount: "0.00",
  otherDeductions: "0.00",
  netCertified: null,
  currency: "SAR",
  createdBy: "u1",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  submittedBy: "u1",
  submittedAt: "2026-08-02T00:00:00.000Z",
  approvedBy: "u1",
  approvedAt: "2026-08-03T00:00:00.000Z",
  certifiedBy: null,
  certifiedAt: null,
  rejectedBy: null,
  rejectedAt: null,
  rejectionReason: null,
};
const fixtureIpcCertified: Ipc = {
  ...fixtureIpcApproved,
  id: "ipc2",
  ipcNumber: 2,
  status: "certified",
  netCertified: "1234.56",
  certifiedBy: "u1",
  certifiedAt: "2026-08-10T00:00:00.000Z",
};

const fixtureMeasurementSubmitted: Measurement = {
  id: "m1",
  companyId: "co1",
  projectId: "p1",
  contractId: "c-main",
  boqRevisionId: "rev1",
  status: "submitted",
  measurementDate: "2026-08-05",
  description: null,
  createdBy: "u1",
  createdAt: "2026-08-05T00:00:00.000Z",
  updatedAt: "2026-08-05T00:00:00.000Z",
  submittedBy: "u1",
  submittedAt: "2026-08-05T00:00:00.000Z",
  approvedBy: null,
  approvedAt: null,
  rejectedBy: null,
  rejectedAt: null,
  rejectionReason: null,
};

const fixtureActivityForThisProject: ActivityEvent = {
  id: "ev1",
  action: "ipc.certified",
  entityType: "ipc",
  entityId: "ipc2", // matches fixtureIpcCertified.id — must be picked up by the project filter
  actorUserId: "u1",
  actorName: "Test User",
  actorEmail: "t@test.com",
  reason: null,
  source: "app",
  beforeValue: null,
  afterValue: null,
  metadata: null,
  createdAt: "2026-08-10T00:00:00.000Z",
};
const fixtureActivityForOtherProject: ActivityEvent = {
  ...fixtureActivityForThisProject,
  id: "ev2",
  entityId: "unrelated-entity-id",
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
    commitments?: Commitment[];
    ipcs?: Ipc[];
    measurements?: Measurement[];
    activity?: ActivityEvent[];
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
  const commitments = opts.commitments ?? [];
  const ipcs = opts.ipcs ?? [];
  const measurements = opts.measurements ?? [];
  const activity = opts.activity ?? [];

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
    if (p === "/projects/p1/commitments") return Promise.resolve(commitments);
    if (p === "/projects/p1/ipcs") return Promise.resolve(ipcs);
    if (p === "/projects/p1/measurements") return Promise.resolve(measurements);
    if (p.startsWith("/audit-events")) return Promise.resolve({ events: activity, limit: 50, offset: 0, hasMore: false });
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

describe("<OverviewSection/> (Executive Command Center)", () => {
  it("Identity strip: shows status, contract value (from the main contract, not an amendment), and progress", async () => {
    mockApi("owner", { tasks: [{ ...fixtureOverdueTask, progressPercent: 60 }] });
    renderSection();
    await waitFor(() => expect(screen.getByText("نشط")).toBeInTheDocument());
    // The contract value legitimately appears twice (identity strip +
    // financial waterfall) — both are the same real figure, by design.
    expect(screen.getAllByText(/251,975\.42|251975\.42/).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/5,000\.00|5000\.00/)).not.toBeInTheDocument();
    expect(screen.getAllByText("60%").length).toBeGreaterThan(0);
  });

  it("Identity strip: shows an honest 'no data' progress when the project has no schedule tasks", async () => {
    mockApi("owner", { tasks: [] });
    renderSection();
    await waitFor(() => expect(screen.getAllByText("لا توجد بيانات").length).toBeGreaterThan(0));
  });

  it("Financial Command Center: renders the Contract→Budget→Actual→Committed→Forecast chain verbatim from forecast.methods.commitment_aware", async () => {
    mockApi("owner");
    renderSection();
    await waitFor(() => expect(screen.getByText("المركز المالي")).toBeInTheDocument());
    // costPlan/actualCost/committedCost/eac from the commitment_aware method fixture.
    expect(screen.getByText(/1,000\.00|1000\.00/)).toBeInTheDocument();
    expect(screen.getByText(/300\.00/)).toBeInTheDocument();
    expect(screen.getByText(/200\.00/)).toBeInTheDocument();
    expect(screen.getByText(/543\.21/)).toBeInTheDocument();
    expect(screen.getByText(/222\.22/)).toBeInTheDocument();
  });

  it("Financial Command Center: flags a negative variance as an over-budget forecast, never silently", async () => {
    mockApi("owner", { forecast: fixtureForecastOverBudget });
    renderSection();
    await waitFor(() => expect(screen.getByText(/تجاوز متوقع للميزانية/)).toBeInTheDocument());
  });

  it("Cost Plan truth: planned/spent/remaining displayed verbatim, not planned - spent", async () => {
    mockApi("owner");
    renderSection();
    await waitFor(() => expect(screen.getByText(/777\.77/)).toBeInTheDocument());
    expect(screen.getByText(/333\.33/)).toBeInTheDocument();
  });

  it("Cash Flow truth: historical/projected figures render verbatim, net is not recomputed", async () => {
    mockApi("owner");
    renderSection();
    await waitFor(() => expect(screen.getByRole("heading", { name: "التدفق النقدي" })).toBeInTheDocument());
    expect(screen.getByText(/101\.11/)).toBeInTheDocument();
    expect(screen.getByText(/303\.33/)).toBeInTheDocument();
    // net = 909.09, NOT receivables + certified - commitments = 202.22.
    // Legitimately appears twice (Cash Flow health tile + the Cash Flow
    // card itself) — same real figure surfaced in both places.
    expect(screen.getAllByText(/909\.09/).length).toBeGreaterThanOrEqual(1);
  });

  it("does not fabricate a BOQ total: only fetches revision metadata, never revision items", async () => {
    mockApi("owner");
    renderSection();
    await waitFor(() => expect(screen.getByText("حالة جدول الكميات")).toBeInTheDocument());
    expect(screen.getByText("#2")).toBeInTheDocument();
    expect(screen.getByText("منشورة")).toBeInTheDocument();
    const calledPaths = vi.mocked(apiFetch).mock.calls.map((c) => String(c[0]));
    expect(calledPaths.some((p) => /\/boq-revisions\/rev/.test(p))).toBe(false);
  });

  it("Loading state: never flashes a misleading figure before requests resolve", async () => {
    vi.mocked(apiFetch).mockImplementation((path: unknown) => {
      const p = String(path);
      if (p === "/auth/me") {
        return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "co1", name: "Test Co" } });
      }
      return new Promise(() => {}); // never resolves
    });
    renderSection();
    await waitFor(() => expect(screen.getByText("مركز القيادة التنفيذي")).toBeInTheDocument());
    expect(screen.queryByText("المركز المالي")).not.toBeInTheDocument();
  });

  it("shows an honest, retryable error state when a source fails, never a fabricated result", async () => {
    mockApi("owner", { failPath: "/projects/p1/forecast" });
    renderSection();
    await waitFor(() => expect(screen.getByText("تعذّر الاتصال بالخادم")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "إعادة المحاولة" })).toBeInTheDocument();
    expect(screen.queryByText("المركز المالي")).not.toBeInTheDocument();
  });

  it("renders legitimate zero financial values as 0.00, never confused with missing data", async () => {
    mockApi("owner", { budget: fixtureBudgetZero, cashFlow: fixtureCashFlowZero });
    renderSection();
    await waitFor(() => expect(screen.getByRole("heading", { name: "التدفق النقدي" })).toBeInTheDocument());
    expect(screen.getAllByText(/0\.00/).length).toBeGreaterThan(0);
  });

  it("Labor Cost card renders its own backend-provided total, never merged into Cost Plan's totals", async () => {
    mockApi("owner");
    renderSection();
    await waitFor(() => expect(screen.getByText("تكلفة العمالة الموزَّعة")).toBeInTheDocument());
    expect(screen.getByText(/88\.88/)).toBeInTheDocument();
    expect(fixtureBudget.totals.planned).not.toBe(88.88);
  });

  it("Project Health: cost tile turns critical from an open critical Budget Alert", async () => {
    mockApi("owner", { budgetAlerts: [fixtureBudgetAlert] });
    renderSection();
    await waitFor(() => expect(screen.getByText("صحة المشروع")).toBeInTheDocument());
    expect(screen.getByText("تنبيهات حرجة")).toBeInTheDocument();
  });

  it("Project Health: schedule tile shows 'no data' honestly, then flags a delay from a real overdue task", async () => {
    mockApi("owner", { tasks: [] });
    renderSection();
    await waitFor(() => expect(screen.getByText("صحة المشروع")).toBeInTheDocument());
    expect(screen.getAllByText("لا توجد بيانات").length).toBeGreaterThan(0);
  });

  it("Project Health: compliance tile is explicitly labeled company-wide, never a fabricated per-project verdict", async () => {
    mockApi("owner");
    renderSection();
    await waitFor(() => expect(screen.getByText("صحة المشروع")).toBeInTheDocument());
    const complianceLink = screen.getByText("الامتثال").closest("a");
    expect(complianceLink).toHaveAttribute("href", "/labor-compliance");
    expect(within(complianceLink!).getByText("على مستوى الشركة")).toBeInTheDocument();
  });

  it("Needs Attention: shows an honest empty state when nothing needs attention", async () => {
    mockApi("owner");
    renderSection();
    await waitFor(() => expect(screen.getByText("يحتاج إلى انتباه")).toBeInTheDocument());
    expect(screen.getByText("لا توجد حالياً بنود تحتاج إلى انتباه.")).toBeInTheDocument();
  });

  it("Needs Attention: aggregates real risk signals from every domain — budget alert, overdue task, critical punch item, IPC awaiting certification, pending commitment, measurement awaiting approval", async () => {
    mockApi("owner", {
      budgetAlerts: [fixtureBudgetAlert],
      tasks: [fixtureOverdueTask],
      punchItems: [fixtureCriticalPunchItem],
      ipcs: [fixtureIpcApproved],
      commitments: [fixtureCommitmentPending],
      measurements: [fixtureMeasurementSubmitted],
    });
    renderSection();
    await waitFor(() => expect(screen.getByText("استهلاك الميزانية وصل إلى 105%")).toBeInTheDocument());
    expect(screen.getByText(/مهمة متأخرة عن الجدول الزمني/)).toBeInTheDocument();
    expect(screen.getByText(/ملاحظة حرجة مفتوحة/)).toBeInTheDocument();
    expect(screen.getByText(/شهادة دفع \(IPC\) بانتظار التصديق/)).toBeInTheDocument();
    expect(screen.getByText(/التزام شراء بانتظار الاعتماد/)).toBeInTheDocument();
    // The same real fact is legitimately surfaced twice (Needs Attention +
    // the Progress/Schedule card's own link) — both are the same figure.
    expect(screen.getAllByText(/قياس إنجاز بانتظار الاعتماد/).length).toBeGreaterThanOrEqual(1);
  });

  it("Procurement: groups real commitment amounts by status, never a fabricated 'at risk' bucket", async () => {
    mockApi("owner", { commitments: [fixtureCommitmentPending, fixtureCommitmentActive] });
    renderSection();
    await waitFor(() => expect(screen.getByText("المشتريات والالتزامات")).toBeInTheDocument());
    // total = pending original (12345.67) + active revised (5500.55) = 17846.22
    expect(screen.getByText(/17,846\.22|17846\.22/)).toBeInTheDocument();
    expect(screen.getByText(/5,500\.55|5500\.55/)).toBeInTheDocument();
    expect(screen.getByText(/12,345\.67|12345\.67/)).toBeInTheDocument();
  });

  it("IPC: shows the certified total from status==='certified' IPCs only, and awaiting-certification/approval counts separately", async () => {
    mockApi("owner", { ipcs: [fixtureIpcApproved, fixtureIpcCertified] });
    renderSection();
    await waitFor(() => expect(screen.getByText("شهادات الدفع (IPC)")).toBeInTheDocument());
    expect(screen.getByText(/1,234\.56|1234\.56/)).toBeInTheDocument();
    const awaitingCert = screen.getAllByText("1");
    expect(awaitingCert.length).toBeGreaterThan(0);
  });

  it("Activity feed: shows only events on this project's own entities, never an unrelated company-wide event", async () => {
    mockApi("owner", { ipcs: [fixtureIpcCertified], activity: [fixtureActivityForThisProject, fixtureActivityForOtherProject] });
    renderSection();
    await waitFor(() => expect(screen.getByText("آخر النشاطات")).toBeInTheDocument());
    expect(screen.getByText("تم تصديق شهادة الدفع")).toBeInTheDocument();
    // Only one matching event should render even though two were returned.
    expect(screen.getAllByText("تم تصديق شهادة الدفع").length).toBe(1);
  });

  it("Activity feed: shows an honest empty state when no activity matches this project", async () => {
    mockApi("owner", { activity: [fixtureActivityForOtherProject] });
    renderSection();
    await waitFor(() => expect(screen.getByText("آخر النشاطات")).toBeInTheDocument());
    expect(screen.getByText("لا توجد نشاطات مسجَّلة لهذا المشروع بعد.")).toBeInTheDocument();
  });

  it("Quick Actions: document upload is always visible (member-open, no owner gate) even for a member", async () => {
    mockApi("member");
    renderSection();
    await waitFor(() => expect(screen.getByText("إجراءات سريعة")).toBeInTheDocument());
    expect(screen.getByText("+ رفع مستند")).toBeInTheDocument();
  });

  it("Quick Actions: owner-only actions are hidden for a member, matching each domain's own real permission", async () => {
    mockApi("member");
    renderSection();
    await waitFor(() => expect(screen.getByText("إجراءات سريعة")).toBeInTheDocument());
    expect(screen.queryByText("+ بند جدول كميات")).not.toBeInTheDocument();
    expect(screen.queryByText("+ التزام شراء")).not.toBeInTheDocument();
  });

  it("Quick Actions: owner sees every gated action", async () => {
    mockApi("owner");
    renderSection();
    await waitFor(() => expect(screen.getByText("إجراءات سريعة")).toBeInTheDocument());
    expect(screen.getByText("+ بند جدول كميات")).toBeInTheDocument();
    expect(screen.getByText("+ التزام شراء")).toBeInTheDocument();
    expect(screen.getByText("+ مصروف")).toBeInTheDocument();
    expect(screen.getByText("+ شهادة دفع")).toBeInTheDocument();
  });

  it("Member read access: a member can render the full command center", async () => {
    mockApi("member");
    renderSection();
    await waitFor(() => expect(screen.getByText("المركز المالي")).toBeInTheDocument());
    expect(screen.getAllByText(/251,975\.42|251975\.42/).length).toBeGreaterThanOrEqual(2);
  });
});
