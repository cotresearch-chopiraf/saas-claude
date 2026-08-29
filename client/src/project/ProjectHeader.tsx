import { Link } from "react-router-dom";
import type { Project } from "../api/types";

export function ProjectHeader({ project, onOpenMenu }: { project: Project | null; onOpenMenu: () => void }) {
  return (
    <div className="border-b border-stone-200 bg-white px-4 py-4 lg:px-6">
      <Link to="/" className="mb-2 inline-block text-sm text-stone-500 hover:text-primary">
        ← كل المشاريع
      </Link>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-stone-800">{project?.name ?? "..."}</h1>
          {project?.clientName && <p className="text-sm text-stone-500">العميل: {project.clientName}</p>}
        </div>
        <button
          type="button"
          onClick={onOpenMenu}
          aria-label="فتح قائمة أقسام المشروع"
          className="rounded-md border border-stone-300 p-2 text-stone-600 lg:hidden"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
