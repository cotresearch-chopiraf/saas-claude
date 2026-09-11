import { useEffect, useState } from "react";
import { useParams, Outlet } from "react-router-dom";
import { Layout } from "../components/Layout";
import { Modal } from "../ui/Modal";
import { apiFetch } from "../api/client";
import type { Project } from "../api/types";
import { ProjectHeader } from "./ProjectHeader";
import { ProjectSidebarDesktop, ProjectSidebarMobile } from "./ProjectSidebar";
import { useTranslation } from "../i18n/I18nProvider";

// Replaces the old ProjectDetail.tsx's mixed
// project-info+legacy-tabs+local-state component with a composed shell:
// ProjectWorkspace (data + layout) -> ProjectHeader + ProjectSidebar* +
// <Outlet/> (the URL-routed section — see App.tsx's nested /projects/:id/*
// routes and project/sections.ts for the section list). Individual
// section components are responsible for their own data; this component
// only owns the project record itself (needed by the header) and the
// mobile menu's open/closed state.
export function ProjectWorkspace() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    if (id) apiFetch<Project>(`/projects/${id}`).then(setProject);
  }, [id]);

  if (!id) return null;

  return (
    <Layout fullWidth>
      <div className="flex min-h-[calc(100vh-73px)]">
        <ProjectSidebarDesktop projectId={id} />
        <div className="min-w-0 flex-1">
          <ProjectHeader project={project} onOpenMenu={() => setMobileMenuOpen(true)} />
          <div className="p-4 lg:p-6">
            <Outlet context={{ project, projectId: id }} />
          </div>
        </div>
      </div>

      <Modal open={mobileMenuOpen} onClose={() => setMobileMenuOpen(false)} align="end" className="w-72 max-w-[85vw]" title={t("project.sectionsMenuTitle")}>
        <ProjectSidebarMobile projectId={id} onNavigate={() => setMobileMenuOpen(false)} />
      </Modal>
    </Layout>
  );
}
