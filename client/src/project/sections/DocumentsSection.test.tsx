import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { AuthProvider } from "../../auth/AuthContext";
import { I18nProvider } from "../../i18n/I18nProvider";
import { DocumentsSection } from "./DocumentsSection";
import type { ProjectDocument } from "../../api/types";

vi.mock("../context", () => ({
  useProjectContext: () => ({ project: null, projectId: "p1" }),
}));

vi.mock("../../api/client", async () => {
  const actual = await vi.importActual<typeof import("../../api/client")>("../../api/client");
  return { ...actual, getToken: () => "fake-token", apiFetch: vi.fn() };
});

import { apiFetch } from "../../api/client";

// Globally unique values — the list can render several documents
// simultaneously.
const fixtureDocA: ProjectDocument = {
  id: "doc-alpha-1",
  fileName: "عقد-التوريد-الأساسي.pdf",
  mimeType: "application/pdf",
  size: 154_213,
  uploadedAt: "2026-01-05T00:00:00.000Z",
  uploadedByName: "أحمد المالك",
  version: 1,
  previousVersionId: null,
  clientVisible: false,
};

const fixtureDocB: ProjectDocument = {
  id: "doc-beta-2",
  fileName: "صورة-الموقع-٢.png",
  mimeType: "image/png",
  size: 2_512_890,
  uploadedAt: "2026-01-12T00:00:00.000Z",
  uploadedByName: "سارة العضو",
  version: 1,
  previousVersionId: null,
  clientVisible: false,
};

const LONG_NAME =
  "تقرير-فحص-الموقع-الشامل-الذي-يحتوي-على-تفاصيل-كثيرة-جداً-عن-حالة-الأساسات-والخرسانة-والتمديدات-الكهربائية-والصحية-في-المشروع.pdf";

const fixtureDocLongName: ProjectDocument = {
  id: "doc-gamma-3",
  fileName: LONG_NAME,
  mimeType: "application/pdf",
  size: 998_001,
  uploadedAt: "2026-01-20T00:00:00.000Z",
  uploadedByName: null,
  version: 1,
  previousVersionId: null,
  clientVisible: false,
};

function mockApi(documents: ProjectDocument[] = [fixtureDocA]) {
  vi.mocked(apiFetch).mockImplementation((path: unknown) => {
    const p = String(path);
    if (p === "/auth/me") {
      return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "co1", name: "Test Co" } });
    }
    if (p === "/projects/p1/documents") return Promise.resolve(documents);
    return Promise.reject(new Error(`unexpected apiFetch call in test: ${p}`));
  });
}

function renderSection() {
  return render(
    <I18nProvider>
      <AuthProvider>
        <DocumentsSection />
      </AuthProvider>
    </I18nProvider>,
  );
}

function pdfFile(name = "site-report.pdf", size = 1024): File {
  const file = new File([new Uint8Array(size)], name, { type: "application/pdf" });
  return file;
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("unexpected global fetch call in test"))),
  );
});

