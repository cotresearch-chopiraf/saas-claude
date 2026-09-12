import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ErrorBoundary } from "./ErrorBoundary";
import { I18nProvider } from "../i18n/I18nProvider";

function Bomb(): never {
  throw new Error("boom");
}

describe("<ErrorBoundary/>", () => {
  it("renders children normally when nothing throws", () => {
    render(
      <I18nProvider>
        <ErrorBoundary>
          <p>محتوى طبيعي</p>
        </ErrorBoundary>
      </I18nProvider>,
    );
    expect(screen.getByText("محتوى طبيعي")).toBeInTheDocument();
  });

  it("catches a render-time exception and shows the fallback instead of a blank screen", () => {
    // React logs the caught error to the console by default; silence it for
    // this expected-failure test only, then restore.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(
        <I18nProvider>
          <ErrorBoundary>
            <Bomb />
          </ErrorBoundary>
        </I18nProvider>,
      );
      expect(screen.getByText("حدث خطأ غير متوقع")).toBeInTheDocument();
      expect(screen.getByText("إعادة تحميل الصفحة")).toBeInTheDocument();
    } finally {
      consoleError.mockRestore();
    }
  });
});
