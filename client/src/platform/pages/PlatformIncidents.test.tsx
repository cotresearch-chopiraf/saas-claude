import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { PlatformAuthProvider } from "../auth/PlatformAuthContext";
import { I18nProvider } from "../../i18n/I18nProvider";
import { PlatformIncidents } from "./PlatformIncidents";
import type { Incident } from "../api/types";

vi.mock("../api/platformClient", async () => {
  const actual = await vi.importActual<typeof import("../api/platformClient")>("../api/platformClient");
  return { ...actual, getPlatformToken: () => null, platformApiFetch: vi.fn() };
});

import { platformApiFetch } from "../api/platformClient";

const incident: Incident = {
  id: "inc-1",
  companyId: null,
  title: "انقطاع في المنصة",
  description: "تأثرت جميع الشركات",
  severity: "critical",
  status: "open",
  affectedService: "api",
  correlationId: null,
  source: "manual",
  resolutionNotes: null,
  createdByPlatformOperatorId: "op-1",
  resolvedByPlatformOperatorId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  resolvedAt: null,
};

function renderPage() {
  return render(
    <I18nProvider>
      <MemoryRouter>
        <PlatformAuthProvider>
          <PlatformIncidents />
        </PlatformAuthProvider>
      </MemoryRouter>
    </I18nProvider>,
  );
}

describe("<PlatformIncidents/>", () => {
  it("renders incidents with their severity and status", async () => {
    vi.mocked(platformApiFetch).mockResolvedValue([incident]);
    renderPage();
    await waitFor(() => expect(screen.getByText("انقطاع في المنصة")).toBeInTheDocument());
    expect(screen.getByText("حرجة")).toBeInTheDocument();
    expect(screen.getAllByText("مفتوحة").length).toBeGreaterThanOrEqual(1);
  });

  it("shows an empty state with no incidents", async () => {
    vi.mocked(platformApiFetch).mockResolvedValue([]);
    renderPage();
    await waitFor(() => expect(screen.getByText("لا توجد حوادث مسجّلة.")).toBeInTheDocument());
  });

  it("resolving requires resolution notes and calls the status endpoint", async () => {
    vi.mocked(platformApiFetch).mockResolvedValue([incident]);
    renderPage();
    await waitFor(() => expect(screen.getByText("انقطاع في المنصة")).toBeInTheDocument());

    fireEvent.click(screen.getByText("انقطاع في المنصة"));
    await waitFor(() => expect(screen.getByText("وضع علامة محلولة")).toBeInTheDocument());

    fireEvent.change(screen.getByPlaceholderText("ملاحظات الحل (مطلوبة لإغلاق الحادثة)"), { target: { value: "تمت إعادة تشغيل الخدمة" } });

    let capturedBody: unknown = null;
    vi.mocked(platformApiFetch).mockImplementation((path: unknown, opts?: RequestInit) => {
      if (String(path) === "/platform/incidents/inc-1/status" && opts?.method === "PATCH") {
        capturedBody = JSON.parse(opts.body as string);
        return Promise.resolve({ ...incident, status: "resolved", resolutionNotes: "تمت إعادة تشغيل الخدمة" });
      }
      return Promise.resolve([{ ...incident, status: "resolved" }]);
    });

    fireEvent.click(screen.getByText("وضع علامة محلولة"));
    await waitFor(() => expect(capturedBody).toEqual({ status: "resolved", resolutionNotes: "تمت إعادة تشغيل الخدمة" }));
  });
});
