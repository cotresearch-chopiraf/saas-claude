import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { AuthProvider } from "../../auth/AuthContext";
import { I18nProvider } from "../../i18n/I18nProvider";
import { ForecastSection } from "./ForecastSection";
import type { ForecastCalculation, ForecastResult, ForecastSnapshot } from "../../api/types";

vi.mock("../context", () => ({
  useProjectContext: () => ({ project: null, projectId: "p1" }),
}));

vi.mock("../../api/client", async () => {
  const actual = await vi.importActual<typeof import("../../api/client")>("../../api/client");
  return { ...actual, getToken: () => "fake-token", apiFetch: vi.fn() };
});

import { apiFetch } from "../../api/client";

// etc/eac/variance below are deliberately NOT costPlan - actualCost,
// actualCost + etc, or costPlan - eac — set to arbitrary, formula-breaking
// values on purpose, so asserting the UI shows exactly these numbers
// proves they come verbatim from the backend's own calculation, never a
// client-side re-derivation of ETC/EAC/variance.
const fixtureMethodA: ForecastCalculation = {
  method: "cost_to_complete",
  costPlan: 1000,
  actualCost: 300,
  committedCost: 200,
  certifiedValue: 150,
  remainingCost: 700,
  etc: 777.77,
  eac: 888.88,
  variance: 111.12,
  variancePercent: 11.11,
};

const fixtureMethodB: ForecastCalculation = {
  method: "commitment_aware",
  costPlan: 1000,
  actualCost: 300,
  committedCost: 200,
  certifiedValue: 150,
  remainingCost: 700,
  etc: 555.55,
  eac: 666.66,
  variance: 333.34,
  variancePercent: 33.33,
};

const fixtureForecast: ForecastResult = {
  projectId: "p1",
  asOfDate: "2026-08-20",
  currency: "SAR",
  excludedForeignCurrencyCommitmentIds: [],
  methods: { cost_to_complete: fixtureMethodA, commitment_aware: fixtureMethodB },
};

const fixtureForecastWithExclusions: ForecastResult = {
  ...fixtureForecast,
  excludedForeignCurrencyCommitmentIds: ["cm-1", "cm-2"],
};

const fixtureForecastZeroBudget: ForecastResult = {
  ...fixtureForecast,
  methods: {
    cost_to_complete: { ...fixtureMethodA, costPlan: 0, variancePercent: null },
    commitment_aware: { ...fixtureMethodB, costPlan: 0, variancePercent: null },
  },
};

const fixtureSnapshot: ForecastSnapshot = {
  id: "snap-1",
  companyId: "co1",
  projectId: "p1",
  asOfDate: "2026-08-15",
  method: "commitment_aware",
  currency: "SAR",
  costPlan: "1000.00",
  actualCost: "300.00",
  committedCost: "200.00",
  certifiedValue: "150.00",
  remainingCost: "700.00",
  etc: "555.55",
  eac: "666.66",
  variance: "333.34",
  variancePercent: "33.33",
  assumptions: { excludedForeignCurrencyCommitmentIds: [] },
  notes: "لقطة تجريبية",
  createdBy: "u1",
  createdAt: "2026-08-15T00:00:00.000Z",
};

function mockApi(
  role: "owner" | "member",
  opts: { forecast?: ForecastResult; snapshots?: ForecastSnapshot[] } = {},
) {
  const forecast = opts.forecast ?? fixtureForecast;
  let snapshots = opts.snapshots ?? [];
  vi.mocked(apiFetch).mockImplementation((path: unknown, reqOpts?: RequestInit) => {
    const p = String(path);
    const method = reqOpts?.method ?? "GET";
    if (p === "/auth/me") {
      return Promise.resolve({
        user: { id: "u1", name: "Test", email: "t@test.com", role },
        company: { id: "co1", name: "Test Co" },
      });
    }
    if (p === "/projects/p1/forecast" && method === "GET") {
      return Promise.resolve(forecast);
    }
    if (p === "/projects/p1/forecast/snapshots" && method === "GET") {
      return Promise.resolve(snapshots);
    }
    if (p === "/projects/p1/forecast/snapshots" && method === "POST") {
      const created = { ...fixtureSnapshot, id: "snap-new" };
      snapshots = [created, ...snapshots];
      return Promise.resolve(created);
    }
    return Promise.reject(new Error(`unexpected apiFetch call in test: ${p} ${method}`));
  });
}

function renderSection() {
  return render(
    <I18nProvider>
      <AuthProvider>
        <ForecastSection />
      </AuthProvider>
    </I18nProvider>,
  );
}

