import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import type { ReactNode } from "react";

export function Layout({ children }: { children: ReactNode }) {
  const { user, company, logout } = useAuth();

  return (
    <div className="min-h-screen bg-stone-50" dir="rtl">
      <header className="border-b border-stone-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <Link to="/" className="text-lg font-bold text-primary">
            {company?.name ?? "نظام تشغيل المقاولين"}
          </Link>
          {user && (
            <div className="flex items-center gap-4 text-sm text-stone-600">
              <span>{user.name}</span>
              <button onClick={logout} className="text-stone-400 hover:text-stone-700">
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
