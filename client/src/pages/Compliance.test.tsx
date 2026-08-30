import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../auth/AuthContext";
import { Compliance } from "./Compliance";
import type {
  ComplianceAuditEvent,
  ComplianceCountry,
  ComplianceOverride,
  ComplianceProfile,
  ComplianceRulesResponse,
  ComplianceStatus,
} from "../api/types";

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return { ...actual, getToken: () => "fake-token", apiFetch: vi.fn() };
});

import { apiFetch } from "../api/client";

const fixtureCountries: ComplianceCountry[] = [
  { countryCode: "SA", displayName: { ar: "المملكة العربية السعودية" } },
  { countryCode: "AE", displayName: { ar: "الإمارات العربية المتحدة" } },
];

const fixtureProfile: ComplianceProfile = {
  id: "profile-1",
  companyId: "co1",
  countryCode: "SA",
  legalEntityType: "llc",
  businessActivity: null,
  taxRegistrationStatus: null,
  activeRuleVersionId: "rv-1",
  status: "configured",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-05T00:00:00.000Z",
};

const fixtureStatusConfigured: ComplianceStatus = {
  status: "configured",
  countryCode: "SA",
  ruleVersion: "2026.1",
  zakat: { status: "resolved", applicable: false, reviewRequired: false },
  overrideCount: 0,
  lastUpdate: "2026-01-05T00:00:00.000Z",
};

const fixtureStatusNotConfigured: ComplianceStatus = { status: "not_configured" };

const fixtureRulesResolved: ComplianceRulesResponse = {
  status: "resolved",
  countryCode: "SA",
  ruleVersion: "2026.1",
  ruleVersionId: "rv-1",
  rules: {
    vat: {
      applicable: true,
      standardRatePercent: 15,
      categories: [{ code: "standard_rate", label: { ar: "نسبة قياسية" }, ratePercent: 15 }],
    },
    withholding: { applicable: false, rules: [] },
    zakat: { applicable: false, reviewRequired: false },
    eInvoicing: { required: true, profile: "zatca_fatoora_phase2" },
    invoice: { requiredFields: ["taxId"], bilingualRequired: true },
    localization: { currency: "SAR", language: "ar", direction: "rtl", dateFormat: "YYYY-MM-DD" },
    identifiers: [{ type: "vat_number", label: { ar: "الرقم الضريبي" }, required: true }],
  },
};

const fixtureRulesReviewRequired: ComplianceRulesResponse = { status: "review_required", reason: "no_compliance_profile" };

const fixtureActiveOverride: ComplianceOverride = {
  id: "override-1",
  companyId: "co1",
  settingKey: "vat.standardRatePercent",
  overrideValue: 10,
  officialDefaultSnapshot: 15,
  ruleVersionId: "rv-1",
  status: "active",
  effectiveFrom: "2026-01-01",
  effectiveTo: null,
  reason: "اتفاقية خاصة",
  createdBy: "u1",
  createdAt: "2026-01-01T00:00:00.000Z",
  resetAt: null,
  resetBy: null,
};

const fixtureResetOverride: ComplianceOverride = {
  ...fixtureActiveOverride,
  id: "override-reset-2",
  status: "reset",
  resetAt: "2026-01-10T00:00:00.000Z",
  resetBy: "u1",
};

