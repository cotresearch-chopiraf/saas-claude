import { NavLink } from "react-router-dom";
import { projectSectionGroups, projectSections, legacySection } from "./sections";
import { useTranslation } from "../i18n/I18nProvider";

function NavItems({ projectId, onNavigate }: { projectId: string; onNavigate?: () => void }) {
  const { t } = useTranslation();
  return (
    <nav className="space-y-5">
      {projectSectionGroups.map((group) => {
        const items = projectSections.filter((s) => s.group === group);
        if (items.length === 0) return null;
        return (
          <div key={group}>
            <p className="px-3 text-xs font-semibold uppercase tracking-wide text-stone-400">
              {t(`project.groups.${group}`)}
            </p>
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
                  {t(`project.sections.${item.key}`)}
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
          {t(`project.${legacySection.labelKey}`)}
        </NavLink>
      </div>
    </nav>
  );
}

// The project sub-nav is drawer content at every width now, not a
// permanent column reserved next to the Dashboard — see
// ProjectWorkspace.tsx, which renders this inside the same Modal overlay
// (align="end") regardless of viewport. Kept as `ProjectSidebarDesktop`
// (rather than renamed) because ProjectSidebar.test.tsx renders it
// directly; there is no longer a separate "desktop" presentation to
// distinguish it from.
export function ProjectSidebarDesktop({ projectId, onNavigate }: { projectId: string; onNavigate?: () => void }) {
  return (
    <div className="p-2">
      <NavItems projectId={projectId} onNavigate={onNavigate} />
    </div>
  );
}
