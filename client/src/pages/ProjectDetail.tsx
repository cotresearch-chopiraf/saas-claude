import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { Layout } from "../components/Layout";
import { BudgetPanel } from "../components/BudgetPanel";
import { TaskPanel } from "../components/TaskPanel";
import { apiFetch } from "../api/client";
import type { Project } from "../api/types";

const tabs = [
  { key: "budget", label: "الميزانية" },
  { key: "tasks", label: "المهام" },
] as const;

type TabKey = (typeof tabs)[number]["key"];

export function ProjectDetail() {
  const { id } = useParams<{ id: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [tab, setTab] = useState<TabKey>("budget");

  useEffect(() => {
    if (id) apiFetch<Project>(`/projects/${id}`).then(setProject);
  }, [id]);

  if (!id) return null;

  return (
    <Layout>
      <Link to="/" className="mb-4 inline-block text-sm text-stone-500 hover:text-primary">
        ← كل المشاريع
      </Link>

      {project && (
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-stone-800">{project.name}</h1>
          {project.clientName && <p className="text-stone-500">العميل: {project.clientName}</p>}
          {project.address && <p className="text-stone-500">{project.address}</p>}
        </div>
      )}

      <div className="mb-4 flex gap-1 border-b border-stone-200">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium ${
              tab === t.key ? "border-primary text-primary" : "border-transparent text-stone-500"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "budget" ? <BudgetPanel projectId={id} /> : <TaskPanel projectId={id} />}
    </Layout>
  );
}
