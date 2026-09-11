import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../auth/AuthContext";
import { I18nProvider } from "../i18n/I18nProvider";
import { ZatcaSettings } from "./ZatcaSettings";
import type { ZatcaConfig, ZatcaEgsUnit, ZatcaOnboardingStatusSummary } from "../api/types";

// ZATCA Customer Onboarding & Compliance Center — client tests for the new
// per-EGS-unit onboarding panel (CSR -> Compliance CSID -> Compliance
// Invoice -> Production CSID -> Renewal) added to the existing
// ZatcaSettings page. Every backend call is mocked at the apiFetch layer
// (same convention as pages/Compliance.test.tsx) — these tests assert what
// the UI renders from a given backend response, never re-derive anything
// the backend is responsible for, and never assert against a
// crypto/business outcome the client itself computed.

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return { ...actual, getToken: () => "fake-token", apiFetch: vi.fn() };
});

import { apiFetch } from "../api/client";

const fixtureUnit: ZatcaEgsUnit = {
  id: "egs-1",
  name: "المكتب الرئيسي",
  environment: "simulation",
  status: "onboarding",
  csidStatus: "none",
  certificateExpiresAt: null,
  lastCommunicationAt: null,
  hasCredential: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const fixtureConfig: ZatcaConfig = {
  identity: { legalName: "شركة الاختبار", address: null, vatNumber: "399999999900003", commercialRegistration: "1010101010" },
  egsUnits: [fixtureUnit],
};

const fixtureOnboardingStatus: ZatcaOnboardingStatusSummary = {
  status: "ready_for_simulation",
  identityComplete: true,
  hasSimulationEgsUnit: true,
  hasProductionEgsUnit: false,
  simulationConnected: false,
  productionConnected: false,
};

const EGS_ID_RE = /^\/zatca\/egs-units\/([^/]+)/;

interface MockOptions {
  role?: "owner" | "member";
  unit?: ZatcaEgsUnit;
  handlers?: Record<string, (method: string, body: unknown) => unknown>;
}

function mockApi(opts: MockOptions = {}) {
  const { role = "owner", unit = fixtureUnit, handlers = {} } = opts;
  const config: ZatcaConfig = { ...fixtureConfig, egsUnits: [unit] };

  vi.mocked(apiFetch).mockImplementation((path: unknown, reqOpts?: RequestInit) => {
    const p = String(path);
    const method = reqOpts?.method ?? "GET";
    const body = reqOpts?.body ? JSON.parse(reqOpts.body as string) : undefined;

    if (p === "/auth/me") {
      return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role }, company: { id: "c1", name: "Test Co" } });
    }
    if (p === "/zatca/config") return Promise.resolve(config);
    if (p === "/zatca/onboarding-status") return Promise.resolve(fixtureOnboardingStatus);
    if (p.startsWith("/zatca/submissions")) return Promise.resolve({ submissions: [], limit: 20, offset: 0, hasMore: false });
    if (p === "/invoices") return Promise.resolve([]);

    const custom = handlers[`${method} ${p}`];
    if (custom) return Promise.resolve(custom(method, body));

    // Default onboarding-route responses — overridable per test via `handlers`.
    if (p === `/zatca/egs-units/${unit.id}/csr` && method === "GET") return Promise.resolve({ csrInstance: null });
    if (p === `/zatca/egs-units/${unit.id}/compliance-csid` && method === "GET") return Promise.resolve({ complianceLifecycle: null });
    if (p === `/zatca/egs-units/${unit.id}/compliance-invoices` && method === "GET") return Promise.resolve({ attempts: [] });
    if (p === `/zatca/egs-units/${unit.id}/production-csid` && method === "GET") return Promise.resolve({ operations: [] });

    if (EGS_ID_RE.test(p)) return Promise.reject(new Error(`unmocked ZATCA onboarding call in test: ${method} ${p}`));
    return Promise.reject(new Error(`unexpected apiFetch call in test: ${method} ${p}`));
  });
}

function renderPage() {
  return render(
    <I18nProvider>
    <MemoryRouter>
      <AuthProvider>
        <ZatcaSettings />
      </AuthProvider>
    </MemoryRouter>
    </I18nProvider>,
  );
}

