import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { PageHeader } from "../../ui/PageHeader";
import { Card } from "../../ui/Card";
import { Badge } from "../../ui/Badge";
import { MetricCard } from "../../ui/MetricCard";
import { ErrorState } from "../../ui/ErrorState";
import { Skeleton } from "../../ui/Skeleton";
import { formatMoney, formatPercent, formatDate } from "../../lib/format";
import { listContracts } from "../../api/contracts";
import { getBudget } from "../../api/costPlan";
import { getForecast } from "../../api/forecast";
import { getCashFlow } from "../../api/cashflow";
import { listRevisions } from "../../api/boq";
import { getProjectLaborCost } from "../../api/laborCost";
import { useProjectContext } from "../context";
import type {
  BoqRevision,
  BudgetSummary,
  CashFlowResult,
  Contract,
  ForecastCalculation,
  ForecastMethod,
  ForecastResult,
  Project,
  ProjectLaborCost,
} from "../../api/types";

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
const methodLabel: Record<ForecastMethod, string> = {
  cost_to_complete: "الطريقة المحافظة (تجاهل الالتزامات)",
  commitment_aware: "الطريقة الواعية بالالتزامات",
};
const methods: ForecastMethod[] = ["cost_to_complete", "commitment_aware"];
const boqRevisionStatusLabel: Record<BoqRevision["status"], string> = {
  draft: "مسودة",
  published: "منشورة",
  superseded: "مُستبدَلة",
};
const boqRevisionStatusTone: Record<BoqRevision["status"], "neutral" | "success" | "warning"> = {
  draft: "warning",
  published: "success",
  superseded: "neutral",
};

interface DashboardData {
  contracts: Contract[];
  budget: BudgetSummary;
  forecast: ForecastResult;
  cashFlow: CashFlowResult;
  revisions: BoqRevision[];
  laborCost: ProjectLaborCost;
}

// Executive Dashboard (UI-08) — a read-only rollup of the project's
// already-existing, already-authoritative financial/operational domains.
// This screen never computes a financial value: every figure here comes
// verbatim from Contract/Cost Plan/Forecast/Cash Flow's own existing,
// tested endpoints (fanned out via Promise.all, since it is only
// consuming their already-authoritative results — not deriving a new
// one). BOQ has no backend-computed aggregate total anywhere in this
// codebase, so this screen deliberately shows only non-financial BOQ
// status (latest revision/publish state), never a summed "BOQ value" —
// see docs/MIDAD_FINANCIAL_MODEL.md and the UI-08 discovery report.
export function OverviewSection() {
  const { project, projectId } = useProjectContext();
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setError(null);
    setData(null);
    Promise.all([
      listContracts(projectId),
      getBudget(projectId),
      getForecast(projectId),
      getCashFlow(projectId),
      listRevisions(projectId),
      getProjectLaborCost(projectId),
    ])
      .then(([contracts, budget, forecast, cashFlow, revisions, laborCost]) =>
        setData({ contracts, budget, forecast, cashFlow, revisions, laborCost }),
      )
      .catch((err) => setError(err instanceof Error ? err.message : "تعذّر تحميل نظرة عامة المشروع"));
  }
  useEffect(load, [projectId]);

  if (!project) return null;

  if (error && !data) {
    return (
      <div className="space-y-6">
        <PageHeader title="نظرة عامة" actions={<Badge tone={statusTone[project.status]}>{statusLabel[project.status]}</Badge>} />
        <ErrorState message={error} onRetry={load} />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="space-y-6">
        <PageHeader title="نظرة عامة" actions={<Badge tone={statusTone[project.status]}>{statusLabel[project.status]}</Badge>} />
        <Skeleton rows={8} />
      </div>
    );
  }

  // Same established rule as Measurement/Commitment/IPC's own create
  // forms: "the main contract" is identified by contractType === "main",
  // never contracts[0] and never summed across amendments.
  const mainContract = data.contracts.find((c) => c.contractType === "main") ?? null;
  const latestRevision = [...data.revisions].sort((a, b) => b.revisionNumber - a.revisionNumber)[0] ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="نظرة عامة"
        subtitle={project.clientName ?? undefined}
        actions={
          <div className="flex items-center gap-3">
            {/* MIDAD Phase A' — purely additive: shown only when a
                Customer is linked, never replaces or requires clientName
                above (the two fields are fully independent). */}
            {project.customerId && (
              <Link to={`/customers/${project.customerId}`} className="text-sm text-primary hover:underline">
                عرض ملف العميل
              </Link>
            )}
            <Badge tone={statusTone[project.status]}>{statusLabel[project.status]}</Badge>
          </div>
        }
      />

      {error && (
        <div>
          <ErrorState message={error} onRetry={load} />
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <ContractCard contract={mainContract} />
        <CostPlanCard budget={data.budget} />
      </div>

      <ForecastCard forecast={data.forecast} />

      <CashFlowCard cashFlow={data.cashFlow} />

      <LaborCostCard laborCost={data.laborCost} />

      <BoqStatusCard revision={latestRevision} />
    </div>
  );
}

