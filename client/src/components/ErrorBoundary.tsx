import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

// P1 remediation (Final Pre-Launch Audit) — this app previously had no
// error boundary anywhere (client/src/App.tsx wraps <Routes> directly), so
// any unhandled render-time exception during a real user's first-day
// workflow produced a blank white screen with no Arabic messaging and no
// recovery path. This is the minimum a production React app needs: catch
// the crash, show something in Arabic, offer a reload. It does not attempt
// to recover in place (React itself cannot safely resume a tree that threw
// during render) or report to an error-tracking service (none is
// configured anywhere in this repository — see docs/PRODUCTION_LAUNCH_CHECKLIST.md).
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error("Unhandled render error", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div dir="rtl" className="flex min-h-screen items-center justify-center bg-stone-50 px-6 text-center">
          <div className="max-w-sm">
            <p className="mb-2 text-lg font-semibold text-stone-800">حدث خطأ غير متوقع</p>
            <p className="mb-6 text-sm text-stone-500">
              تعذّر عرض هذه الصفحة. حاول إعادة تحميلها؛ إذا استمرت المشكلة، تواصل مع الدعم الفني.
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white"
            >
              إعادة تحميل الصفحة
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
