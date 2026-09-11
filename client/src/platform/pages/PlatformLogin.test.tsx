import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { PlatformAuthProvider } from "../auth/PlatformAuthContext";
import { I18nProvider } from "../../i18n/I18nProvider";
import { PlatformLogin } from "./PlatformLogin";

vi.mock("../api/platformClient", async () => {
  const actual = await vi.importActual<typeof import("../api/platformClient")>("../api/platformClient");
  return { ...actual, getPlatformToken: () => null, platformApiFetch: vi.fn() };
});

import { platformApiFetch } from "../api/platformClient";

function renderLogin() {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={["/platform/login"]}>
        <PlatformAuthProvider>
          <PlatformLogin />
        </PlatformAuthProvider>
      </MemoryRouter>
    </I18nProvider>,
  );
}

describe("<PlatformLogin/>", () => {
  it("renders the login form", () => {
    renderLogin();
    expect(screen.getByPlaceholderText("البريد الإلكتروني")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("كلمة المرور")).toBeInTheDocument();
  });

  it("a successful login replaces the form (redirects away)", async () => {
    vi.mocked(platformApiFetch).mockResolvedValue({
      token: "platform-token",
      operator: { id: "op1", name: "Operator One", email: "op@midad.internal" },
    });
    renderLogin();

    fireEvent.change(screen.getByPlaceholderText("البريد الإلكتروني"), { target: { value: "op@midad.internal" } });
    fireEvent.change(screen.getByPlaceholderText("كلمة المرور"), { target: { value: "pass1234" } });
    fireEvent.click(screen.getByRole("button", { name: "دخول" }));

    await waitFor(() => expect(screen.queryByPlaceholderText("البريد الإلكتروني")).not.toBeInTheDocument());
  });

  it("a failed login shows an error and keeps the form", async () => {
    const { ApiError } = await import("../../api/client");
    vi.mocked(platformApiFetch).mockRejectedValue(new ApiError("البريد الإلكتروني أو كلمة المرور غير صحيحة", 401));
    renderLogin();

    fireEvent.change(screen.getByPlaceholderText("البريد الإلكتروني"), { target: { value: "op@midad.internal" } });
    fireEvent.change(screen.getByPlaceholderText("كلمة المرور"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "دخول" }));

    await waitFor(() => expect(screen.getByText("البريد الإلكتروني أو كلمة المرور غير صحيحة")).toBeInTheDocument());
    expect(screen.getByPlaceholderText("البريد الإلكتروني")).toBeInTheDocument();
  });
});
