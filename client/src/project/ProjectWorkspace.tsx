import { useEffect, useState } from "react";
import { useParams, Outlet } from "react-router-dom";
import { Layout } from "../components/Layout";
import { Modal } from "../ui/Modal";
import { apiFetch } from "../api/client";
import type { Project } from "../api/types";
import { ProjectHeader } from "./ProjectHeader";
import { ProjectSidebarDesktop } from "./ProjectSidebar";
import { useTranslation } from "../i18n/I18nProvider";

// Replaces the old ProjectDetail.tsx's mixed
// project-info+legacy-tabs+local-state component with a composed shell:
// ProjectWorkspace (data + layout) -> ProjectHeader + ProjectSidebar +
// <Outlet/> (the URL-routed section — see App.tsx's nested /projects/:id/*
// routes and project/sections.ts for the section list). Individual
// section components are responsible for their own data; this component
// only owns the project record itself (needed by the header) and the
// section-menu drawer's open/closed state.
//
// The project sub-nav is a drawer at every width, not a permanent column
// reserved beside the section content — the section content (including
// the Dashboard) always gets the full width Layout's own global-nav
// drawer already left it (see components/Layout.tsx); there is no
// second sidebar column stacked next to it anymore.
export function ProjectWorkspace() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (id) apiFetch<Project>(`/projects/${id}`).then(setProject);
  }, [id]);

  if (!id) return null;

  return (
    <Layout fullWidth>
      <ProjectHeader project={project} onOpenMenu={() => setMenuOpen(true)} />
      <div className="p-4 lg:p-6">
        <Outlet context={{ project, projectId: id }} />
      </div>

      <Modal open={menuOpen} onClose={() => setMenuOpen(false)} align="end" className="w-72 max-w-[85vw]" title={t("project.sectionsMenuTitle")}>
        <ProjectSidebarDesktop projectId={id} onNavigate={() => setMenuOpen(false)} />
      </Modal>
    </Layout>
  );
}
