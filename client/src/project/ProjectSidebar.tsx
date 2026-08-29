import { NavLink } from "react-router-dom";
import { projectSectionGroups, projectSections, legacySection } from "./sections";

function NavItems({ projectId, onNavigate }: { projectId: string; onNavigate?: () => void }) {
  return (
    <nav className="space-y-5">
      {projectSectionGroups.map((group) => {
        const items = projectSections.filter((s) => s.group === group);
        if (items.length === 0) return null;
        return (
          <div key={group}>
            <p className="px-3 text-xs font-semibold uppercase tracking-wide text-stone-400">{group}</p>
            <div className="mt-1 space-y-0.5">
              {items.map((item) => (
                <NavLink
                  key={item.key}
                  to={`/projects/${projectId}/${item.path}`}
                  onClick={onNavigate}
                  className={({ isActive }) =>
                    `block rounded-md px-3 py-1.5 text-sm ${
                      isActive ? "bg-primary/10 font-medium text-primary" : "text-stone-600 hover:bg-stone-100"
                    }`
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </div>
          </div>
        );
      })}

      <div className="border-t border-stone-200 pt-3">
        <NavLink
          to={`/projects/${projectId}/${legacySection.path}`}
          onClick={onNavigate}
          className={({ isActive }) =>
            `block rounded-md px-3 py-1.5 text-xs ${isActive ? "bg-stone-200 text-stone-700" : "text-stone-400 hover:text-stone-600"}`
          }
        >
          {legacySection.label}
        </NavLink>
      </div>
    </nav>
  );
}

// Desktop: a fixed-width sidebar, placed first in DOM so it renders on the
// visual right under the app's RTL direction (matching every other
// right-anchored nav in this app), always visible at lg+ widths.
export function ProjectSidebarDesktop({ projectId }: { projectId: string }) {
  return (
    <aside className="hidden w-64 shrink-0 border-e border-stone-200 bg-white p-4 lg:block">
      <NavItems projectId={projectId} />
    </aside>
  );
}

// Mobile: the same nav rendered inside the header's drawer overlay (see
// ProjectHeader.tsx) — one nav definition, two presentations, so the
// section list is never duplicated.
export function ProjectSidebarMobile({ projectId, onNavigate }: { projectId: string; onNavigate: () => void }) {
  return (
    <div className="p-2">
      <NavItems projectId={projectId} onNavigate={onNavigate} />
    </div>
  );
}