function ContractCard({ contract }: { contract: Contract | null }) {
  return (
    <Card className="p-5">
      <h2 className="mb-3 font-semibold text-stone-800">العقد الرئيسي</h2>
      {!contract ? (
        <p className="text-sm text-stone-400">لا يوجد عقد رئيسي لهذا المشروع بعد.</p>
      ) : (
        <dl className="space-y-3 text-sm">
          <Field label="رقم العقد" value={contract.contractNumber ?? "—"} />
          <Field label="القيمة الأصلية" value={formatMoney(contract.originalValue, contract.currency)} />
          <Field label="القيمة الحالية (المعدَّلة)" value={formatMoney(contract.revisedValue, contract.currency)} />
        </dl>
      )}
    </Card>
  );
}

function CostPlanCard({ budget }: { budget: BudgetSummary }) {
  return (
    <Card className="p-5">
      <h2 className="mb-3 font-semibold text-stone-800">خطة التكلفة</h2>
      <div className="grid gap-3 sm:grid-cols-3">
        <MetricCard label="إجمالي المخطَّط" value={formatMoney(budget.totals.planned)} />
        <MetricCard label="إجمالي المُنفَق" value={formatMoney(budget.totals.spent)} />
        <MetricCard
          label={budget.totals.remaining < 0 ? "تجاوز الميزانية" : "المتبقي"}
          value={formatMoney(budget.totals.remaining)}
          tone={budget.totals.remaining < 0 ? "danger" : "default"}
        />
      </div>
    </Card>
  );
}

function ForecastCard({ forecast }: { forecast: ForecastResult }) {
  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold text-stone-800">التوقعات المالية</h2>
        <span className="text-xs text-stone-400">بتاريخ {formatDate(forecast.asOfDate)}</span>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {methods.map((m) => (
          <ForecastMethodBlock key={m} calc={forecast.methods[m]} currency={forecast.currency} />
        ))}
      </div>
    </Card>
  );
}

function ForecastMethodBlock({ calc, currency }: { calc: ForecastCalculation; currency: string }) {
  return (
    <div className="rounded-md border border-stone-200 p-3">
      <h3 className="mb-2 text-sm font-semibold text-stone-700">{methodLabel[calc.method]}</h3>
      <dl className="space-y-2 text-sm">
        <Field label="المتبقي لإنجاز العمل (ETC)" value={formatMoney(calc.etc, currency)} />
        <Field label="التكلفة المتوقعة عند الإنجاز (EAC)" value={formatMoney(calc.eac, currency)} />
        <Field label="الانحراف" value={formatMoney(calc.variance, currency)} />
        <Field label="نسبة الانحراف" value={formatPercent(calc.variancePercent)} />
      </dl>
    </div>
  );
}

