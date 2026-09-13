import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { PlatformAuthProvider } from "../auth/PlatformAuthContext";
import { I18nProvider } from "../../i18n/I18nProvider";
import { PlatformOwnershipTransfer } from "./PlatformOwnershipTransfer";
import type { OwnershipTransferCandidate } from "../api/types";

vi.mock("../api/platformClient", async () => {
  const actual = await vi.importActual<typeof import("../api/platformClient")>("../api/platformClient");
  return { ...actual, getPlatformToken: () => null, platformApiFetch: vi.fn() };
});

import { platformApiFetch } from "../api/platformClient";

const candidate: OwnershipTransferCandidate = { id: "op-2", name: "خالد", email: "khaled@test.com", role: "platform_admin" };

function renderPage() {
  return render(
    <I18nProvider>
      <MemoryRouter>
        <PlatformAuthProvider>
          <PlatformOwnershipTransfer />
        </PlatformAuthProvider>
      </MemoryRouter>
    </I18nProvider>,
  );
}

describe("<PlatformOwnershipTransfer/>", () => {
  it("shows an empty state when no other operators exist", async () => {
    vi.mocked(platformApiFetch).mockResolvedValue({ operators: [] });
    renderPage();
    await waitFor(() => expect(screen.getByText("لا يوجد مشغّلون نشطون آخرون لنقل الملكية إليهم.")).toBeInTheDocument());
  });

  it("renders the transfer form once candidates load", async () => {
    vi.mocked(platformApiFetch).mockResolvedValue({ operators: [candidate] });
    renderPage();
    await waitFor(() => expect(screen.getByText("نقل الملكية")).toBeInTheDocument());
    expect(screen.getByText(/khaled@test.com/)).toBeInTheDocument();
  });

  it("submits a transfer and shows the result", async () => {
    vi.mocked(platformApiFetch).mockImplementation((path: unknown) => {
      if (String(path) === "/platform/ownership-transfer/operators") return Promise.resolve({ operators: [candidate] });
      return Promise.reject(new Error(`unexpected: ${path}`));
    });
    renderPage();
    await waitFor(() => expect(screen.getByText(/khaled@test.com/)).toBeInTheDocument());

    fireEvent.change(screen.getByRole("combobox"), { target: { value: candidate.id } });
    await waitFor(() => expect(screen.getByText(/اكتب khaled@test.com للتأكيد/)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(/اكتب khaled@test.com للتأكيد/), { target: { value: candidate.email } });
    fireEvent.change(screen.getByLabelText("سبب النقل"), { target: { value: "التقاعد" } });

    vi.mocked(platformApiFetch).mockImplementation((path: unknown, opts?: RequestInit) => {
      if (String(path) === "/platform/ownership-transfer" && opts?.method === "POST") {
        return Promise.resolve({
          previousOwner: { id: "op-1", email: "owner@test.com", newRole: "platform_admin" },
          newOwner: { id: "op-2", email: "khaled@test.com", newRole: "platform_owner" },
          reason: "التقاعد",
          revokedSessionCount: 2,
          transferredAt: "2026-01-01T00:00:00.000Z",
        });
      }
      return Promise.reject(new Error(`unexpected: ${path}`));
    });

    fireEvent.click(screen.getByRole("button", { name: "نقل الملكية" }));
    await waitFor(() => expect(screen.getByText("تم نقل الملكية")).toBeInTheDocument());
  });
});