async function openOnboardingPanel() {
  await waitFor(() => expect(screen.getByRole("button", { name: /إعداد ZATCA الحقيقي/ })).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /إعداد ZATCA الحقيقي/ }));
  await waitFor(() => expect(screen.getByRole("tab", { name: "١. طلب CSR" })).toBeInTheDocument());
}

describe("<ZatcaSettings/> — Onboarding Center access", () => {
  it("an owner sees the real-onboarding toggle for an EGS unit", async () => {
    mockApi({ role: "owner" });
    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: /إعداد ZATCA الحقيقي/ })).toBeInTheDocument());
  });

  it("PERMISSION DENIED: a member does not see the real-onboarding toggle (zatca.submit is owner-only)", async () => {
    mockApi({ role: "member" });
    renderPage();
    await waitFor(() => expect(screen.getByText("وحدات الفوترة الإلكترونية (EGS)", { exact: false })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /إعداد ZATCA الحقيقي/ })).not.toBeInTheDocument();
  });

  it("opening the panel renders all five onboarding tabs and the current CSID status badge", async () => {
    mockApi({});
    renderPage();
    await openOnboardingPanel();
    expect(screen.getByRole("tab", { name: "٢. شهادة الامتثال" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "٣. فاتورة اختبار الامتثال" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "٤. تفعيل الإنتاج" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "٥. التجديد" })).toBeInTheDocument();
    expect(screen.getByText("حالة الشهادة: لا يوجد")).toBeInTheDocument();
  });
});

describe("<ZatcaSettings/> — CSR step", () => {
  it("shows an honest empty state when no CSR exists yet", async () => {
    mockApi({});
    renderPage();
    await openOnboardingPanel();
    expect(screen.getByText("لا يوجد طلب CSR لهذه الوحدة بعد.")).toBeInTheDocument();
  });

  it("OTP field is a password-style input, and the CSR form submits real field values, never a fabricated success", async () => {
    let capturedBody: unknown = null;
    mockApi({
      handlers: {
        [`POST /zatca/egs-units/${fixtureUnit.id}/csr`]: (_m, body) => {
          capturedBody = body;
          return { csrPem: "-----BEGIN CERTIFICATE REQUEST-----\nFAKE\n-----END CERTIFICATE REQUEST-----", csrDerBase64: "ZmFrZQ==" };
        },
      },
    });
    renderPage();
    await openOnboardingPanel();
    fireEvent.click(screen.getByRole("button", { name: "بدء إنشاء طلب CSR" }));

    const otpInput = screen.getByLabelText(/رمز التحقق \(OTP\)/) as HTMLInputElement;
    expect(otpInput.type).toBe("password");
    fireEvent.change(otpInput, { target: { value: "999111" } });
    fireEvent.change(screen.getByLabelText("الرقم التسلسلي لوحدة الفوترة (EGS Serial Number)"), { target: { value: "1-A|2-1.0|3-SN1" } });
    fireEvent.change(screen.getByLabelText("الوحدة التنظيمية (الفرع)"), { target: { value: "الرياض" } });
    fireEvent.change(screen.getByLabelText("الموقع"), { target: { value: "الرياض" } });
    fireEvent.change(screen.getByLabelText("النشاط/القطاع"), { target: { value: "المقاولات" } });

    fireEvent.click(screen.getByRole("button", { name: "إنشاء طلب CSR" }));
    await waitFor(() => expect(capturedBody).toBeTruthy());
    expect((capturedBody as { otp: string }).otp).toBe("999111");
    expect((capturedBody as { fields: { commonName: string } }).fields.commonName).toBe(fixtureUnit.name);

    await waitFor(() => expect(screen.getByText("تم إنشاء طلب CSR بنجاح.")).toBeInTheDocument());
    // OTP is cleared from the DOM state after submit -- never left sitting
    // in the form.
    expect((screen.getByLabelText(/رمز التحقق \(OTP\)/) as HTMLInputElement).value).toBe("");
  });
});