function CashFlowCard({ cashFlow }: { cashFlow: CashFlowResult }) {
  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold text-stone-800">التدفق النقدي</h2>
        <span className="text-xs text-stone-400">بتاريخ {formatDate(cashFlow.asOfDate)}</span>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <h3 className="mb-2 text-xs font-semibold text-stone-500">فعلي (محقَّق)</h3>
          <dl className="space-y-2 text-sm">
            <Field label="المُحصَّل فعلياً" value={formatMoney(cashFlow.historical.cashReceived, cashFlow.currency)} />
            <Field label="التكلفة المتكبَّدة" value={formatMoney(cashFlow.historical.incurredCost, cashFlow.currency)} />
          </dl>
        </div>
        <div>
          <h3 className="mb-2 text-xs font-semibold text-stone-500">متوقَّع</h3>
          <dl className="space-y-2 text-sm">
            <Field label="المستحقات" value={formatMoney(cashFlow.projected.receivables, cashFlow.currency)} />
            <Field label="التحصيل المتوقع من الشهادات المعتمدة" value={formatMoney(cashFlow.projected.certifiedExpectedCollection, cashFlow.currency)} />
            <Field label="الالتزامات التعاقدية" value={formatMoney(cashFlow.projected.commitments, cashFlow.currency)} />
            <Field label="الصافي" value={formatMoney(cashFlow.projected.net, cashFlow.currency)} />
          </dl>
        </div>
        <div>
          <h3 className="mb-2 text-xs font-semibold text-stone-500">غير مؤرَّخ (لا يوجد آلية توقيت في النظام الحالي)</h3>
          <dl className="space-y-2 text-sm">
            <Field label="المتبقي لإنجاز العمل (ETC)" value={formatMoney(cashFlow.undated.etc, cashFlow.currency)} />
            <Field label="الضمان المحتجز" value={formatMoney(cashFlow.undated.retentionToBeReleased, cashFlow.currency)} />
            <Field label="الدفعة المقدَّمة" value={cashFlow.undated.advance.supported ? "—" : "غير مدعومة"} />
          </dl>
        </div>
      </div>
    </Card>
  );
}

// MIDAD Phase A4 — read-only Labor Allocation visibility. Deliberately a
// SEPARATE card from Cost Plan/Forecast/Cash Flow above, never merged
// into their totals: routes/laborAllocations.ts never posts to
// `expenses`, so this figure is pre-posting internal data, not yet part
// of Actual Cost. The explicit "غير مرحّلة" (not yet posted) label and
// the drill-down link are what keep that distinction visible to the user
// rather than only living in a code comment.
function LaborCostCard({ laborCost }: { laborCost: ProjectLaborCost }) {
  return (
    <Card className="p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold text-stone-800">تكلفة العمالة الموزَّعة</h2>
        <span className="text-xs text-stone-400">بيانات داخلية — غير مرحّلة إلى التكلفة الفعلية</span>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <MetricCard label="إجمالي الموزَّع" value={formatMoney(laborCost.allocatedTotal)} />
        <MetricCard label="عدد التوزيعات" value={String(laborCost.allocationCount)} />
      </div>
      <div className="mt-3 text-end">
        <Link to="/payroll" className="text-sm text-primary hover:underline">
          عرض تفاصيل توزيع الرواتب
        </Link>
      </div>
    </Card>
  );
}

function BoqStatusCard({ revision }: { revision: BoqRevision | null }) {
  return (
    <Card className="p-5">
      <h2 className="mb-3 font-semibold text-stone-800">حالة جدول الكميات</h2>
      {!revision ? (
        <p className="text-sm text-stone-400">لا توجد نسخة من جدول الكميات لهذا المشروع بعد.</p>
      ) : (
        <dl className="space-y-3 text-sm">
          <Field label="النسخة" value={`النسخة #${revision.revisionNumber}`} />
          <Field
            label="الحالة"
            value=""
            valueNode={<Badge tone={boqRevisionStatusTone[revision.status]}>{boqRevisionStatusLabel[revision.status]}</Badge>}
          />
          <Field label="تاريخ النشر" value={formatDate(revision.publishedAt)} />
        </dl>
      )}
    </Card>
  );
}

function Field({ label, value, valueNode }: { label: string; value: string; valueNode?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between border-b border-stone-100 pb-2">
      <dt className="text-stone-500">{label}</dt>
      <dd className="font-medium text-stone-800">{valueNode ?? value}</dd>
    </div>
  );
}
