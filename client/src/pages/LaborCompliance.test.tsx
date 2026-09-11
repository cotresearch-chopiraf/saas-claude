import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../auth/AuthContext";
import { I18nProvider } from "../i18n/I18nProvider";
import { LaborCompliance } from "./LaborCompliance";
import type { ComplianceDashboard, CompliancePeriod, NitaqatComplianceRecord, GosiComplianceRecord, ComplianceException } from "../api/types";

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return { ...actual, getToken: () => "fake-token", apiFetch: vi.fn() };
});

import { apiFetch } from "../api/client";

const fixturePeriod: CompliancePeriod = {
  id: "period-1",
  periodStart: "2026-01-01",
  periodEnd: "2026-01-31",
  label: "يناير 2026",
  status: "open",
  createdBy: "u1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const fixtureNitaqat: NitaqatComplianceRecord = {
  id: "nitaqat-1",
  compliancePeriodId: "period-1",
  sourceType: "manual",
  verificationStatus: "unverified",
  classification: "أخضر متوسط",
  saudiCount: 8,
  nonSaudiCount: 12,
  totalCount: 20,
  externalReference: null,
  verifiedAt: null,
  verifiedByUserId: null,
  notes: null,
  createdBy: "u1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const fixtureGosi: GosiComplianceRecord = {
  id: "gosi-1",
  compliancePeriodId: "period-1",
  registeredEmployeeCount: 18,
  contributionStatus: "recorded",
  submissionStatus: "not_recorded",
  paymentStatus: "not_recorded",
  sourceType: "external_reference",
  verificationStatus: "verified",
  externalReference: "خطاب GOSI رقم 100",
  verifiedAt: "2026-01-10T00:00:00.000Z",
  verifiedByUserId: "u1",
  notes: null,
  createdBy: "u1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-10T00:00:00.000Z",
};

const fixtureException: ComplianceException = {
  id: "exc-1",
  compliancePeriodId: null,
  category: null,
  description: "يحتاج إلى تحقق من بيانات نطاقات",
  severity: "high",
  status: "open",
  dueDate: null,
  resolvedAt: null,
  resolvedByUserId: null,
  closedAt: null,
  closedByUserId: null,
  createdBy: "u1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const fixtureDashboard: ComplianceDashboard = {
  nitaqat: fixtureNitaqat,
  gosi: fixtureGosi,
  exceptions: { open: 1, highOrCritical: 1 },
};

function mockApi(overrides: { dashboard?: ComplianceDashboard; periods?: CompliancePeriod[]; nitaqat?: NitaqatComplianceRecord[]; gosi?: GosiComplianceRecord[]; exceptions?: ComplianceException[] } = {}) {
  const dashboard = overrides.dashboard ?? fixtureDashboard;
  const periods = overrides.periods ?? [fixturePeriod];
  const nitaqat = overrides.nitaqat ?? [fixtureNitaqat];
  const gosi = overrides.gosi ?? [fixtureGosi];
  const exceptions = overrides.exceptions ?? [fixtureException];

  vi.mocked(apiFetch).mockImplementation(async (path: unknown, options?: unknown) => {
    const p = String(path);
    const method = (options as { method?: string })?.method;
    if (p === "/auth/me") return { user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "co1", name: "Test Co" } };
    if (p === "/workforce-compliance") return dashboard;
    if (p === "/workforce-compliance/periods") return periods;
    if (p === "/workforce-compliance/snapshots") return [];
    if (p === "/workforce-compliance/nitaqat") return nitaqat;
    if (p === "/workforce-compliance/gosi") return gosi;
    if (p.startsWith("/workforce-compliance/exceptions")) return exceptions;
    if (p === "/workforce-compliance/nitaqat/nitaqat-1/evidence") return [];
    if (p === "/workforce-compliance/gosi/gosi-1/evidence") return [];
    if (p === "/workforce-compliance/exceptions/exc-1/resolve" && method === "POST") return { ...fixtureException, status: "resolved" };
    throw new Error(`unexpected apiFetch call in test: ${p}`);
  });
}

function renderPage() {
  return render(
    <I18nProvider>
    <MemoryRouter>
      <AuthProvider>
        <LaborCompliance />
      </AuthProvider>
    </MemoryRouter>
    </I18nProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("unexpected global fetch call in test"))),
  );
});

describe("<LaborCompliance/>", () => {
  it("renders the dashboard distinguishing verified from unverified, showing source, and never a compliance score", async () => {
    mockApi();
    renderPage();

    await waitFor(() => expect(screen.getAllByText("غير موثق").length).toBeGreaterThan(0));
    expect(screen.getAllByText("موثق").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/إدخال داخلي/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/مرجع خارجي/).length).toBeGreaterThan(0);
    expect(screen.getByText("1 مفتوحة")).toBeInTheDocument();
    expect(screen.getByText("1 عالية الأولوية")).toBeInTheDocument();

    const bodyText = document.body.textContent ?? "";
    expect(bodyText).not.toMatch(/\d+%|نسبة الامتثال|معتمد من الحكومة|مضمون/);
  });

  it("shows an honest empty state when there is no Nitaqat/GOSI record yet", async () => {
    mockApi({ dashboard: { nitaqat: null, gosi: null, exceptions: { open: 0, highOrCritical: 0 } } });
    renderPage();
    await waitFor(() => expect(screen.getAllByText("لا يوجد سجل بعد").length).toBe(2));
  });

  it("shows a retryable error state when the dashboard fails to load", async () => {
    const { ApiError } = await import("../api/client");
    vi.mocked(apiFetch).mockImplementation(async (path: unknown) => {
      const p = String(path);
      if (p === "/auth/me") return { user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "co1", name: "Test Co" } };
      throw new ApiError("تعذّر الاتصال بالخادم", 500);
    });
    renderPage();
    await waitFor(() => expect(screen.getAllByText("تعذّر الاتصال بالخادم").length).toBeGreaterThan(0));
  });

  it("the Nitaqat tab lists records with classification stored as free text, not a computed value", async () => {
    mockApi();
    renderPage();
    await waitFor(() => expect(screen.getByText(/أخضر متوسط/)).toBeInTheDocument());
  });

  it("switching to the GOSI tab shows GOSI-specific status labels", async () => {
    mockApi();
    renderPage();
    await waitFor(() => expect(screen.getByText(/أخضر متوسط/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("tab", { name: "GOSI" }));
    await waitFor(() => expect(screen.getByText(/الاشتراك: مسجَّل/)).toBeInTheDocument());
  });

  it("the exceptions tab lists open exceptions with a resolve action, and resolving calls the dedicated endpoint", async () => {
    mockApi();
    renderPage();
    await waitFor(() => expect(screen.getByText(/أخضر متوسط/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("tab", { name: "استثناءات" }));
    await waitFor(() => expect(screen.getByText("يحتاج إلى تحقق من بيانات نطاقات")).toBeInTheDocument());

    const resolveButton = screen.getByRole("button", { name: "تحديد كمحلول" });
    fireEvent.click(resolveButton);

    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith("/workforce-compliance/exceptions/exc-1/resolve", expect.objectContaining({ method: "POST" })),
    );
  });

  it("the periods tab shows the create-period form fields in Arabic", async () => {
    mockApi();
    renderPage();
    await waitFor(() => expect(screen.getByText(/أخضر متوسط/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("tab", { name: "الفترات" }));
    await waitFor(() => expect(screen.getByText("يناير 2026")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "+ فترة جديدة" }));
    expect(screen.getByPlaceholderText("تسمية (اختياري)")).toBeInTheDocument();
  });
});
