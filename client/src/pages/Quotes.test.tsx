import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../auth/AuthContext";
import { I18nProvider } from "../i18n/I18nProvider";
import { Quotes } from "./Quotes";
import type { Quote } from "../api/types";

// Quote idempotency hardening — the server has supported an opt-in
// Idempotency-Key header for quote creation since Slice AA Scope E
// (routes/quotes.ts POST "/", the same withIdempotency() mechanism proven
// for invoices — see server/tests/idempotency.test.ts's existing
// "Idempotency: quote creation" suite for the server-side dedup/conflict/
// concurrency coverage, unchanged by this work). This client page never
// sent it. These tests prove: the header is actually sent, a retry on the
// same open form reuses the same key, a genuinely new quote gets a new
// key, and the separately-discovered convert-to-invoice action (which
// also creates a real invoice) got the identical fix.

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return { ...actual, getToken: () => "fake-token", apiFetch: vi.fn() };
});

import { apiFetch } from "../api/client";

const fixtureQuote: Quote = {
  id: "q1",
  companyId: "co1",
  quoteNumber: "Q-2001",
  clientName: "عميل",
  clientEmail: null,
  projectName: "مشروع",
  language: "ar",
  status: "accepted",
  publicToken: "tok-1",
  acceptedByName: "فلان",
  acceptedAt: "2026-01-10T00:00:00.000Z",
  createdAt: "2026-01-05T00:00:00.000Z",
  subtotal: 1000,
};

function renderPage() {
  return render(
    <I18nProvider>
      <AuthProvider>
        <MemoryRouter>
          <Quotes />
        </MemoryRouter>
      </AuthProvider>
    </I18nProvider>,
  );
}

function postCallsTo(path: string) {
  return vi.mocked(apiFetch).mock.calls.filter((c) => c[0] === path && (c[1] as RequestInit | undefined)?.method === "POST");
}

function headerOf(call: [unknown, RequestInit?]): Record<string, string> {
  return (call[1] as RequestInit).headers as Record<string, string>;
}

describe("<Quotes/> — create-quote Idempotency-Key wiring", () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockClear();
  });

  function baseMock(overrides: (path: string, method: string) => unknown | undefined) {
    vi.mocked(apiFetch).mockImplementation((path: unknown, reqOpts?: RequestInit) => {
      const p = String(path);
      const method = reqOpts?.method ?? "GET";
      const custom = overrides(p, method);
      if (custom !== undefined) return custom as Promise<unknown>;
      if (p === "/auth/me") {
        return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "co1", name: "Test Co" } });
      }
      if (p.startsWith("/quotes?") && method === "GET") return Promise.resolve({ quotes: [], hasMore: false });
      return Promise.reject(new Error(`unexpected apiFetch call in test: ${p} ${method}`));
    });
  }

  function openCreateForm() {
    fireEvent.click(screen.getByRole("button", { name: "+ عرض سعر جديد" }));
  }

  function fillCreateForm() {
    fireEvent.change(screen.getByPlaceholderText("اسم العميل"), { target: { value: "عميل جديد" } });
    fireEvent.change(screen.getByPlaceholderText("اسم المشروع"), { target: { value: "مشروع جديد" } });
    fireEvent.change(screen.getByPlaceholderText("بند (مثال: تركيب بلاط)"), { target: { value: "عمل" } });
    fireEvent.change(screen.getByPlaceholderText("المبلغ"), { target: { value: "500" } });
  }

  it("sends a real Idempotency-Key header on a normal quote creation", async () => {
    baseMock((p, method) => (p === "/quotes" && method === "POST" ? Promise.resolve({ id: "q-new" }) : undefined));
    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: "+ عرض سعر جديد" })).toBeInTheDocument());

    openCreateForm();
    fillCreateForm();
    fireEvent.click(screen.getByRole("button", { name: "حفظ كمسودة" }));

    await waitFor(() => expect(postCallsTo("/quotes")).toHaveLength(1));
    const headers = headerOf(postCallsTo("/quotes")[0]);
    expect(headers["Idempotency-Key"]).toBeTruthy();
    expect(headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("a retry after a failed submission on the SAME open form reuses the identical key", async () => {
    let firstAttempt = true;
    baseMock((p, method) => {
      if (p === "/quotes" && method === "POST") {
        if (firstAttempt) {
          firstAttempt = false;
          return Promise.reject(new Error("انقطع الاتصال"));
        }
        return Promise.resolve({ id: "q-new" });
      }
      return undefined;
    });
    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: "+ عرض سعر جديد" })).toBeInTheDocument());

    openCreateForm();
    fillCreateForm();
    fireEvent.click(screen.getByRole("button", { name: "حفظ كمسودة" }));
    await waitFor(() => expect(postCallsTo("/quotes")).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "حفظ كمسودة" }));
    await waitFor(() => expect(postCallsTo("/quotes")).toHaveLength(2));

    const key1 = headerOf(postCallsTo("/quotes")[0])["Idempotency-Key"];
    const key2 = headerOf(postCallsTo("/quotes")[1])["Idempotency-Key"];
    expect(key1).toBe(key2);
  });

  it("a genuinely new quote (form closed and reopened) gets a different key from the previous submission", async () => {
    baseMock((p, method) => (p === "/quotes" && method === "POST" ? Promise.resolve({ id: "q-new" }) : undefined));
    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: "+ عرض سعر جديد" })).toBeInTheDocument());

    openCreateForm();
    fillCreateForm();
    fireEvent.click(screen.getByRole("button", { name: "حفظ كمسودة" }));
    await waitFor(() => expect(postCallsTo("/quotes")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByPlaceholderText("اسم العميل")).not.toBeInTheDocument());

    openCreateForm();
    fillCreateForm();
    fireEvent.click(screen.getByRole("button", { name: "حفظ كمسودة" }));
    await waitFor(() => expect(postCallsTo("/quotes")).toHaveLength(2));

    const key1 = headerOf(postCallsTo("/quotes")[0])["Idempotency-Key"];
    const key2 = headerOf(postCallsTo("/quotes")[1])["Idempotency-Key"];
    expect(key1).not.toBe(key2);
  });
});

