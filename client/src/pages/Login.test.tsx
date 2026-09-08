import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "../auth/AuthContext";
import { Login } from "./Login";

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return { ...actual, getToken: () => null, setToken: vi.fn(), apiFetch: vi.fn() };
});

import { apiFetch } from "../api/client";

function ProtectedProbe() {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Navigate to="/login" replace />;
  return <div>DASHBOARD:{user.role}</div>;
}

function renderApp() {
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<ProtectedProbe />} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

// Phase 3.2 P0 remediation (LOGIN-001) — the production/customer-facing
// login screen must never pre-fill or expose a usable set of credentials.
// These assert the actual rendered <input> values (the real mechanism a
// browser and a user would see), not a source-text search for the old
// literals.
describe("<Login/> production credential exposure", () => {
  it("renders with empty email and password fields, not a pre-filled demo account", () => {
    renderApp();

    const emailInput = screen.getByLabelText("البريد الإلكتروني") as HTMLInputElement;
    const passwordInput = screen.getByLabelText("كلمة المرور") as HTMLInputElement;

    expect(emailInput.value).toBe("");
    expect(passwordInput.value).toBe("");
    expect(emailInput.value).not.toBe("demo@contractor-os.test");
    expect(passwordInput.value).not.toBe("demo1234");
  });

  it("normal login still works: typed credentials are what gets submitted, not any hardcoded value", async () => {
    vi.mocked(apiFetch).mockImplementation((path: unknown, opts?: RequestInit) => {
      const p = String(path);
      if (p === "/auth/login" && opts?.method === "POST") {
        const body = JSON.parse(opts.body as string) as { email: string; password: string };
        expect(body.email).toBe("real.owner@example.com");
        expect(body.password).toBe("theirRealPassword1");
        return Promise.resolve({ token: "real-token", user: { id: "u1", name: "Owner", email: body.email } });
      }
      if (p === "/auth/me") {
        return Promise.resolve({
          user: { id: "u1", name: "Owner", email: "real.owner@example.com", role: "owner" },
          company: { id: "c1", name: "Real Co" },
        });
      }
      return Promise.reject(new Error(`unexpected apiFetch call: ${p}`));
    });

    renderApp();

    fireEvent.change(screen.getByLabelText("البريد الإلكتروني"), { target: { value: "real.owner@example.com" } });
    fireEvent.change(screen.getByLabelText("كلمة المرور"), { target: { value: "theirRealPassword1" } });
    fireEvent.click(screen.getByRole("button", { name: "دخول" }));

    await waitFor(() => expect(screen.getByText("DASHBOARD:owner")).toBeInTheDocument());
  });
});