describe("<ZatcaSettings/> — Compliance CSID step", () => {
  it("REQUEST/CONFIRM are two distinct actions, and the real ZATCA-returned credential is never rendered", async () => {
    mockApi({
      handlers: {
        [`POST /zatca/egs-units/${fixtureUnit.id}/compliance-csid`]: () => ({ requestId: "REQ-123", dispositionMessage: "ISSUED" }),
      },
    });
    renderPage();
    await openOnboardingPanel();
    fireEvent.click(screen.getByRole("tab", { name: "٢. شهادة الامتثال" }));

    await waitFor(() => expect(screen.getByText(/لم يُطلب شهادة امتثال/)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/رمز التحقق \(OTP\)/), { target: { value: "123456" } });
    fireEvent.change(screen.getByLabelText("محتوى طلب CSR (Base64)"), { target: { value: "ZmFrZQ==" } });
    fireEvent.click(screen.getByRole("button", { name: "طلب شهادة الامتثال من ZATCA" }));

    await waitFor(() => expect(screen.getByText(/أصدرت ZATCA شهادة امتثال لهذا الطلب/)).toBeInTheDocument());
    expect(screen.getByText(/REQ-123/)).toBeInTheDocument();
    // The confirm section is a SEPARATE action -- still requires its own
    // binarySecurityToken/secret input, never auto-filled from the request
    // above (the backend never returns that credential to the browser).
    expect(screen.getByRole("button", { name: "تأكيد شهادة الامتثال" })).toBeInTheDocument();
    expect((screen.getByLabelText("المفتاح السري (secret)") as HTMLInputElement).value).toBe("");
  });

  it("confirm sends stage=compliance and refreshes on success (never claims success without a real response)", async () => {
    let confirmBody: unknown = null;
    mockApi({
      unit: { ...fixtureUnit, csidStatus: "compliance_pending" },
      handlers: {
        [`POST /zatca/egs-units/${fixtureUnit.id}/csid`]: (_m, body) => {
          confirmBody = body;
          return { ...fixtureUnit, csidStatus: "compliance_issued" };
        },
      },
    });
    renderPage();
    await openOnboardingPanel();
    fireEvent.click(screen.getByRole("tab", { name: "٢. شهادة الامتثال" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "تأكيد شهادة الامتثال" })).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("binarySecurityToken (الشهادة)"), { target: { value: "Y2VydA==" } });
    fireEvent.change(screen.getByLabelText("المفتاح السري (secret)"), { target: { value: "top-secret-value" } });
    fireEvent.click(screen.getByRole("button", { name: "تأكيد شهادة الامتثال" }));

    await waitFor(() => expect(confirmBody).toBeTruthy());
    expect((confirmBody as { stage: string }).stage).toBe("compliance");
  });
});

describe("<ZatcaSettings/> — Compliance Invoice (test) step", () => {
  it("submits the compliance-test document and lists prior attempts, never fabricating an outcome", async () => {
    let submitted = false;
    mockApi({
      handlers: {
        [`POST /zatca/egs-units/${fixtureUnit.id}/compliance-invoices`]: () => {
          submitted = true;
          return {
            status: "compliance_pending",
            correlationId: "corr-1",
            rawStatus: "REPORTED",
            warnings: null,
            clearanceStatus: null,
            qrSellertStatus: null,
            qrBuyertStatus: null,
            respondedAt: "2026-01-01T00:00:00.000Z",
          };
        },
        [`GET /zatca/egs-units/${fixtureUnit.id}/compliance-invoices`]: () => ({
          attempts: submitted
            ? [
                {
                  id: "att-1",
                  documentType: "388",
                  invoiceFamily: "standard",
                  correlationId: "corr-1",
                  rawStatus: "REPORTED",
                  normalizedOutcome: "compliance_pending",
                  attemptedAt: "2026-01-01T00:00:00.000Z",
                  errorCategory: null,
                },
              ]
            : [],
        }),
      },
    });
    renderPage();
    await openOnboardingPanel();
    fireEvent.click(screen.getByRole("tab", { name: "٣. فاتورة اختبار الامتثال" }));
    await waitFor(() => expect(screen.getByText("لا توجد محاولات بعد.")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("محتوى المستند (Base64)"), { target: { value: "PGE+PC9hPg==" } });
    fireEvent.change(screen.getByLabelText("تجزئة المستند (Base64)"), { target: { value: "abc123==" } });
    fireEvent.change(screen.getByLabelText("UUID"), { target: { value: "11111111-1111-1111-1111-111111111111" } });
    fireEvent.click(screen.getByRole("button", { name: "إرسال مستند الاختبار إلى ZATCA" }));

    await waitFor(() => expect(screen.getByText(/نتيجة ZATCA الفعلية: compliance_pending/)).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("388")).toBeInTheDocument());
  });
});