const fixtureAuditEvent: ComplianceAuditEvent = {
  id: "audit-1",
  companyId: "co1",
  actorUserId: "u1",
  action: "profile.created",
  entityType: "company_compliance_profile",
  entityId: "profile-1",
  beforeValue: null,
  afterValue: { countryCode: "SA" },
  reason: null,
  source: "api",
  metadata: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

interface MockOptions {
  role?: "owner" | "member";
  status?: ComplianceStatus;
  profile?: ComplianceProfile;
  rules?: ComplianceRulesResponse;
  overrides?: ComplianceOverride[];
  overrideHistory?: ComplianceOverride[];
  history?: ComplianceAuditEvent[];
  overridableKeys?: string[];
}

function mockApi(opts: MockOptions = {}) {
  const {
    role = "owner",
    status = fixtureStatusConfigured,
    profile = fixtureProfile,
    rules = fixtureRulesResolved,
    overrides = [],
    overrideHistory = [],
    history = [],
    overridableKeys = ["vat.standardRatePercent", "vat.applicable"],
  } = opts;

  vi.mocked(apiFetch).mockImplementation((path: unknown, reqOpts?: RequestInit) => {
    const p = String(path);
    const method = reqOpts?.method ?? "GET";
    if (p === "/auth/me") {
      return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role }, company: { id: "co1", name: "Test Co" } });
    }
    if (p === "/compliance/status" && method === "GET") return Promise.resolve(status);
    if (p === "/compliance/rules" && method === "GET") return Promise.resolve(rules);
    if (p === "/compliance/overrides" && method === "GET") return Promise.resolve(overrides);
    if (p === "/compliance/overrides/history" && method === "GET") return Promise.resolve(overrideHistory);
    if (p === "/compliance/history" && method === "GET") return Promise.resolve(history);
    if (p === "/compliance/countries" && method === "GET") return Promise.resolve(fixtureCountries);
    if (p === "/compliance/overridable-settings" && method === "GET") return Promise.resolve(overridableKeys);
    if (p === "/compliance/profile" && method === "GET") {
      if (status.status === "not_configured") return Promise.reject(new (class extends Error {})());
      return Promise.resolve(profile);
    }
    if (p === "/compliance/profile" && method === "POST") return Promise.resolve(profile);
    return Promise.reject(new Error(`unexpected apiFetch call in test: ${p} ${method}`));
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <Compliance />
      </AuthProvider>
    </MemoryRouter>,
  );
}

function switchTab(name: string) {
  fireEvent.click(screen.getByRole("tab", { name }));
}

describe("<Compliance/> — Access", () => {
  it("1. an authenticated member can open and read the page", async () => {
    mockApi({ role: "member" });
    renderPage();
    await waitFor(() => expect(screen.getByText("الامتثال الضريبي")).toBeInTheDocument());
    expect(screen.getByText("رمز الدولة")).toBeInTheDocument();
  });

  it("2. an owner sees mutation controls (change-country form)", async () => {
    mockApi({ role: "owner" });
    renderPage();
    await waitFor(() => expect(screen.getByText("تغيير الدولة")).toBeInTheDocument());
  });

  it("3. a member does not see mutation controls (compliance.manage is owner-only)", async () => {
    mockApi({ role: "member" });
    renderPage();
    await waitFor(() => expect(screen.getByText("رمز الدولة")).toBeInTheDocument());
    expect(screen.queryByText("تغيير الدولة")).not.toBeInTheDocument();
  });
});

describe("<Compliance/> — Profile / Onboarding", () => {
  it("4. the not-configured state renders as an honest onboarding surface, not a generic error", async () => {
    mockApi({ status: fixtureStatusNotConfigured });
    renderPage();
    await waitFor(() => expect(screen.getByText("لم يتم إعداد ملف الامتثال الضريبي لهذه الشركة بعد")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "تفعيل الامتثال الضريبي" })).toBeInTheDocument();
  });

  it("5. submitting the onboarding form sends exactly the selected country to POST /compliance/profile", async () => {
    mockApi({ status: fixtureStatusNotConfigured });
    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: "تفعيل الامتثال الضريبي" })).toBeInTheDocument());

    let capturedBody: unknown = null;
    vi.mocked(apiFetch).mockImplementation((path: unknown, reqOpts?: RequestInit) => {
      const p = String(path);
      const method = reqOpts?.method ?? "GET";
      if (p === "/auth/me") return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "co1", name: "Test Co" } });
      if (p === "/compliance/profile" && method === "POST") {
        capturedBody = JSON.parse(reqOpts!.body as string);
        return Promise.resolve(fixtureProfile);
      }
      if (p === "/compliance/status") return Promise.resolve(fixtureStatusConfigured);
      if (p === "/compliance/rules") return Promise.resolve(fixtureRulesResolved);
      if (p === "/compliance/overrides" && method === "GET") return Promise.resolve([]);
      if (p === "/compliance/overrides/history") return Promise.resolve([]);
      if (p === "/compliance/history") return Promise.resolve([]);
      if (p === "/compliance/countries") return Promise.resolve(fixtureCountries);
      if (p === "/compliance/overridable-settings") return Promise.resolve(["vat.standardRatePercent"]);
      if (p === "/compliance/profile" && method === "GET") return Promise.resolve(fixtureProfile);
      return Promise.reject(new Error(`unexpected: ${p} ${method}`));
    });

    fireEvent.click(screen.getByRole("button", { name: "تفعيل الامتثال الضريبي" }));
    await waitFor(() => expect(capturedBody).toEqual({ countryCode: "SA" }));
  });

  it("6. a successful configuration refreshes the page into the configured state", async () => {
    mockApi({ status: fixtureStatusNotConfigured });
    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: "تفعيل الامتثال الضريبي" })).toBeInTheDocument());

    mockApi({ status: fixtureStatusConfigured, profile: fixtureProfile });
    fireEvent.click(screen.getByRole("button", { name: "تفعيل الامتثال الضريبي" }));
    await waitFor(() => expect(screen.getByText("تغيير الدولة")).toBeInTheDocument());
  });
});

