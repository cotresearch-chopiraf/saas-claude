import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AuthProvider } from "./AuthContext";
import { Can } from "./Can";

// Drives AuthProvider through its real bootstrap path (GET /auth/me) with
// only the network call mocked, rather than inventing a second way to
// inject auth state — so this test exercises the exact same code path a
// real page does.
vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return {
    ...actual,
    getToken: () => "fake-token",
    apiFetch: vi.fn(),
  };
});

import { apiFetch } from "../api/client";

function mockMeAs(role: "owner" | "member") {
  vi.mocked(apiFetch).mockResolvedValue({
    user: { id: "u1", name: "Test User", email: "t@test.com", role },
    company: { id: "c1", name: "Test Co" },
  });
}

describe("<Can/> — RBAC UI visibility", () => {
  it("an owner sees an owner-gated action", async () => {
    mockMeAs("owner");
    render(
      <AuthProvider>
        <Can permission="ipc.manage">
          <button>اعتماد الشهادة</button>
        </Can>
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText("اعتماد الشهادة")).toBeInTheDocument());
  });

  it("a member does not see an owner-gated action (hidden, not merely disabled)", async () => {
    mockMeAs("member");
    render(
      <AuthProvider>
        <Can permission="ipc.manage">
          <button>اعتماد الشهادة</button>
        </Can>
      </AuthProvider>,
    );
    // Wait for the auth bootstrap to actually settle before asserting
    // absence, otherwise this would trivially pass before /auth/me
    // resolves at all.
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(screen.queryByText("اعتماد الشهادة")).not.toBeInTheDocument();
  });
});
