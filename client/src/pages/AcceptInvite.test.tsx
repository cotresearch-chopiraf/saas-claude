import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "../auth/AuthContext";
import { AcceptInvite } from "./AcceptInvite";

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return { ...actual, getToken: () => null, setToken: vi.fn(), apiFetch: vi.fn() };
});

import { apiFetch, setToken } from "../api/client";

// Mirrors App.tsx's real ProtectedRoute exactly (loading -> null, no user ->
// /login, else render) — the actual regression scenario this finding
// describes (a freshly-authenticated member incorrectly bounced to
// /login) can only be verified against this real gating logic, not a
// simplified stand-in.
function ProtectedProbe() {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  return <div>DASHBOARD:{user.role}</div>;
}

function renderApp() {
  return render(
    <MemoryRouter initialEntries={["/accept-invite?token=abc123"]}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<div>LOGIN_PAGE</div>} />
          <Route path="/accept-invite" element={<AcceptInvite />} />
          <Route path="/" element={<ProtectedProbe />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe("<AcceptInvite/> session synchronization", () => {
  it("establishes authentication and syncs role through the canonical /auth/me path, landing authenticated (never bounced to /login)", async () => {
    vi.mocked(apiFetch).mockImplementation((path: unknown, opts?: RequestInit) => {
      const p = String(path);
      if (p === "/auth/accept-invite" && opts?.method === "POST") {
        return Promise.resolve({ token: "fresh-token", user: { id: "u1", name: "Member", email: "m@test.com" } });
      }
      if (p === "/auth/me") {
        return Promise.resolve({
          user: { id: "u1", name: "Member", email: "m@test.com", role: "member" },
          company: { id: "c1", name: "Test Co" },
        });
      }
      return Promise.reject(new Error(`unexpected apiFetch call: ${p}`));
    });

    renderApp();

    fireEvent.change(screen.getByLabelText("اسمك"), { target: { value: "Member" } });
    fireEvent.change(screen.getByLabelText("كلمة المرور"), { target: { value: "password123" } });
    fireEvent.click(screen.getByRole("button", { name: "انضمام" }));

    await waitFor(() => expect(setToken).toHaveBeenCalledWith("fresh-token"));

    // The invited member's role, populated via /auth/me — never parsed
    // from accept-invite's own (role-less) response.
    await waitFor(() => expect(screen.getByText("DASHBOARD:member")).toBeInTheDocument());

    // Never redirected to /login — the historical bug this test guards
    // against.
    expect(screen.queryByText("LOGIN_PAGE")).not.toBeInTheDocument();

    // /auth/me really was the mechanism used, not a second parse of
    // accept-invite's response.
    expect(apiFetch).toHaveBeenCalledWith("/auth/me");
  });
});