describe("<DocumentsSection/>", () => {
  it("renders the project's documents from the backend", async () => {
    mockApi([fixtureDocA]);
    renderSection();
    await waitFor(() => expect(screen.getByText(fixtureDocA.fileName)).toBeInTheDocument());
    expect(screen.getByText("application/pdf")).toBeInTheDocument();
    expect(screen.getByText("أحمد المالك")).toBeInTheDocument();
  });

  it("renders multiple documents simultaneously", async () => {
    mockApi([fixtureDocA, fixtureDocB]);
    renderSection();
    await waitFor(() => expect(screen.getByText(fixtureDocA.fileName)).toBeInTheDocument());
    expect(screen.getByText(fixtureDocB.fileName)).toBeInTheDocument();
  });

  it("shows an honest empty state when the project has no documents yet", async () => {
    mockApi([]);
    renderSection();
    await waitFor(() => expect(screen.getByText("لا توجد مستندات لهذا المشروع بعد")).toBeInTheDocument());
  });

  it("shows the loading skeleton before data arrives", async () => {
    let resolveList!: (docs: ProjectDocument[]) => void;
    const pending = new Promise<ProjectDocument[]>((resolve) => {
      resolveList = resolve;
    });
    vi.mocked(apiFetch).mockImplementation((path: unknown) => {
      const p = String(path);
      if (p === "/auth/me") return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "co1", name: "Test Co" } });
      if (p === "/projects/p1/documents") return pending;
      return Promise.reject(new Error(`unexpected apiFetch call: ${p}`));
    });
    renderSection();
    await waitFor(() => expect(screen.getByRole("status")).toBeInTheDocument());
    resolveList([fixtureDocA]);
    await waitFor(() => expect(screen.getByText(fixtureDocA.fileName)).toBeInTheDocument());
  });

  it("shows an honest, retryable error state on API failure, not a fabricated empty list", async () => {
    vi.mocked(apiFetch).mockImplementation((path: unknown) => {
      const p = String(path);
      if (p === "/auth/me") return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "co1", name: "Test Co" } });
      if (p === "/projects/p1/documents") return Promise.reject(new Error("تعذّر الاتصال بالخادم"));
      return Promise.reject(new Error(`unexpected apiFetch call: ${p}`));
    });
    renderSection();
    await waitFor(() => expect(screen.getByText("تعذّر الاتصال بالخادم")).toBeInTheDocument());
    // Only one error surface — never a duplicate from both the standalone
    // banner and FinancialTable's own built-in error state.
    expect(screen.getAllByText("تعذّر الاتصال بالخادم")).toHaveLength(1);
  });

  it("renders the upload control with allowed types and max size stated", async () => {
    mockApi([]);
    renderSection();
    await waitFor(() => expect(screen.getByText("لا توجد مستندات لهذا المشروع بعد")).toBeInTheDocument());
    expect(screen.getByText(/PDF/)).toBeInTheDocument();
    expect(screen.getByText(/10 ميجابايت/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "رفع" })).toBeInTheDocument();
  });

  it("accepts a supported file: selecting it clears validation and shows its name/size", async () => {
    mockApi([]);
    renderSection();
    await waitFor(() => expect(screen.getByText("لا توجد مستندات لهذا المشروع بعد")).toBeInTheDocument());

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = pdfFile("valid-doc.pdf", 2048);
    fireEvent.change(input, { target: { files: [file] } });

    expect(screen.getByText(/valid-doc\.pdf/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "رفع" })).not.toBeDisabled();
  });

  it("rejects an unsupported file type client-side, before any request is sent", async () => {
    mockApi([]);
    renderSection();
    await waitFor(() => expect(screen.getByText("لا توجد مستندات لهذا المشروع بعد")).toBeInTheDocument());

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const badFile = new File(["exe content"], "installer.exe", { type: "application/x-msdownload" });
    fireEvent.change(input, { target: { files: [badFile] } });

    expect(screen.getByText(/نوع الملف غير مسموح به/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "رفع" })).toBeDisabled();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("rejects an oversized file client-side, before any request is sent", async () => {
    mockApi([]);
    renderSection();
    await waitFor(() => expect(screen.getByText("لا توجد مستندات لهذا المشروع بعد")).toBeInTheDocument());

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const hugeFile = pdfFile("huge.pdf", 10 * 1024 * 1024 + 1);
    fireEvent.change(input, { target: { files: [hugeFile] } });

    expect(screen.getByText(/يتجاوز الحد الأقصى/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "رفع" })).toBeDisabled();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("a successful upload refreshes the document list with the backend's own response", async () => {
    mockApi([]);
    renderSection();
    await waitFor(() => expect(screen.getByText("لا توجد مستندات لهذا المشروع بعد")).toBeInTheDocument());

    const uploaded: ProjectDocument = { ...fixtureDocA, id: "doc-new-9" };
    vi.mocked(fetch).mockImplementation((url: unknown) => {
      const u = String(url);
      if (u === "/api/projects/p1/documents") {
        return Promise.resolve(new Response(JSON.stringify(uploaded), { status: 201 })) as unknown as Promise<Response>;
      }
      return Promise.reject(new Error(`unexpected fetch: ${u}`));
    });
    // Next list read (after upload) returns the new document.
    vi.mocked(apiFetch).mockImplementation((path: unknown) => {
      const p = String(path);
      if (p === "/auth/me") return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "co1", name: "Test Co" } });
      if (p === "/projects/p1/documents") return Promise.resolve([uploaded]);
      return Promise.reject(new Error(`unexpected apiFetch: ${p}`));
    });

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [pdfFile("valid-doc.pdf", 2048)] } });
    fireEvent.click(screen.getByRole("button", { name: "رفع" }));

    await waitFor(() => expect(screen.getByText(uploaded.fileName)).toBeInTheDocument());
  });

  it("prevents a duplicate upload from a rapid double-click", async () => {
    mockApi([]);
    renderSection();
    await waitFor(() => expect(screen.getByText("لا توجد مستندات لهذا المشروع بعد")).toBeInTheDocument());

    let resolveUpload!: (r: Response) => void;
    const pendingUpload = new Promise<Response>((resolve) => {
      resolveUpload = resolve;
    });
    vi.mocked(fetch).mockImplementation((url: unknown) => {
      const u = String(url);
      if (u === "/api/projects/p1/documents") return pendingUpload;
      return Promise.reject(new Error(`unexpected fetch: ${u}`));
    });

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [pdfFile("valid-doc.pdf", 2048)] } });

    fireEvent.click(screen.getByRole("button", { name: "رفع" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "جارٍ الرفع..." })).toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "جارٍ الرفع..." }));

    expect(vi.mocked(fetch).mock.calls.filter((c) => String(c[0]) === "/api/projects/p1/documents")).toHaveLength(1);

    resolveUpload(new Response(JSON.stringify({ ...fixtureDocA, id: "doc-x" }), { status: 201 }));
    await waitFor(() => expect(screen.getByRole("button", { name: "رفع" })).toBeInTheDocument());
  });

  it("the download action fetches the authenticated binary route with the current project/document id", async () => {
    mockApi([fixtureDocA]);
    renderSection();
    await waitFor(() => expect(screen.getByText(fixtureDocA.fileName)).toBeInTheDocument());

    vi.mocked(fetch).mockResolvedValue(new Response(new Blob(["pdf-bytes"]), { status: 200 }));
    fireEvent.click(screen.getByRole("button", { name: "تنزيل" }));

    await waitFor(() =>
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        `/api/projects/p1/documents/${fixtureDocA.id}`,
        expect.objectContaining({ headers: { Authorization: "Bearer fake-token" } }),
      ),
    );
  });

  it("MIDAD Phase B3 — toggling the client-visibility checkbox PATCHes the document and reflects the server's response", async () => {
    mockApi([fixtureDocA]);
    renderSection();
    await waitFor(() => expect(screen.getByText(fixtureDocA.fileName)).toBeInTheDocument());

    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    vi.mocked(apiFetch).mockImplementation((path: unknown, options?: unknown) => {
      const p = String(path);
      const opts = options as { method?: string; body?: string } | undefined;
      if (p === "/auth/me") return Promise.resolve({ user: { id: "u1", name: "Test", email: "t@test.com", role: "owner" }, company: { id: "co1", name: "Test Co" } });
      if (p === `/projects/p1/documents/${fixtureDocA.id}` && opts?.method === "PATCH") {
        expect(JSON.parse(opts.body!)).toEqual({ clientVisible: true });
        return Promise.resolve({ ...fixtureDocA, clientVisible: true });
      }
      return Promise.reject(new Error(`unexpected apiFetch call in test: ${p}`));
    });

    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox.checked).toBe(true));
  });

  it("a very long filename is truncated rather than breaking the layout", async () => {
    mockApi([fixtureDocLongName]);
    renderSection();
    await waitFor(() => expect(screen.getByTitle(LONG_NAME)).toBeInTheDocument());
    expect(screen.getByTitle(LONG_NAME).className).toContain("truncate");
    // Missing uploader is displayed honestly as "—", never fabricated.
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
