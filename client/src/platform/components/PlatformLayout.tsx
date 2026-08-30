import { Link } from "react-router-dom";
import type { ReactNode } from "react";
import { usePlatformAuth } from "../auth/PlatformAuthContext";

// Deliberately its own layout, not ../../components/Layout.tsx: a
// tenant-shaped header (company name, tenant nav links, tenant logout)
// must never appear on a platform-operator screen, and vice versa.
export function PlatformLayout({ children }: { children: ReactNode }) {
  const { operator, logout } = usePlatformAuth();

  return (
    <div className="min-h-screen bg-stone-50" dir="rtl">
      <header className="border-b border-stone-200 bg-stone-800">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-6 py-4">
          <Link to="/platform/organizations" className="text-lg font-bold text-white">
            لوحة تشغيل المنصة
          </Link>
          {operator && (
            <div className="flex items-center gap-4 text-sm text-stone-300">
              <span>{operator.name}</span>
              <button onClick={logout} className="text-stone-400 hover:text-white">
                تسجيل الخروج
              </button>
            </div>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">{children}</main>
    </div>
  );
}
