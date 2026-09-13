import { Link } from "react-router-dom";
import type { ReactNode } from "react";
import { usePlatformAuth } from "../auth/PlatformAuthContext";
import { useTranslation } from "../../i18n/I18nProvider";
import { LanguageSwitcher } from "../../i18n/LanguageSwitcher";

// Deliberately its own layout, not ../../components/Layout.tsx: a
// tenant-shaped header (company name, tenant nav links, tenant logout)
// must never appear on a platform-operator screen, and vice versa.
export function PlatformLayout({ children }: { children: ReactNode }) {
  const { operator, logout } = usePlatformAuth();
  const { t, direction } = useTranslation();

  return (
    <div className="min-h-screen bg-stone-50" dir={direction}>
      <header className="border-b border-stone-200 bg-stone-800">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-6 py-4">
          <Link to="/platform" className="text-lg font-bold text-white">
            {t("platformLayout.title")}
          </Link>
          <div className="flex items-center gap-4 text-sm text-stone-300">
            {operator && (
              <>
                <Link to="/platform" className="hover:text-white">
                  {t("platformLayout.dashboard")}
                </Link>
                <Link to="/platform/organizations" className="hover:text-white">
                  {t("platformLayout.organizations")}
                </Link>
                <Link to="/platform/support-sessions" className="hover:text-white">
                  {t("platformLayout.supportSessions")}
                </Link>
                <Link to="/platform/zatca" className="hover:text-white">
                  ZATCA
                </Link>
                <Link to="/platform/plans" className="hover:text-white">
                  {t("platformLayout.plans")}
                </Link>
                <Link to="/platform/feature-flags" className="hover:text-white">
                  {t("platformLayout.featureFlags")}
                </Link>
                <Link to="/platform/security" className="hover:text-white">
                  {t("platformLayout.security")}
                </Link>
                <Link to="/platform/incidents" className="hover:text-white">
                  {t("platformLayout.incidents")}
                </Link>
                <Link to="/platform/backup-center" className="hover:text-white">
                  {t("platformLayout.backupCenter")}
                </Link>
                <Link to="/platform/tenant-import" className="hover:text-white">
                  {t("platformLayout.tenantImport")}
                </Link>
                <Link to="/platform/ownership-transfer" className="hover:text-white">
                  {t("platformLayout.ownershipTransfer")}
                </Link>
                <Link to="/platform/handover" className="hover:text-white">
                  {t("platformLayout.handover")}
                </Link>
              </>
            )}
            <LanguageSwitcher />
            {operator && (
              <>
                <span>{operator.name}</span>
                <button onClick={logout} className="text-stone-400 hover:text-white">
                  {t("nav.logout")}
                </button>
              </>
            )}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
    </div>
  );
}
