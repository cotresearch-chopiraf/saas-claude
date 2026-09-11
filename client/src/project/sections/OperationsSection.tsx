import { PageHeader } from "../../ui/PageHeader";
import { TaskPanel } from "../../components/TaskPanel";
import { DailyLogsPanel } from "../../components/DailyLogsPanel";
import { useProjectContext } from "../context";
import { useTranslation } from "../../i18n/I18nProvider";

// Real, working functionality — Tasks and Daily Logs already had full UI
// before UI-Foundation (TaskPanel.tsx / DailyLogsPanel.tsx, untouched
// here). This section only relocates them from the old flat tab strip
// into the new URL-routed "Operations" slot; neither component's own
// logic changed.
export function OperationsSection() {
  const { t } = useTranslation();
  const { projectId } = useProjectContext();
  return (
    <div className="space-y-8">
      <div>
        <PageHeader title={t("operations.tasks")} />
        <TaskPanel projectId={projectId} />
      </div>
      <div>
        <PageHeader title={t("operations.dailyLog")} />
        <DailyLogsPanel projectId={projectId} />
      </div>
    </div>
  );
}
