import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { AuthProvider } from "../../auth/AuthContext";
import { I18nProvider } from "../../i18n/I18nProvider";
import { CashFlowSection } from "./CashFlowSection";
import type { CashFlowResult } from "../../api/types";

vi.mock("../context", () => ({
  useProjectContext: () => ({ project: null, projectId: "p1" }),
}));

vi.mock("../../api/client", async () => {
  const actual = await vi.importActual<typeof import("../../api/client")>("../../api/client");
  return { ...actual, getToken: () => "fake-token", apiFetch: vi.fn() };
});

import { apiFetch } from "../../api/client";

// Every projected/undated figure below is deliberately NOT what a naive
// client-side formula would produce from the others (e.g. net is NOT
// receivables + certifiedExpectedCollection - commitments, which would be
// 222.22 — it's set to 999.99 instead) — set on purpose, so asserting the
// UI shows exactly these numbers proves they come verbatim from the
// backend's own calculation, never a client-side re-derivation.
const fixtureCashFlow: CashFlowResult = {
  projectId: "p1",
  asOfDate: "2026-08-20",
  currency: "SAR",
  excludedForeignCurrencyCommitmentIds: [],
  historical: { cashReceived: 111.11, incurredCost: 222.22 },
  projected: { receivables: 333.33, certifiedExpectedCollection: 444.44, commitments: 555.55, net: 999.99 },
  undated: {
    etc: 777.77,
    retentionToBeReleased: 88.88,
    advance: { supported: false, reason: "Advance payment/recovery is not operationalized in the current financial model." },
  },
  assumptions: {
    forecastMethod: "commitment_aware",
    certifiedValueBasis: "netCertified (gross certified value minus withheld retention)",
    commitmentExpenseReconciliation: "not modeled — no expenses.commitmentId relationship exists",
    ipcInvoiceReconciliation: "not modeled — no relationship exists between ipcs and invoices",
  },
};

const fixtureZeroCashFlow: CashFlowResult = {
  ...fixtureCashFlow,
  historical: { cashReceived: 0, incurredCost: 0 },
  projected: { receivables: 0, certifiedExpectedCollection: 0, commitments: 0, net: 0 },
  undated: { ...fixtureCashFlow.undated, etc: 0, retentionToBeReleased: 0 },
};

const fixtureCashFlowWithExclusions: CashFlowResult = {
  ...fixtureCashFlow,
  excludedForeignCurrencyCommitmentIds: ["cm-1"],
};

function mockApi(role: "owner" | "member", result: CashFlowResult = fixtureCashFlow) {
  vi.mocked(apiFetch).mockImplementation((path: unknown) => {
    const p = String(path);
    if (p === "/auth/me") {
      return Promise.resolve({
        user: { id: "u1", name: "Test", email: "t@test.com", role },
        company: { id: "co1", name: "Test Co" },
      });
    }
    if (p.startsWith("/projects/p1/cash-flow")) {
      return Promise.resolve(result);
    }
    return Promise.reject(new Error(`unexpected apiFetch call in test: ${p}`));
  });
}

function renderSection() {
  return render(
    <I18nProvider>
      <AuthProvider>
        <CashFlowSection />
      </AuthProvider>
    </I18nProvider>,
  );
}