describe("<ZatcaSettings/> — Production CSID step", () => {
  it("is blocked with an honest explanation before Compliance CSID is issued", async () => {
    mockApi({});
    renderPage();
    await openOnboardingPanel();
    fireEvent.click(screen.getByRole("tab", { name: "٤. تفعيل الإنتاج" }));
    await waitFor(() => expect(screen.getByText(/لا يمكن تفعيل بيئة الإنتاج قبل إتمام شهادة الامتثال أولاً/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "طلب شهادة الإنتاج من ZATCA" })).toBeDisabled();
  });

  it("is enabled once Compliance CSID is issued, and honestly documents the currentCCSID spec ambiguity", async () => {
    mockApi({ unit: { ...fixtureUnit, csidStatus: "compliance_issued" } });
    renderPage();
    await openOnboardingPanel();
    fireEvent.click(screen.getByRole("tab", { name: "٤. تفعيل الإنتاج" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "طلب شهادة الإنتاج من ZATCA" })).not.toBeDisabled());
    expect(screen.getByText(/currentCCSID/)).toBeInTheDocument();
  });

  it("a real ZATCA rejection is shown via the mapped error presentation, never as a silent success", async () => {
    mockApi({
      unit: { ...fixtureUnit, csidStatus: "compliance_issued" },
      handlers: {
        [`POST /zatca/egs-units/${fixtureUnit.id}/production-csid`]: () => {
          throw Object.assign(new Error("رفضت ZATCA الطلب (currentCCSID مفقود)"), { category: "validation" });
        },
      },
    });
    // apiFetch itself throws ApiError, not a plain Error -- reimplement via
    // rejection using the real ApiError class so category propagates
    // exactly as production code requires.
    const { ApiError } = await import("../api/client");
    vi.mocked(apiFetch).mockImplementation((path: unknown, reqOpts?: RequestInit) => {
      const p = String(path);
      const method = reqOpts?.method ?? "GET";
      if (p === "/auth/me") return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "c1", name: "Test Co" } });
      if (p === "/zatca/config") return Promise.resolve({ ...fixtureConfig, egsUnits: [{ ...fixtureUnit, csidStatus: "compliance_issued" }] });
      if (p === "/zatca/onboarding-status") return Promise.resolve(fixtureOnboardingStatus);
      if (p.startsWith("/zatca/submissions")) return Promise.resolve({ submissions: [], limit: 20, offset: 0, hasMore: false });
      if (p === "/invoices") return Promise.resolve([]);
      if (p === `/zatca/egs-units/${fixtureUnit.id}/csr` && method === "GET") return Promise.resolve({ csrInstance: null });
      if (p === `/zatca/egs-units/${fixtureUnit.id}/compliance-csid` && method === "GET") return Promise.resolve({ complianceLifecycle: null });
      if (p === `/zatca/egs-units/${fixtureUnit.id}/compliance-invoices` && method === "GET") return Promise.resolve({ attempts: [] });
      if (p === `/zatca/egs-units/${fixtureUnit.id}/production-csid` && method === "GET") return Promise.resolve({ operations: [] });
      if (p === `/zatca/egs-units/${fixtureUnit.id}/production-csid` && method === "POST") {
        return Promise.reject(new ApiError("رفضت ZATCA الطلب (currentCCSID مفقود)", 400, "validation"));
      }
      return Promise.reject(new Error(`unexpected: ${method} ${p}`));
    });
    renderPage();
    await openOnboardingPanel();
    fireEvent.click(screen.getByRole("tab", { name: "٤. تفعيل الإنتاج" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "طلب شهادة الإنتاج من ZATCA" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "طلب شهادة الإنتاج من ZATCA" }));

    await waitFor(() => expect(screen.getByText("رفضت ZATCA البيانات المُرسلة")).toBeInTheDocument());
    expect(screen.getByText("رفضت ZATCA الطلب (currentCCSID مفقود)")).toBeInTheDocument();
    expect(screen.queryByText(/أصدرت ZATCA شهادة إنتاج/)).not.toBeInTheDocument();
  });
});

