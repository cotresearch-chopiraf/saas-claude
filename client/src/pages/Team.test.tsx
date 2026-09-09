import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthProvider } from "../auth/AuthContext";
import { Team } from "./Team";
import type { CompanyMember } from "../api/types";

// MIDAD Phase A — role change / deactivate / reactivate controls on the Team
// page. Same fixture/mock-apiFetch discipline as Customers.test.tsx.

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return { ...actual, getToken: () => "fake-token", apiFetch: vi.fn() };
});

import { apiFetch, ApiError } from "../api/client";

const ownerMember: CompanyMember = {
  id: "u1",
  name: "المالك",
  email: "owner@test.com",
  role: "owner",
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
};
const activeMember: CompanyMember = {
  id: "u2",
  name: "عضو نشط",
  email: "member@test.com",
  role: "member",
  status: "active",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function mockApi(role: "owner" | "member", members: CompanyMember[]) {
  vi.mocked(apiFetch).mockImplementation((path: unknown, opts?: RequestInit) => {
    const p = String(path);
    const method = opts?.method;
    if (p === "/auth/me") {
      return Promise.resolve({
        user: { id: "u1", name: "Test", email: "t@test.com", role },
        company: { id: "c1", name: "Test Co" },
      });
    }
    if (p === "/company/members" && !method) return Promise.resolve(members);
    if (p === "/company/invites" && !method) return Promise.resolve([]);
    return Promise.reject(new Error(`unexpected apiFetch call in test: ${p} ${method ?? "GET"}`));
  });
}

function renderTeam() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <Team />
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("<Team/>", () => {
  it("renders members with their role and status, using backend-provided data only", async () => {
    mockApi("owner", [ownerMember, activeMember]);
    renderTeam();
    await waitFor(() => expect(screen.getByText("عضو نشط")).toBeInTheDocument());
    expect(screen.getAllByText("نشط").length).toBeGreaterThan(0);
  });

  it("an owner sees role-change and status-toggle controls for a member", async () => {
    mockApi("owner", [ownerMember, activeMember]);
    renderTeam();
    await waitFor(() => expect(screen.getByText("عضو نشط")).toBeInTheDocument());
    const row = within(screen.getByText("عضو نشط").closest("li")!);
    expect(row.getByText("إلغاء التفعيل")).toBeInTheDocument();
    expect(row.getByRole("combobox")).toBeInTheDocument();
  });

  it("a member does NOT see role-change or status-toggle controls (company.manage is owner-only)", async () => {
    mockApi("member", [ownerMember, activeMember]);
    renderTeam();
    await waitFor(() => expect(screen.getByText("عضو نشط")).toBeInTheDocument());
    expect(screen.queryByText("إلغاء التفعيل")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("clicking the deactivate control sends PATCH status:deactivated for that member", async () => {
    mockApi("owner", [ownerMember, activeMember]);
    renderTeam();
    await waitFor(() => expect(screen.getByText("عضو نشط")).toBeInTheDocument());

    let captured: { path: string; body: unknown } | null = null;
    vi.mocked(apiFetch).mockImplementation((path: unknown, opts?: RequestInit) => {
      const p = String(path);
      const method = opts?.method;
      if (p === "/auth/me") return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "c1", name: "Test Co" } });
      if (p === "/company/members" && !method) return Promise.resolve([ownerMember, activeMember]);
      if (p === "/company/invites" && !method) return Promise.resolve([]);
      if (p === "/company/members/u2" && method === "PATCH") {
        captured = { path: p, body: JSON.parse(opts!.body as string) };
        return Promise.resolve({ ...activeMember, status: "deactivated" });
      }
      return Promise.reject(new Error(`unexpected: ${p} ${method}`));
    });

    const row = within(screen.getByText("عضو نشط").closest("li")!);
    fireEvent.click(row.getByText("إلغاء التفعيل"));

    await waitFor(() => expect(captured).toEqual({ path: "/company/members/u2", body: { status: "deactivated" } }));
  });

  it("changing the role select sends PATCH role for that member", async () => {
    mockApi("owner", [ownerMember, activeMember]);
    renderTeam();
    await waitFor(() => expect(screen.getByText("عضو نشط")).toBeInTheDocument());

    let captured: { path: string; body: unknown } | null = null;
    vi.mocked(apiFetch).mockImplementation((path: unknown, opts?: RequestInit) => {
      const p = String(path);
      const method = opts?.method;
      if (p === "/auth/me") return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "c1", name: "Test Co" } });
      if (p === "/company/members" && !method) return Promise.resolve([ownerMember, activeMember]);
      if (p === "/company/invites" && !method) return Promise.resolve([]);
      if (p === "/company/members/u2" && method === "PATCH") {
        captured = { path: p, body: JSON.parse(opts!.body as string) };
        return Promise.resolve({ ...activeMember, role: "owner" });
      }
      return Promise.reject(new Error(`unexpected: ${p} ${method}`));
    });

    const row = within(screen.getByText("عضو نشط").closest("li")!);
    fireEvent.change(row.getByRole("combobox"), { target: { value: "owner" } });

    await waitFor(() => expect(captured).toEqual({ path: "/company/members/u2", body: { role: "owner" } }));
  });

  // Recovered — the invite success message previously ignored the
  // backend's emailDelivered field and always showed a dev-facing "check
  // server logs" message, even when a real mail provider delivered the
  // invite. It must never claim delivery the backend didn't confirm.
  it("shows a real success message when the backend confirms emailDelivered: true", async () => {
    mockApi("owner", [ownerMember]);
    renderTeam();
    await waitFor(() => expect(screen.getByText("المالك")).toBeInTheDocument());

    vi.mocked(apiFetch).mockImplementation((path: unknown, opts?: RequestInit) => {
      const p = String(path);
      const method = opts?.method;
      if (p === "/auth/me") return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "c1", name: "Test Co" } });
      if (p === "/company/members" && !method) return Promise.resolve([ownerMember]);
      if (p === "/company/invites" && !method) return Promise.resolve([]);
      if (p === "/company/invites" && method === "POST") return Promise.resolve({ id: "inv1", email: "new@test.com", emailDelivered: true });
      return Promise.reject(new Error(`unexpected: ${p} ${method}`));
    });

    fireEvent.change(screen.getByPlaceholderText("البريد الإلكتروني"), { target: { value: "new@test.com" } });
    fireEvent.click(screen.getByText("إرسال دعوة"));

    await waitFor(() => expect(screen.getByText("أُرسلت الدعوة عبر البريد الإلكتروني.")).toBeInTheDocument());
    expect(screen.queryByText(/سجل الخادم/)).not.toBeInTheDocument();
  });

  it("shows an honest fallback message when emailDelivered: false, never claiming delivery", async () => {
    mockApi("owner", [ownerMember]);
    renderTeam();
    await waitFor(() => expect(screen.getByText("المالك")).toBeInTheDocument());

    vi.mocked(apiFetch).mockImplementation((path: unknown, opts?: RequestInit) => {
      const p = String(path);
      const method = opts?.method;
      if (p === "/auth/me") return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "c1", name: "Test Co" } });
      if (p === "/company/members" && !method) return Promise.resolve([ownerMember]);
      if (p === "/company/invites" && !method) return Promise.resolve([]);
      if (p === "/company/invites" && method === "POST") return Promise.resolve({ id: "inv1", email: "new@test.com", emailDelivered: false });
      return Promise.reject(new Error(`unexpected: ${p} ${method}`));
    });

    fireEvent.change(screen.getByPlaceholderText("البريد الإلكتروني"), { target: { value: "new@test.com" } });
    fireEvent.click(screen.getByText("إرسال دعوة"));

    await waitFor(() =>
      expect(
        screen.getByText("تعذّر إرسال البريد الإلكتروني — لم يتم إعداد مزوّد بريد حقيقي بعد. شارِكي رابط الدعوة يدوياً من سجلات الخادم."),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText("أُرسلت الدعوة عبر البريد الإلكتروني.")).not.toBeInTheDocument();
  });

  it("a rejected mutation (e.g. last-active-owner guard) shows the backend's error message inline", async () => {
    mockApi("owner", [ownerMember]);
    renderTeam();
    await waitFor(() => expect(screen.getByText("المالك")).toBeInTheDocument());

    vi.mocked(apiFetch).mockImplementation((path: unknown, opts?: RequestInit) => {
      const p = String(path);
      const method = opts?.method;
      if (p === "/auth/me") return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "c1", name: "Test Co" } });
      if (p === "/company/members" && !method) return Promise.resolve([ownerMember]);
      if (p === "/company/invites" && !method) return Promise.resolve([]);
      if (p === "/company/members/u1" && method === "PATCH") {
        return Promise.reject(new ApiError("لا يمكن أن تبقى الشركة بدون مالك واحد نشط على الأقل", 409));
      }
      return Promise.reject(new Error(`unexpected: ${p} ${method}`));
    });

    fireEvent.click(screen.getByText("إلغاء التفعيل"));
    await waitFor(() => expect(screen.getByText("لا يمكن أن تبقى الشركة بدون مالك واحد نشط على الأقل")).toBeInTheDocument());
  });
});