describe("<CashFlowSection/>", () => {
  it("renders successfully with the as-of date clearly shown", async () => {
    mockApi("owner");
    renderSection();
    await waitFor(() => expect(screen.getByText(/999\.99/)).toBeInTheDocument());
    expect(screen.getByText(/بتاريخ/)).toBeInTheDocument();
  });

  it("shows the backend's authoritative figures verbatim, never a client-side re-derivation", async () => {
    mockApi("owner");
    renderSection();
    await waitFor(() => expect(screen.getByText(/999\.99/)).toBeInTheDocument());
    expect(screen.getAllByText(/111\.11/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/222\.22/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/333\.33/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/444\.44/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/555\.55/).length).toBeGreaterThan(0);
    // net = 999.99, not receivables + certifiedExpectedCollection -
    // commitments (which would naively be 222.22) — its mere presence
    // disproves any client-side recomputation of net.
    expect(screen.getAllByText(/999\.99/).length).toBeGreaterThan(0);
  });

  it("shows the Forecast-derived undated ETC exactly as the API returned it", async () => {
    mockApi("owner");
    renderSection();
    await waitFor(() => expect(screen.getByText(/999\.99/)).toBeInTheDocument());
    expect(screen.getAllByText(/777\.77/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/88\.88/).length).toBeGreaterThan(0);
  });

  it("marks advance as explicitly unsupported, with the backend's own reason text", async () => {
    mockApi("owner");
    renderSection();
    await waitFor(() => expect(screen.getByText(/999\.99/)).toBeInTheDocument());
    expect(screen.getByText("غير مدعومة")).toBeInTheDocument();
    expect(screen.getByText(fixtureCashFlow.undated.advance.reason)).toBeInTheDocument();
  });

  it("renders a legitimate all-zero response as populated, never as a fabricated empty state", async () => {
    mockApi("owner", fixtureZeroCashFlow);
    renderSection();
    await waitFor(() => expect(screen.getByText(/بتاريخ/)).toBeInTheDocument());
    // No empty state exists for this domain — the endpoint always returns
    // a full computed object; a zero value is a real value, not "no data".
    expect(screen.getAllByText(/0\.00/).length).toBeGreaterThan(0);
  });

  it("shows the backend's foreign-currency exclusion notice when supplied", async () => {
    mockApi("owner", fixtureCashFlowWithExclusions);
    renderSection();
    await waitFor(() => expect(screen.getByText(/تم استبعاد 1/)).toBeInTheDocument());
  });

  it("shows no exclusion notice when the list is empty", async () => {
    mockApi("owner");
    renderSection();
    await waitFor(() => expect(screen.getByText(/999\.99/)).toBeInTheDocument());
    expect(screen.queryByText(/تم استبعاد/)).not.toBeInTheDocument();
  });

  it("re-queries the backend for a chosen as-of date via the read-only date control", async () => {
    mockApi("owner");
    renderSection();
    await waitFor(() => expect(screen.getByText(/999\.99/)).toBeInTheDocument());

    const laterResult: CashFlowResult = { ...fixtureCashFlow, asOfDate: "2026-01-01", projected: { ...fixtureCashFlow.projected, net: 12.34 } };
    vi.mocked(apiFetch).mockImplementation((path: unknown) => {
      const p = String(path);
      if (p === "/auth/me") {
        return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "co1", name: "Test Co" } });
      }
      if (p === "/projects/p1/cash-flow?asOfDate=2026-01-01") return Promise.resolve(laterResult);
      return Promise.reject(new Error(`unexpected apiFetch call in test: ${p}`));
    });

    fireEvent.change(document.querySelector('input[type="date"]')!, { target: { value: "2026-01-01" } });
    fireEvent.click(screen.getByRole("button", { name: "تحديث" }));
    await waitFor(() => expect(screen.getByText(/12\.34/)).toBeInTheDocument());
  });

  it("shows an honest, retryable error state on API failure, not a fabricated result", async () => {
    vi.mocked(apiFetch).mockImplementation((path: unknown) => {
      const p = String(path);
      if (p === "/auth/me") {
        return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "co1", name: "Test Co" } });
      }
      if (p.startsWith("/projects/p1/cash-flow")) return Promise.reject(new Error("تعذّر الاتصال بالخادم"));
      return Promise.reject(new Error(`unexpected apiFetch call in test: ${p}`));
    });
    renderSection();
    await waitFor(() => expect(screen.getByText("تعذّر الاتصال بالخادم")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "إعادة المحاولة" })).toBeInTheDocument();
  });

  it("has no gated action — a member sees exactly the same read-only controls as an owner", async () => {
    mockApi("member");
    renderSection();
    await waitFor(() => expect(screen.getByText(/999\.99/)).toBeInTheDocument());
    // The only interactive control on this screen is the read-only as-of
    // date re-query — no create/mutate action exists for either role,
    // matching cashflow.ts's complete absence of a requirePermission gate.
    const buttons = screen.getAllByRole("button").map((b) => b.textContent);
    expect(buttons).toEqual(["تحديث"]);
  });
});
