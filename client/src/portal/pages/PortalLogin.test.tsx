import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ClientPortalAuthProvider } from "../auth/ClientPortalAuthContext";
import { PortalLogin } from "./PortalLogin";

vi.mock("../api/portalClient", async () => {
  const actual = await vi.importActual<typeof import("../api/portalClient")>("../api/portalClient");
  return { ...actual, getPortalToken: () => null, portalApiFetch: vi.fn() };
});

import { portalApiFetch } from "../api/portalClient";

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={["/portal/login"]}>
      <ClientPortalAuthProvider>
        <PortalLogin />
      </ClientPortalAuthProvider>
    </MemoryRouter>,
  );
}

describe("<PortalLogin/>", () => {
  it("renders the login form, Arabic-first", () => {
    renderLogin();
    expect(screen.getByText("بوابة العميل")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("البريد الإلكتروني")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("كلمة المرور")).toBeInTheDocument();
  });

  it("a successful login replaces the form (redirects away)", async () => {
    vi.mocked(portalApiFetch).mockResolvedValue({
      token: "portal-token",
      user: { id: "cp1", name: "عميل تجريبي", email: "client@test.com" },
    });
    renderLogin();

    fireEvent.change(screen.getByPlaceholderText("البريد الإلكتروني"), { target: { value: "client@test.com" } });
    fireEvent.change(screen.getByPlaceholderText("كلمة المرور"), { target: { value: "pass1234" } });
    fireEvent.click(screen.getByRole("button", { name: "دخول" }));

    await waitFor(() => expect(screen.queryByPlaceholderText("البريد الإلكتروني")).not.toBeInTheDocument());
  });

  it("a failed login shows an error and keeps the form", async () => {
    const { ApiError } = await import("../../api/client");
    vi.mocked(portalApiFetch).mockRejectedValue(new ApiError("البريد الإلكتروني أو كلمة المرور غير صحيحة", 401));
    renderLogin();

    fireEvent.change(screen.getByPlaceholderText("البريد الإلكتروني"), { target: { value: "client@test.com" } });
    fireEvent.change(screen.getByPlaceholderText("كلمة المرور"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "دخول" }));

    await waitFor(() => expect(screen.getByText("البريد الإلكتروني أو كلمة المرور غير صحيحة")).toBeInTheDocument());
    expect(screen.getByPlaceholderText("البريد الإلكتروني")).toBeInTheDocument();
  });
});
