import { useState, type ReactNode, type SVGProps } from "react";
import { NavLink, Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { NotificationBell } from "./NotificationBell";
import { Modal } from "../ui/Modal";
import { useTranslation } from "../i18n/I18nProvider";
import { LanguageSwitcher } from "../i18n/LanguageSwitcher";

// MIDAD Phase F — global App Shell, redesigned from a single flat
// horizontal nav (13 links with equal visual weight, in the order features
// were added over many phases) into a grouped sidebar organized by
// function — see client/src/project/ProjectSidebar.tsx for the identical
// pattern already established at the project-workspace level; this simply
// applies the same discipline one level up. This is presentation only: no
// route, permission, or API call changes — every existing link still
// points at the exact same path it always did.

interface NavItem {
  to: string;
  itemKey: string;
}
interface NavGroup {
  groupKey: string;
  icon: (props: SVGProps<SVGSVGElement>) => JSX.Element;
  items: NavItem[];
}

function IconOverview(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true" {...props}>
      <rect x="3" y="3" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="11" y="3" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="3" y="11" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5" />
      <rect x="11" y="11" width="6" height="6" rx="1" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
function IconCommercial(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true" {...props}>
      <path d="M3 6h14M3 10h14M3 14h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
function IconWorkforce(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true" {...props}>
      <circle cx="7" cy="6" r="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M2.5 16c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="14.5" cy="6.5" r="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M12.5 12.5c1.8.2 3.5 1.5 3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
function IconCompliance(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true" {...props}>
      <path d="M10 2.5 16 4.5v4.8c0 4-2.6 6.7-6 8.2-3.4-1.5-6-4.2-6-8.2V4.5L10 2.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M7.5 10 9.2 11.7 12.5 8.3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconInsights(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true" {...props}>
      <path d="M3 16.5V9M8 16.5V4M13 16.5v-7M17 16.5V7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
function IconAdmin(props: SVGProps<SVGSVGElement>) {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true" {...props}>
      <circle cx="10" cy="10" r="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M10 2.5v2M10 15.5v2M17.5 10h-2M4.5 10h-2M15.1 4.9l-1.4 1.4M6.3 13.7l-1.4 1.4M15.1 15.1l-1.4-1.4M6.3 6.3 4.9 4.9"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

const navGroups: NavGroup[] = [
  { groupKey: "overview", icon: IconOverview, items: [{ to: "/", itemKey: "projects" }] },
  {
    groupKey: "commercial",
    icon: IconCommercial,
    items: [
      { to: "/quotes", itemKey: "quotes" },
      { to: "/invoices", itemKey: "invoices" },
    ],
  },
  {
    groupKey: "workforce",
    icon: IconWorkforce,
    items: [
      { to: "/employees", itemKey: "employees" },
      { to: "/payroll", itemKey: "payroll" },
    ],
  },
  {
    groupKey: "compliance",
    icon: IconCompliance,
    items: [
      { to: "/labor-compliance", itemKey: "laborCompliance" },
      { to: "/compliance", itemKey: "taxCompliance" },
      { to: "/zatca", itemKey: "zatca" },
    ],
  },
  {
    groupKey: "insights",
    icon: IconInsights,
    items: [
      { to: "/budget-alerts", itemKey: "budgetAlerts" },
      { to: "/activity", itemKey: "activityLog" },
    ],
  },
  {
    groupKey: "admin",
    icon: IconAdmin,
    items: [
      { to: "/customers", itemKey: "customers" },
      { to: "/suppliers", itemKey: "suppliers" },
      { to: "/team", itemKey: "team" },
      { to: "/settings", itemKey: "settings" },
    ],
  },
];

function linkClass(isActive: boolean, collapsed: boolean) {
  const base = collapsed ? "flex justify-center rounded-md p-2" : "block rounded-md px-3 py-1.5";
  return `${base} text-sm ${isActive ? "bg-primary/10 font-medium text-primary" : "text-stone-600 hover:bg-stone-100"}`;
}

function SidebarNav({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const { t } = useTranslation();
  return (
    <nav className="space-y-4">
      {navGroups.map((group) => (
        <div key={group.groupKey}>
          {!collapsed && (
            <p className="px-3 text-xs font-semibold uppercase tracking-wide text-stone-400">
              {t(`nav.groups.${group.groupKey}`)}
            </p>
          )}
          <div className={collapsed ? "mt-1 space-y-1" : "mt-1 space-y-0.5"}>
            {group.items.map((item) => {
              const label = t(`nav.items.${item.itemKey}`);
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.to === "/"}
                  onClick={onNavigate}
                  title={collapsed ? label : undefined}
                  className={({ isActive }) => linkClass(isActive, collapsed)}
                >
                  {collapsed ? <group.icon /> : label}
                </NavLink>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}

// fullWidth: pages that manage their own inner layout (currently only the
// project workspace, which has its own sidebar + content columns) opt out
// of the default centered max-w-5xl content column. Every other existing
// page (Dashboard, Quotes, Invoices, Team, Settings) is unaffected — they
// don't pass this prop, so they keep their exact previous content-column
// width.
export function Layout({ children, fullWidth = false }: { children: ReactNode; fullWidth?: boolean }) {
  const { user, company, logout } = useAuth();
  const { t, direction } = useTranslation();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  // `children`'s position in the tree must stay structurally identical
  // regardless of `user` — react-router mounts a page's own Layout call
  // before the auth check (a network round trip) resolves, so this
  // component re-renders once `user` flips from null to a real value.
  // Branching the RETURNED JSX shape on that (e.g. an early `return
  // children` vs. the full chrome below) moves `children` to a different
  // depth in the tree between those two renders — React can no longer
  // match it up by position, so it unmounts the entire page subtree and
  // mounts a fresh one, silently resetting every bit of that page's own
  // state right as the page loads. The sidebar/header markup below is
  // therefore always rendered; only ITS CONTENTS are conditioned on
  // `user`, never whether `children` itself is nested inside it.
  return (
    <div className="min-h-screen bg-stone-50">
      <div className="flex">
        {user && (
          <aside
            className={`sticky top-0 hidden h-screen shrink-0 overflow-y-auto border-e border-stone-200 bg-white p-4 transition-all md:flex md:flex-col ${
              collapsed ? "w-16" : "w-64"
            }`}
          >
            <div className={`mb-5 flex items-center ${collapsed ? "justify-center" : "justify-between"}`}>
              {!collapsed && (
                <Link to="/" className="truncate text-lg font-bold text-primary">
                  {company?.name ?? "MIDAD"}
                </Link>
              )}
              <button
                type="button"
                onClick={() => setCollapsed((v) => !v)}
                aria-label={collapsed ? t("nav.expandMenu") : t("nav.collapseMenu")}
                title={collapsed ? t("nav.expandMenuShort") : t("nav.collapseMenuShort")}
                className="rounded-md p-1.5 text-stone-400 hover:bg-stone-100 hover:text-stone-600"
              >
                <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true" style={{ transform: direction === "ltr" ? "scaleX(-1)" : undefined }}>
                  <path d={collapsed ? "M7 5l5 5-5 5" : "M13 5l-5 5 5 5"} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
            <SidebarNav collapsed={collapsed} />
          </aside>
        )}

        <div className="min-w-0 flex-1">
          {user && (
            <header className="sticky top-0 z-10 border-b border-stone-200 bg-white">
              <div className="flex items-center justify-between gap-3 px-4 py-3 lg:px-6">
                <div className="flex items-center gap-3 md:hidden">
                  <button
                    type="button"
                    onClick={() => setMobileOpen(true)}
                    aria-label={t("nav.openNavMenu")}
                    className="rounded-md border border-stone-300 p-2 text-stone-600"
                  >
                    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                      <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  </button>
                  <Link to="/" className="text-base font-bold text-primary">
                    {company?.name ?? "MIDAD"}
                  </Link>
                </div>
                <div className="hidden md:block" />
                <div className="flex items-center gap-4 text-sm text-stone-600">
                  <LanguageSwitcher />
                  <NotificationBell />
                  <span className="hidden sm:inline">{user.name}</span>
                  <button onClick={logout} className="text-stone-400 hover:text-stone-700">
                    {t("nav.logout")}
                  </button>
                </div>
              </div>
            </header>
          )}
          <main className={fullWidth ? "" : "mx-auto max-w-5xl px-6 py-8"}>{children}</main>
        </div>
      </div>

      {user && (
        <Modal open={mobileOpen} onClose={() => setMobileOpen(false)} align="end" className="w-72 max-w-[85vw]" title={t("nav.navigationTitle")}>
          <SidebarNav collapsed={false} onNavigate={() => setMobileOpen(false)} />
        </Modal>
      )}
    </div>
  );
}