describe("<Compliance/> — Status", () => {
  it("7. renders the server-provided status verbatim, never derived client-side", async () => {
    mockApi({ status: fixtureStatusConfigured });
    renderPage();
    await waitFor(() => expect(screen.getByText("رمز الدولة")).toBeInTheDocument());
    switchTab("الحالة");
    await waitFor(() => expect(screen.getByText("2026.1")).toBeInTheDocument());
    expect(screen.getByText("configured")).toBeInTheDocument();
  });
});

describe("<Compliance/> — Rules", () => {
  it("8. renders the rules returned by the API, without computing anything locally", async () => {
    mockApi({ rules: fixtureRulesResolved });
    renderPage();
    await waitFor(() => expect(screen.getByText("رمز الدولة")).toBeInTheDocument());
    switchTab("القواعد المطبّقة");
    await waitFor(() => expect(screen.getByText("ضريبة القيمة المضافة")).toBeInTheDocument());
    expect(screen.getAllByText("15%").length).toBeGreaterThan(0);
    expect(screen.getByText("نسبة قياسية")).toBeInTheDocument();
  });
});

describe("<Compliance/> — Overrides", () => {
  it("9. existing overrides render from the API", async () => {
    mockApi({ overrides: [fixtureActiveOverride] });
    renderPage();
    await waitFor(() => expect(screen.getByText("رمز الدولة")).toBeInTheDocument());
    switchTab("الاستثناءات");
    await waitFor(() => expect(screen.getByText("vat.standardRatePercent")).toBeInTheDocument());
    expect(screen.getByText("10")).toBeInTheDocument();
    expect(screen.getByText("15")).toBeInTheDocument();
  });

  it("10. clicking '+ استثناء جديد' opens the create-override form", async () => {
    mockApi({});
    renderPage();
    await waitFor(() => expect(screen.getByText("رمز الدولة")).toBeInTheDocument());
    switchTab("الاستثناءات");
    await waitFor(() => expect(screen.getByRole("button", { name: "+ استثناء جديد" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "+ استثناء جديد" }));
    expect(screen.getByRole("button", { name: "إرسال الاستثناء" })).toBeInTheDocument();
  });

  it("11 & 12. a significant-deviation response shows the server's warning and does NOT auto-confirm", async () => {
    mockApi({});
    renderPage();
    await waitFor(() => expect(screen.getByText("رمز الدولة")).toBeInTheDocument());
    switchTab("الاستثناءات");
    await waitFor(() => expect(screen.getByRole("button", { name: "+ استثناء جديد" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "+ استثناء جديد" }));

    const createCalls: Array<Record<string, unknown>> = [];
    vi.mocked(apiFetch).mockImplementation((path: unknown, reqOpts?: RequestInit) => {
      const p = String(path);
      const method = reqOpts?.method ?? "GET";
      if (p === "/auth/me") return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "co1", name: "Test Co" } });
      if (p === "/compliance/overrides" && method === "POST") {
        const body = JSON.parse(reqOpts!.body as string);
        createCalls.push(body);
        if (!body.confirmed) {
          return Promise.resolve({ status: "confirmation_required", warning: "تحذير: هذا يغيّر النسبة الرسمية من 15% إلى 10%", officialDefault: 15 });
        }
        return Promise.resolve({ status: "created", override: fixtureActiveOverride });
      }
      if (p === "/compliance/status") return Promise.resolve(fixtureStatusConfigured);
      if (p === "/compliance/rules") return Promise.resolve(fixtureRulesResolved);
      if (p === "/compliance/overrides" && method === "GET") return Promise.resolve([]);
      if (p === "/compliance/overrides/history") return Promise.resolve([]);
      if (p === "/compliance/history") return Promise.resolve([]);
      if (p === "/compliance/countries") return Promise.resolve(fixtureCountries);
      if (p === "/compliance/overridable-settings") return Promise.resolve(["vat.standardRatePercent"]);
      if (p === "/compliance/profile" && method === "GET") return Promise.resolve(fixtureProfile);
      return Promise.reject(new Error(`unexpected: ${p} ${method}`));
    });

    fireEvent.change(screen.getByLabelText("القيمة الجديدة"), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText("سارٍ من"), { target: { value: "2026-01-01" } });
    fireEvent.click(screen.getByRole("button", { name: "إرسال الاستثناء" }));

    await waitFor(() => expect(screen.getByText(/تحذير: هذا يغيّر النسبة الرسمية/)).toBeInTheDocument());
    // The first request must never have sent confirmed:true.
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].confirmed).toBe(false);
    expect(screen.getByText("15")).toBeInTheDocument(); // officialDefault shown verbatim

    // 13. explicit confirmation resubmits with confirmed:true
    fireEvent.click(screen.getByRole("button", { name: "تأكيد المتابعة" }));
    await waitFor(() => expect(createCalls).toHaveLength(2));
    expect(createCalls[1].confirmed).toBe(true);
    expect(createCalls[1].settingKey).toBe("vat.standardRatePercent");
  });

  it("14. a successful override creation (no deviation warning) refreshes overrides", async () => {
    mockApi({ overridableKeys: ["vat.applicable"] });
    renderPage();
    await waitFor(() => expect(screen.getByText("رمز الدولة")).toBeInTheDocument());
    switchTab("الاستثناءات");
    await waitFor(() => expect(screen.getByRole("button", { name: "+ استثناء جديد" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "+ استثناء جديد" }));

    vi.mocked(apiFetch).mockImplementation((path: unknown, reqOpts?: RequestInit) => {
      const p = String(path);
      const method = reqOpts?.method ?? "GET";
      if (p === "/auth/me") return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "co1", name: "Test Co" } });
      if (p === "/compliance/overrides" && method === "POST") return Promise.resolve({ status: "created", override: fixtureActiveOverride });
      if (p === "/compliance/status") return Promise.resolve({ ...fixtureStatusConfigured, overrideCount: 1 });
      if (p === "/compliance/rules") return Promise.resolve(fixtureRulesResolved);
      if (p === "/compliance/overrides" && method === "GET") return Promise.resolve([fixtureActiveOverride]);
      if (p === "/compliance/overrides/history") return Promise.resolve([fixtureActiveOverride]);
      if (p === "/compliance/history") return Promise.resolve([]);
      if (p === "/compliance/countries") return Promise.resolve(fixtureCountries);
      if (p === "/compliance/overridable-settings") return Promise.resolve(["vat.applicable"]);
      if (p === "/compliance/profile" && method === "GET") return Promise.resolve(fixtureProfile);
      return Promise.reject(new Error(`unexpected: ${p} ${method}`));
    });

    fireEvent.change(screen.getByLabelText("القيمة الجديدة"), { target: { value: "true" } });
    fireEvent.change(screen.getByLabelText("سارٍ من"), { target: { value: "2026-01-01" } });
    fireEvent.click(screen.getByRole("button", { name: "إرسال الاستثناء" }));

    await waitFor(() => expect(screen.getAllByText("vat.standardRatePercent").length).toBeGreaterThan(0));
  });

  it("15 & 16. resetting an override calls the reset endpoint with the correct id and refreshes state", async () => {
    mockApi({ overrides: [fixtureActiveOverride] });
    renderPage();
    await waitFor(() => expect(screen.getByText("رمز الدولة")).toBeInTheDocument());
    switchTab("الاستثناءات");
    await waitFor(() => expect(screen.getByText("vat.standardRatePercent")).toBeInTheDocument());

    let resetCalledWith: string | null = null;
    vi.mocked(apiFetch).mockImplementation((path: unknown, reqOpts?: RequestInit) => {
      const p = String(path);
      const method = reqOpts?.method ?? "GET";
      if (p === "/auth/me") return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "co1", name: "Test Co" } });
      const resetMatch = p.match(/^\/compliance\/overrides\/([^/]+)\/reset$/);
      if (resetMatch && method === "POST") {
        resetCalledWith = resetMatch[1];
        return Promise.resolve({ ...fixtureActiveOverride, status: "reset" });
      }
      if (p === "/compliance/status") return Promise.resolve(fixtureStatusConfigured);
      if (p === "/compliance/rules") return Promise.resolve(fixtureRulesResolved);
      if (p === "/compliance/overrides" && method === "GET") return Promise.resolve([]);
      if (p === "/compliance/overrides/history") return Promise.resolve([{ ...fixtureActiveOverride, status: "reset" }]);
      if (p === "/compliance/history") return Promise.resolve([]);
      if (p === "/compliance/countries") return Promise.resolve(fixtureCountries);
      if (p === "/compliance/overridable-settings") return Promise.resolve(["vat.standardRatePercent"]);
      if (p === "/compliance/profile" && method === "GET") return Promise.resolve(fixtureProfile);
      return Promise.reject(new Error(`unexpected: ${p} ${method}`));
    });

    fireEvent.click(screen.getByRole("button", { name: "إعادة تعيين" }));
    await waitFor(() => expect(resetCalledWith).toBe("override-1"));
    // State refreshed: the active override list is now empty.
    await waitFor(() => expect(screen.getByText("لا توجد استثناءات نشطة حالياً — القيم الرسمية للدولة مطبّقة كما هي.")).toBeInTheDocument());
  });
});

