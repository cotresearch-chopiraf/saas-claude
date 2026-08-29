import { PageHeader } from "../../ui/PageHeader";
import { Card } from "../../ui/Card";
import { Badge } from "../../ui/Badge";
import { formatDate } from "../../lib/format";
import { useProjectContext } from "../context";
import type { Project } from "../../api/types";

const statusLabel: Record<Project["status"], string> = {
  active: "نشط",
  on_hold: "متوقف مؤقتاً",
  completed: "مكتمل",
};
const statusTone: Record<Project["status"], "success" | "warning" | "neutral"> = {
  active: "success",
  on_hold: "warning",
  completed: "neutral",
};

// Deliberately minimal: only fields the project record itself already
// carries (name, client, address, status, start date). A fuller rollup —
// Contract value, BOQ value, Cost Plan, Forecast EAC, Cash position — is
// explicitly UI-05 (Executive Dashboard) scope, once Contract/BOQ/Cost
// Plan/Forecast/Cash Flow screens exist to source it from. No fabricated
// metric is ever shown here in the meantime.
export function OverviewSection() {
  const { project } = useProjectContext();

  if (!project) return null;

  return (
    <div>
      <PageHeader
        title="نظرة عامة"
        actions={<Badge tone={statusTone[project.status]}>{statusLabel[project.status]}</Badge>}
      />
      <Card className="max-w-xl p-5">
        <dl className="space-y-3 text-sm">
          <div className="flex justify-between">
            <dt className="text-stone-500">العميل</dt>
            <dd className="text-stone-800">{project.clientName ?? "—"}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-stone-500">العنوان</dt>
            <dd className="text-stone-800">{project.address ?? "—"}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-stone-500">تاريخ البدء</dt>
            <dd className="text-stone-800">{formatDate(project.startDate)}</dd>
          </div>
        </dl>
      </Card>
      <p className="mt-4 text-sm text-stone-400">
        ملخص شامل للعقد وجدول الكميات والتكاليف والتوقعات المالية سيتوفر هنا في مرحلة قادمة.
      </p>
    </div>
  );
}
