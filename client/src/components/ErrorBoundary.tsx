import { Component, type ErrorInfo, type ReactNode } from "react";
import { useTranslation } from "../i18n/I18nProvider";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

function ErrorBoundaryFallback() {
  const { t, direction } = useTranslation();
  return (
    <div dir={direction} className="flex min-h-screen items-center justify-center bg-stone-50 px-6 text-center">
      <div className="max-w-sm">
        <p className="mb-2 text-lg font-semibold text-stone-800">{t("common.errorGeneric")}</p>
        <p className="mb-6 text-sm text-stone-500">{t("errorBoundary.description")}</p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white"
        >
          {t("errorBoundary.reloadButton")}
        </button>
      </div>
    </div>
  );
}

// P1 remediation (Final Pre-Launch Audit) — this app previously had no
// error boundary anywhere (client/src/App.tsx wraps <Routes> directly), so
// any unhandled render-time exception during a real user's first-day
// workflow produced a blank white screen with no messaging and no
// recovery path. This is the minimum a production React app needs: catch
// the crash, show something, offer a reload. It does not attempt
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
      return <ErrorBoundaryFallback />;
    }
    return this.props.children;
  }
}
