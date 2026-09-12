import { Link } from "react-router-dom";
import type { ReactNode } from "react";
import { useClientPortalAuth } from "../auth/ClientPortalAuthContext";
import { useTranslation } from "../../i18n/I18nProvider";
import { LanguageSwitcher } from "../../i18n/LanguageSwitcher";

// MIDAD Phase B2 — deliberately its own layout, not ../../components/
// Layout.tsx or ../../platform/components/PlatformLayout.tsx: a
// tenant-shaped or platform-shaped header must never appear on a Client
// Portal screen, and vice versa. Intentionally simpler than the internal
// company Layout — this phase ships exactly one destination (the project
// list/dashboard), so the header carries no extra nav links yet; see this
// phase's own scope note against adding dead links for modules not built
// yet (Documents/IPC/Invoices/Progress).
export function PortalLayout({ children }: { children: ReactNode }) {
  const { portalUser, logout } = useClientPortalAuth();
  const { t, direction } = useTranslation();

  return (
    <div className="min-h-screen bg-stone-50" dir={direction}>
      <header className="border-b border-stone-200 bg-stone-800">
        <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <Link to="/portal" className="flex flex-col leading-tight text-white">
            <span className="text-base font-bold">MIDAD</span>
            <span className="text-xs text-stone-300">{t("portalLayout.tagline")}</span>
          </Link>
          <div className="flex items-center gap-4 text-sm text-stone-300">
            <LanguageSwitcher />
            {portalUser && (
              <>
                <span>{portalUser.name}</span>
                <button onClick={logout} className="text-stone-400 hover:text-white">
                  {t("nav.logout")}
                </button>
              </>
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-8">{children}</main>
    </div>
  );
}
