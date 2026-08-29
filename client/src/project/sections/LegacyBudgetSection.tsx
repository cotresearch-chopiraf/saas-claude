import { PageHeader } from "../../ui/PageHeader";
import { BudgetPanel } from "../../components/BudgetPanel";
import { ChangeOrdersPanel } from "../../components/ChangeOrdersPanel";
import { useProjectContext } from "../context";

// The pre-MIDAD flat budget/expense + change-order UI (BudgetPanel.tsx,
// ChangeOrdersPanel.tsx — both untouched here), kept fully reachable so no
// existing functionality is lost. Deliberately NOT placed under the new
// "Cost Plan" / "Actual Cost" sections and explicitly labeled legacy: this
// view is built on budgetItems.plannedAmount without the cost-code/BOQ/
// budget-revision linkage the real Cost Plan screen (UI-01) will have, and
// must never be mistaken for it once that screen exists.
export function LegacyBudgetSection() {
  const { projectId } = useProjectContext();
  return (
    <div>
      <PageHeader title="الميزانية والمصروفات (النموذج السابق)" />
      <div className="mb-6 rounded-md border border-warning-200 bg-warning-50 px-4 py-3 text-sm text-warning-800">
        هذا العرض هو النموذج المالي السابق لمشروع MIDAD. خطة التكلفة الجديدة المرتبطة بجدول الكميات وبنود التكلفة ستحل
        محله في قسم "خطة التكلفة" عند توفره.
      </div>
      <div className="space-y-8">
        <BudgetPanel projectId={projectId} />
        <ChangeOrdersPanel projectId={projectId} />
      </div>
    </div>
  );
}