describe("<Compliance/> — History", () => {
  it("17. override history renders as its own distinct list", async () => {
    mockApi({ overrideHistory: [fixtureActiveOverride, fixtureResetOverride] });
    renderPage();
    await waitFor(() => expect(screen.getByText("رمز الدولة")).toBeInTheDocument());
    switchTab("السجل");
    await waitFor(() => expect(screen.getByText("سجل الاستثناءات (نشطة + معاد تعيينها)")).toBeInTheDocument());
    expect(screen.getAllByText("vat.standardRatePercent")).toHaveLength(2);
  });

  it("18. general compliance audit history renders as a separate, distinct list", async () => {
    mockApi({ history: [fixtureAuditEvent] });
    renderPage();
    await waitFor(() => expect(screen.getByText("رمز الدولة")).toBeInTheDocument());
    switchTab("السجل");
    await waitFor(() => expect(screen.getByText("سجل التدقيق العام للامتثال الضريبي")).toBeInTheDocument());
    expect(screen.getByText("profile.created")).toBeInTheDocument();
  });

  it("19. empty history is handled as an honest empty state, not a spinner or crash", async () => {
    mockApi({ overrideHistory: [], history: [] });
    renderPage();
    await waitFor(() => expect(screen.getByText("رمز الدولة")).toBeInTheDocument());
    switchTab("السجل");
    await waitFor(() => expect(screen.getByText("لا يوجد سجل استثناءات بعد.")).toBeInTheDocument());
    expect(screen.getByText("لا يوجد سجل تدقيق بعد.")).toBeInTheDocument();
  });
});

describe("<Compliance/> — Errors", () => {
  it("20. an API failure renders an honest, retryable error state without crashing", async () => {
    vi.mocked(apiFetch).mockImplementation((path: unknown) => {
      const p = String(path);
      if (p === "/auth/me") return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "co1", name: "Test Co" } });
      if (p === "/compliance/status") return Promise.reject(new Error("تعذّر الاتصال بالخادم"));
      return Promise.reject(new Error(`unexpected: ${p}`));
    });
    renderPage();
    await waitFor(() => expect(screen.getByText("تعذّر الاتصال بالخادم")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "إعادة المحاولة" })).toBeInTheDocument();
  });

  it("21. a not-configured company is shown the onboarding surface, never the generic error state", async () => {
    mockApi({ status: fixtureStatusNotConfigured });
    renderPage();
    await waitFor(() => expect(screen.getByText("لم يتم إعداد ملف الامتثال الضريبي لهذه الشركة بعد")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "إعادة المحاولة" })).not.toBeInTheDocument();
  });
});
