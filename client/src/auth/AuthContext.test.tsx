import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { AuthProvider, useAuth } from "./AuthContext";

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return { ...actual, getToken: vi.fn(), setToken: vi.fn(), apiFetch: vi.fn() };
});

import { apiFetch, getToken, setToken, ApiError } from "../api/client";

function Probe() {
  const { user, company, loading, logout } = useAuth();
  return (
    <div>
      <span data-testid="loading">{String(loading)}</span>
      <span data-testid="user">{user ? `${user.email}:${user.role}` : "none"}</span>
      <span data-testid="company">{company ? company.name : "none"}</span>
      <button onClick={logout}>logout</button>
    </div>
  );
}

function renderProbe() {
  return render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
}

describe("<AuthProvider/> session-error classification", () => {
  // No clearMocks/restoreMocks configured in vitest.config.ts, so mock call
  // history (setToken's calls in particular) would otherwise leak across
  // tests in this file.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("a successful /auth/me populates user (with role) and company", async () => {
    vi.mocked(getToken).mockReturnValue("existing-token");
    vi.mocked(apiFetch).mockResolvedValue({
      user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" },
      company: { id: "c1", name: "Test Co" },
    });

    renderProbe();

    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("false"));
    expect(screen.getByTestId("user").textContent).toBe("t@test.com:owner");
    expect(screen.getByTestId("company").textContent).toBe("Test Co");
  });

  it("a 401 from /auth/me clears the token — the session really is invalid", async () => {
    vi.mocked(getToken).mockReturnValue("stale-token");
    vi.mocked(apiFetch).mockRejectedValue(new ApiError("جلسة غير صالحة", 401));

    renderProbe();

    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("false"));
    expect(screen.getByTestId("user").textContent).toBe("none");
    expect(setToken).toHaveBeenCalledWith(null);
  });

  it("a 429 (rate limited) from /auth/me does NOT clear a possibly-valid token", async () => {
    vi.mocked(getToken).mockReturnValue("valid-token");
    vi.mocked(apiFetch).mockRejectedValue(new ApiError("محاولات كثيرة جداً", 429));

    renderProbe();

    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("false"));
    expect(screen.getByTestId("user").textContent).toBe("none");
    expect(setToken).not.toHaveBeenCalled();
  });

  it("a 500 from /auth/me does NOT clear a possibly-valid token", async () => {
    vi.mocked(getToken).mockReturnValue("valid-token");
    vi.mocked(apiFetch).mockRejectedValue(new ApiError("خطأ في الخادم", 500));

    renderProbe();

    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("false"));
    expect(screen.getByTestId("user").textContent).toBe("none");
    expect(setToken).not.toHaveBeenCalled();
  });

  it("a network/transient failure (not an ApiError at all) does NOT clear a possibly-valid token", async () => {
    vi.mocked(getToken).mockReturnValue("valid-token");
    vi.mocked(apiFetch).mockRejectedValue(new TypeError("Failed to fetch"));

    renderProbe();

    await waitFor(() => expect(screen.getByTestId("loading").textContent).toBe("false"));
    expect(screen.getByTestId("user").textContent).toBe("none");
    expect(setToken).not.toHaveBeenCalled();
  });

  it("logout() still intentionally clears the session", async () => {
    vi.mocked(getToken).mockReturnValue("existing-token");
    vi.mocked(apiFetch).mockResolvedValue({
      user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" },
      company: { id: "c1", name: "Test Co" },
    });

    renderProbe();
    await waitFor(() => expect(screen.getByTestId("user").textContent).toBe("t@test.com:owner"));

    fireEvent.click(screen.getByText("logout"));

    expect(setToken).toHaveBeenCalledWith(null);
    expect(screen.getByTestId("user").textContent).toBe("none");
    expect(screen.getByTestId("company").textContent).toBe("none");
  });
});