describe("<Quotes/> — convert-to-invoice Idempotency-Key wiring (found during P0-2 re-verification)", () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockClear();
  });

  function mockWithQuote(overrides: (path: string, method: string) => unknown | undefined) {
    vi.mocked(apiFetch).mockImplementation((path: unknown, reqOpts?: RequestInit) => {
      const p = String(path);
      const method = reqOpts?.method ?? "GET";
      const custom = overrides(p, method);
      if (custom !== undefined) return custom as Promise<unknown>;
      if (p === "/auth/me") {
        return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "co1", name: "Test Co" } });
      }
      if (p.startsWith("/quotes?") && method === "GET") return Promise.resolve({ quotes: [fixtureQuote], hasMore: false });
      if (p === "/quotes/q1" && method === "GET") return Promise.resolve({ ...fixtureQuote, items: [{ description: "بند", amount: "1000" }] });
      return Promise.reject(new Error(`unexpected apiFetch call in test: ${p} ${method}`));
    });
  }

  it("sends a real Idempotency-Key header when converting an accepted quote to an invoice", async () => {
    mockWithQuote((p, method) => (p === "/invoices" && method === "POST" ? Promise.resolve({ id: "inv-new" }) : undefined));
    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: "تحويل إلى فاتورة" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "تحويل إلى فاتورة" }));
    await waitFor(() => expect(postCallsTo("/invoices")).toHaveLength(1));

    const headers = headerOf(postCallsTo("/invoices")[0]);
    expect(headers["Idempotency-Key"]).toBeTruthy();
    expect(headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("a retry after a failed conversion on the same row reuses the identical key", async () => {
    let firstAttempt = true;
    mockWithQuote((p, method) => {
      if (p === "/invoices" && method === "POST") {
        if (firstAttempt) {
          firstAttempt = false;
          return Promise.reject(new Error("فشل الاتصال"));
        }
        return Promise.resolve({ id: "inv-new" });
      }
      return undefined;
    });
    renderPage();
    await waitFor(() => expect(screen.getByRole("button", { name: "تحويل إلى فاتورة" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "تحويل إلى فاتورة" }));
    await waitFor(() => expect(postCallsTo("/invoices")).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "تحويل إلى فاتورة" }));
    await waitFor(() => expect(postCallsTo("/invoices")).toHaveLength(2));

    const key1 = headerOf(postCallsTo("/invoices")[0])["Idempotency-Key"];
    const key2 = headerOf(postCallsTo("/invoices")[1])["Idempotency-Key"];
    expect(key1).toBe(key2);
  });
});
