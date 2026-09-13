import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { PlatformAuthProvider } from "../auth/PlatformAuthContext";
import { I18nProvider } from "../../i18n/I18nProvider";
import { PlatformPlans } from "./PlatformPlans";
import type { Plan } from "../api/types";

vi.mock("../api/platformClient", async () => {
  const actual = await vi.importActual<typeof import("../api/platformClient")>("../api/platformClient");
  return { ...actual, getPlatformToken: () => null, platformApiFetch: vi.fn() };
});

import { platformApiFetch } from "../api/platformClient";

const plan: Plan = {
  id: "p-1",
  key: "pro",
  name: "الاحترافية",
  description: "خطة للشركات الكبيرة",
  isActive: true,
  limits: { maxUsers: 50, maxProjects: null, maxStorageMb: null, maxInvoicesPerMonth: null },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function renderPage() {
  return render(
    <I18nProvider>
      <MemoryRouter>
        <PlatformAuthProvider>
          <PlatformPlans />
        </PlatformAuthProvider>
      </MemoryRouter>
    </I18nProvider>,
  );
}

describe("<PlatformPlans/>", () => {
  it("renders plans with their limits", async () => {
    vi.mocked(platformApiFetch).mockResolvedValue({ plans: [plan] });
    renderPage();
    await waitFor(() => expect(screen.getByText("الاحترافية")).toBeInTheDocument());
    expect(screen.getByText(/50/)).toBeInTheDocument();
  });

  it("shows an empty state when there are no plans", async () => {
    vi.mocked(platformApiFetch).mockResolvedValue({ plans: [] });
    renderPage();
    await waitFor(() => expect(screen.getByText("لا توجد خطط بعد.")).toBeInTheDocument());
  });

  it("creates a new plan via the form", async () => {
    vi.mocked(platformApiFetch).mockResolvedValueOnce({ plans: [] });
    renderPage();
    await waitFor(() => expect(screen.getByText("لا توجد خطط بعد.")).toBeInTheDocument());

    fireEvent.click(screen.getByText("إنشاء خطة"));
    fireEvent.change(screen.getByPlaceholderText("المفتاح (مثل pro)"), { target: { value: "starter" } });
    fireEvent.change(screen.getByPlaceholderText("الاسم"), { target: { value: "المبتدئة" } });

    let capturedBody: unknown = null;
    vi.mocked(platformApiFetch).mockImplementation((path: unknown, opts?: RequestInit) => {
      const p = String(path);
      if (p === "/platform/plans" && opts?.method === "POST") {
        capturedBody = JSON.parse(opts.body as string);
        return Promise.resolve({ ...plan, key: "starter", name: "المبتدئة" });
      }
      return Promise.resolve({ plans: [{ ...plan, key: "starter", name: "المبتدئة" }] });
    });

    fireEvent.click(screen.getByRole("button", { name: "حفظ" }));
    await waitFor(() => expect(capturedBody).toMatchObject({ key: "starter", name: "المبتدئة" }));
  });
});
