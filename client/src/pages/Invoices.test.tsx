import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../auth/AuthContext";
import { I18nProvider } from "../i18n/I18nProvider";
import { Invoices } from "./Invoices";

// P0-2 pre-launch hardening — this global /invoices page has its own,
// separate create-invoice form (NewInvoiceForm) that calls apiFetch
// directly rather than going through api/invoices.ts's createInvoice()
// wrapper (unlike the project-scoped InvoicesSection). It creates against
// the exact same server endpoint, so it carries the exact same
// duplicate-submission risk and needs the exact same fix — proven here
// with one focused test rather than re-deriving the full retry/new-key
// matrix already covered end-to-end for the shared primitive in
// project/sections/InvoicesSection.test.tsx.

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return { ...actual, getToken: () => "fake-token", apiFetch: vi.fn() };
});

import { apiFetch } from "../api/client";

function renderPage() {
  return render(
    <I18nProvider>
      <AuthProvider>
        <MemoryRouter>
          <Invoices />
        </MemoryRouter>
      </AuthProvider>
    </I18nProvider>,
  );
}

describe("<Invoices/> (global page) — create-invoice Idempotency-Key wiring", () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockClear();
  });

  it("sends a real Idempotency-Key header on the global page's own create-invoice form", async () => {
    vi.mocked(apiFetch).mockImplementation((path: unknown, reqOpts?: RequestInit) => {
      const p = String(path);
      const method = reqOpts?.method ?? "GET";
      if (p === "/auth/me") {
        return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "co1", name: "Test Co" } });
      }
      if (p.startsWith("/invoices?") && method === "GET") return Promise.resolve({ invoices: [], hasMore: false });
      if (p === "/invoices" && method === "POST") {
        return Promise.resolve({
          id: "inv-new",
          companyId: "co1",
          quoteId: null,
          projectId: null,
          contractId: null,
          invoiceNumber: "INV-1",
          clientName: "عميل",
          clientAddress: null,
          clientTaxId: null,
          taxRatePercent: "15.00",
          language: "ar",
          status: "draft",
          publicToken: "tok",
          issueDate: "2026-01-01",
          dueDate: null,
          paidAt: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          subtotal: 500,
          taxAmount: 75,
          total: 575,
        });
      }
      return Promise.reject(new Error(`unexpected apiFetch call in test: ${p} ${method}`));
    });

    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: "+ فاتورة جديدة" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "+ فاتورة جديدة" }));
    fireEvent.change(screen.getByPlaceholderText("اسم العميل"), { target: { value: "عميل" } });
    fireEvent.change(screen.getByPlaceholderText("بند (مثال: أجور تركيب)"), { target: { value: "عمل" } });
    fireEvent.change(screen.getByPlaceholderText("المبلغ"), { target: { value: "500" } });
    fireEvent.click(screen.getByRole("button", { name: "حفظ كمسودة" }));

    await waitFor(() => {
      const postCalls = vi.mocked(apiFetch).mock.calls.filter((c) => c[0] === "/invoices" && (c[1] as RequestInit | undefined)?.method === "POST");
      expect(postCalls).toHaveLength(1);
    });

    const postCall = vi.mocked(apiFetch).mock.calls.find((c) => c[0] === "/invoices" && (c[1] as RequestInit | undefined)?.method === "POST")!;
    const headers = (postCall[1] as RequestInit).headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBeTruthy();
    expect(headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/i);
  });
});
