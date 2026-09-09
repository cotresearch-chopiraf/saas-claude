import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { NotificationBell } from "./NotificationBell";
import type { ReactNode } from "react";

// fullWidth: pages that manage their own inner layout (currently only the
// project workspace, which has its own sidebar + content columns) opt out
// of the default centered max-w-5xl content column. Every other existing
// page (Dashboard, Quotes, Invoices, Team, Settings) is unaffected — they
// don't pass this prop, so they keep their exact previous layout.
export function Layout({ children, fullWidth = false }: { children: ReactNode; fullWidth?: boolean }) {
  const { user, company, logout } = useAuth();

  return (
    <div className="min-h-screen bg-stone-50" dir="rtl">
      <header className="border-b border-stone-200 bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-6 py-4">
          <div className="flex flex-wrap items-center gap-6">
            <Link to="/" className="text-lg font-bold text-primary">
              {company?.name ?? "نظام تشغيل المقاولين"}
            </Link>
            {user && (
              <nav className="flex flex-wrap items-center gap-4 text-sm text-stone-500">
                <Link to="/" className="hover:text-primary">المشاريع</Link>
                <Link to="/quotes" className="hover:text-primary">عروض الأسعار</Link>
                <Link to="/invoices" className="hover:text-primary">الفواتير</Link>
                <Link to="/customers" className="hover:text-primary">العملاء</Link>
                <Link to="/suppliers" className="hover:text-primary">الموردون</Link>
                <Link to="/employees" className="hover:text-primary">الموظفون</Link>
                <Link to="/payroll" className="hover:text-primary">الرواتب</Link>
                <Link to="/team" className="hover:text-primary">الفريق</Link>
                <Link to="/compliance" className="hover:text-primary">الامتثال الضريبي</Link>
                <Link to="/zatca" className="hover:text-primary">الفوترة الإلكترونية (ZATCA)</Link>
                <Link to="/activity" className="hover:text-primary">سجل النشاط</Link>
                <Link to="/settings" className="hover:text-primary">الإعدادات</Link>
              </nav>
            )}
          </div>
          {user && (
            <div className="flex items-center gap-4 text-sm text-stone-600">
              <NotificationBell />
              <span>{user.name}</span>
              <button onClick={logout} className="text-stone-400 hover:text-stone-700">
                تسجيل الخروج
              </button>
            </div>
          )}
        </div>
      </header>
      <main className={fullWidth ? "" : "mx-auto max-w-5xl px-6 py-8"}>{children}</main>
    </div>
  );
}
