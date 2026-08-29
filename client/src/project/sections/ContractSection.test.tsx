import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AuthProvider } from "../../auth/AuthContext";
import { ContractSection } from "./ContractSection";
import type { Contract } from "../../api/types";

vi.mock("../context", () => ({
  useProjectContext: () => ({ project: null, projectId: "p1" }),
}));

vi.mock("../../api/client", async () => {
  const actual = await vi.importActual<typeof import("../../api/client")>("../../api/client");
  return { ...actual, getToken: () => "fake-token", apiFetch: vi.fn() };
});

import { apiFetch } from "../../api/client";

const fixtureContract: Contract = {
  id: "contract-1",
  companyId: "c1",
  projectId: "p1",
  contractType: "main",
  parentContractId: null,
  contractNumber: "C-1001",
  clientName: "Acme Construction",
  originalValue: "500000.00",
  revisedValue: "520000.00",
  currency: "SAR",
  advancePercent: "10.00",
  retentionPercent: "5.00",
  paymentTerms: "Net 30",
  status: "active",
  startDate: "2026-01-01",
  endDate: null,
  createdBy: "u1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function mockApi(role: "owner" | "member", contracts: Contract[]) {
  vi.mocked(apiFetch).mockImplementation((path: unknown, opts?: RequestInit) => {
    const p = String(path);
    if (p === "/auth/me") {
      return Promise.resolve({
        user: { id: "u1", name: "Test", email: "t@test.com", role },
        company: { id: "c1", name: "Test Co" },
      });
    }
    if (p === "/projects/p1/contracts" && (!opts || !opts.method)) {
      return Promise.resolve(contracts);
    }
    return Promise.reject(new Error(`unexpected apiFetch call in test: ${p}`));
  });
}

describe("<ContractSection/>", () => {
  it("renders contract data using backend-provided values (never recomputed)", async () => {
    mockApi("owner", [fixtureContract]);
    render(
      <AuthProvider>
        <ContractSection />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText("C-1001")).toBeInTheDocument());
    expect(screen.getByText("Acme Construction")).toBeInTheDocument();
    // Both amounts appear (table row + detail panel) — assert at least one
    // occurrence of each, proving the backend's originalValue/revisedValue
    // are shown distinctly, never collapsed into one figure.
    expect(screen.getAllByText(/500,000/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/520,000/).length).toBeGreaterThan(0);
  });

  it("an owner sees the contract mutation control", async () => {
    mockApi("owner", [fixtureContract]);
    render(
      <AuthProvider>
        <ContractSection />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText("+ عقد جديد")).toBeInTheDocument());
  });

  it("a member does not see the contract mutation control", async () => {
    mockApi("member", [fixtureContract]);
    render(
      <AuthProvider>
        <ContractSection />
      </AuthProvider>,
    );
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText("C-1001")).toBeInTheDocument());
    expect(screen.queryByText("+ عقد جديد")).not.toBeInTheDocument();
  });

  it("shows an honest empty state when the project has no contracts yet", async () => {
    mockApi("owner", []);
    render(
      <AuthProvider>
        <ContractSection />
      </AuthProvider>,
    );
    await waitFor(() => expect(screen.getByText("لا توجد عقود بعد")).toBeInTheDocument());
  });
});