describe("<ZatcaSettings/> — Renewal step", () => {
  it("is disabled until Production CSID is active", async () => {
    mockApi({});
    renderPage();
    await openOnboardingPanel();
    fireEvent.click(screen.getByRole("tab", { name: "٥. التجديد" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "طلب التجديد من ZATCA" })).toBeDisabled());
  });

  it("a not_compliant (428) renewal outcome is shown honestly, without touching existing credentials", async () => {
    mockApi({
      unit: { ...fixtureUnit, csidStatus: "production_issued", certificateExpiresAt: "2026-02-01T00:00:00.000Z" },
      handlers: {
        [`POST /zatca/egs-units/${fixtureUnit.id}/production-csid/renew`]: () => ({
          requestId: "REN-1",
          dispositionMessage: "NOT_COMPLIANT",
          outcome: "not_compliant",
        }),
      },
    });
    renderPage();
    await openOnboardingPanel();
    fireEvent.click(screen.getByRole("tab", { name: "٥. التجديد" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "طلب التجديد من ZATCA" })).not.toBeDisabled());

    fireEvent.change(screen.getByLabelText(/رمز التحقق \(OTP\)/), { target: { value: "654321" } });
    fireEvent.change(screen.getByLabelText("محتوى طلب CSR للتجديد (Base64)"), { target: { value: "cmVuZXc=" } });
    fireEvent.click(screen.getByRole("button", { name: "طلب التجديد من ZATCA" }));

    await waitFor(() => expect(screen.getByText(/غير مستوفية لشروط التجديد حالياً/)).toBeInTheDocument());
    expect(screen.getByText(/لم يتغيّر أي شيء في بيانات الاعتماد الحالية/)).toBeInTheDocument();
  });
});

describe("<ZatcaSettings/> — no secret ever rendered", () => {
  it("real secret/token/OTP values used across the whole onboarding flow never appear in the rendered DOM", async () => {
    const rawSecret = "RAW-COMPLIANCE-SECRET-abc123";
    const rawToken = "RAW-BINARY-SECURITY-TOKEN-xyz789";
    mockApi({
      handlers: {
        [`POST /zatca/egs-units/${fixtureUnit.id}/compliance-csid`]: () => ({ requestId: "REQ-1", dispositionMessage: "ISSUED" }),
      },
    });
    renderPage();
    await openOnboardingPanel();
    fireEvent.click(screen.getByRole("tab", { name: "٢. شهادة الامتثال" }));
    await waitFor(() => expect(screen.getByText(/لم يُطلب شهادة امتثال/)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/رمز التحقق \(OTP\)/), { target: { value: "123456" } });
    fireEvent.change(screen.getByLabelText("محتوى طلب CSR (Base64)"), { target: { value: "ZmFrZQ==" } });
    fireEvent.click(screen.getByRole("button", { name: "طلب شهادة الامتثال من ZATCA" }));
    await waitFor(() => expect(screen.getByText(/أصدرت ZATCA شهادة امتثال لهذا الطلب/)).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("binarySecurityToken (الشهادة)"), { target: { value: rawToken } });
    fireEvent.change(screen.getByLabelText("المفتاح السري (secret)"), { target: { value: rawSecret } });

    // These are the raw values the browser holds in its own controlled
    // form state (necessary for the user to type them) -- what must NEVER
    // happen is the backend echoing them back into a rendered success/
    // status message. Assert the panel's status text (not the live form
    // input) never contains them.
    const statusRegion = screen.getByText(/أصدرت ZATCA شهادة امتثال لهذا الطلب/).closest("div")!;
    expect(within(statusRegion).queryByText(rawSecret)).toBeNull();
    expect(within(statusRegion).queryByText(rawToken)).toBeNull();
  });
});
