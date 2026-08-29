import { PageHeader } from "../../ui/PageHeader";
import { TaskPanel } from "../../components/TaskPanel";
import { DailyLogsPanel } from "../../components/DailyLogsPanel";
import { useProjectContext } from "../context";

// Real, working functionality — Tasks and Daily Logs already had full UI
// before UI-Foundation (TaskPanel.tsx / DailyLogsPanel.tsx, untouched
// here). This section only relocates them from the old flat tab strip
// into the new URL-routed "Operations" slot; neither component's own
// logic changed.
export function OperationsSection() {
  const { projectId } = useProjectContext();
  return (
    <div className="space-y-8">
      <div>
        <PageHeader title="المهام" />
        <TaskPanel projectId={projectId} />
      </div>
      <div>
        <PageHeader title="السجل اليومي" />
        <DailyLogsPanel projectId={projectId} />
      </div>
    </div>
  );
}