describe("<ForecastSection/>", () => {
  it("renders both forecast methods side by side", async () => {
    mockApi("owner");
    renderSection();
    await waitFor(() => expect(screen.getByText("الطريقة المحافظة (تجاهل الالتزامات)")).toBeInTheDocument());
    expect(screen.getByText("الطريقة الواعية بالالتزامات")).toBeInTheDocument();
  });

  it("shows the backend's ETC/EAC verbatim for both methods, never a client recomputation", async () => {
    mockApi("owner");
    renderSection();
    await waitFor(() => expect(screen.getByText("الطريقة المحافظة (تجاهل الالتزامات)")).toBeInTheDocument());
    // Method A: etc=777.77, eac=888.88 (not costPlan-actualCost=700, not actualCost+etc-here=1077.77).
    expect(screen.getByText(/777\.77/)).toBeInTheDocument();
    expect(screen.getByText(/888\.88/)).toBeInTheDocument();
    // Method B: etc=555.55, eac=666.66.
    expect(screen.getByText(/555\.55/)).toBeInTheDocument();
    expect(screen.getByText(/666\.66/)).toBeInTheDocument();
    // A naive recompute (e.g. remainingCost=700.00 mistaken for etc) must not appear as an ETC/EAC value.
    expect(screen.queryByText(/^700\.00/)).not.toBeInTheDocument();
  });

  it("shows the shared method-independent inputs (Cost Plan, Actual Cost, Committed, Certified)", async () => {
    mockApi("owner");
    renderSection();
    await waitFor(() => expect(screen.getByText("الطريقة المحافظة (تجاهل الالتزامات)")).toBeInTheDocument());
    expect(screen.getAllByText(/1,000\.00|1000\.00/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/300\.00/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/200\.00/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/150\.00/).length).toBeGreaterThan(0);
  });

  it("renders a null variancePercent as an explicit dash, never 0%", async () => {
    mockApi("owner", { forecast: fixtureForecastZeroBudget });
    renderSection();
    await waitFor(() => expect(screen.getByText("الطريقة المحافظة (تجاهل الالتزامات)")).toBeInTheDocument());
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("shows the backend's foreign-currency exclusion notice when supplied", async () => {
    mockApi("owner", { forecast: fixtureForecastWithExclusions });
    renderSection();
    await waitFor(() => expect(screen.getByText(/تم استبعاد 2/)).toBeInTheDocument());
  });

  it("does not show an exclusion notice when the list is empty", async () => {
    mockApi("owner");
    renderSection();
    await waitFor(() => expect(screen.getByText("الطريقة المحافظة (تجاهل الالتزامات)")).toBeInTheDocument());
    expect(screen.queryByText(/تم استبعاد/)).not.toBeInTheDocument();
  });

  it("shows an honest empty state when there are no snapshots yet", async () => {
    mockApi("owner");
    renderSection();
    await waitFor(() => expect(screen.getByText("لا توجد لقطات توقعات محفوظة بعد")).toBeInTheDocument());
  });

  it("shows snapshot history from backend data", async () => {
    mockApi("owner", { snapshots: [fixtureSnapshot] });
    renderSection();
    await waitFor(() => expect(screen.getByText("لقطة تجريبية")).toBeInTheDocument());
    expect(screen.getAllByText(/666\.66/).length).toBeGreaterThan(0);
  });

  it("a member does NOT see the snapshot-creation control", async () => {
    mockApi("member");
    renderSection();
    await waitFor(() => expect(screen.getByText("الطريقة المحافظة (تجاهل الالتزامات)")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "+ إنشاء لقطة توقعات" })).not.toBeInTheDocument();
  });

  it("a member CAN read the live forecast and snapshot history", async () => {
    mockApi("member", { snapshots: [fixtureSnapshot] });
    renderSection();
    await waitFor(() => expect(screen.getByText("الطريقة المحافظة (تجاهل الالتزامات)")).toBeInTheDocument());
    expect(screen.getByText("لقطة تجريبية")).toBeInTheDocument();
  });

  it("an owner sees the snapshot-creation control and can open the form", async () => {
    mockApi("owner");
    renderSection();
    await waitFor(() => expect(screen.getByRole("button", { name: "+ إنشاء لقطة توقعات" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "+ إنشاء لقطة توقعات" }));
    expect(screen.getByRole("button", { name: "إنشاء اللقطة" })).toBeInTheDocument();
  });

  it("creating a snapshot refreshes the history and prevents duplicate submission while in flight", async () => {
    mockApi("owner");
    renderSection();
    await waitFor(() => expect(screen.getByText("لا توجد لقطات توقعات محفوظة بعد")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "+ إنشاء لقطة توقعات" }));
    const submitButton = screen.getByRole("button", { name: "إنشاء اللقطة" });
    fireEvent.click(submitButton);

    // Mutation-in-progress: the button's own accessible label changes to a
    // busy state, so a second immediate click can't double-submit.
    expect(screen.getByRole("button", { name: "جارٍ الحفظ..." })).toBeDisabled();

    await waitFor(() => expect(screen.queryByText("لا توجد لقطات توقعات محفوظة بعد")).not.toBeInTheDocument());
    expect(screen.getByText("لقطة تجريبية")).toBeInTheDocument();
  });

  it("shows an honest, retryable error state on API failure, not a fabricated empty forecast", async () => {
    vi.mocked(apiFetch).mockImplementation((path: unknown) => {
      const p = String(path);
      if (p === "/auth/me") {
        return Promise.resolve({
          user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" },
          company: { id: "co1", name: "Test Co" },
        });
      }
      if (p === "/projects/p1/forecast") return Promise.reject(new Error("تعذّر الاتصال بالخادم"));
      return Promise.reject(new Error(`unexpected apiFetch call in test: ${p}`));
    });
    renderSection();
    await waitFor(() => expect(screen.getByText("تعذّر الاتصال بالخادم")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "إعادة المحاولة" })).toBeInTheDocument();
  });
});
