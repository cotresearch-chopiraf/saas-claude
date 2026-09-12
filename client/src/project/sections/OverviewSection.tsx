import { useEffect, useState, type SVGProps } from "react";
import { Link } from "react-router-dom";
import { Badge } from "../../ui/Badge";
import { ErrorState } from "../../ui/ErrorState";
import { Skeleton } from "../../ui/Skeleton";
import { Button } from "../../ui/Button";
import { Can } from "../../auth/Can";
import { formatMoney, formatPercent, formatDate, formatDateTime } from "../../lib/format";
import { listContracts } from "../../api/contracts";
import { getBudget } from "../../api/costPlan";
import { getForecast } from "../../api/forecast";
import { getCashFlow } from "../../api/cashflow";
import { listRevisions } from "../../api/boq";
import { getProjectLaborCost } from "../../api/laborCost";
import { listBudgetAlerts } from "../../api/budgetAlerts";
import { getProjectSchedule } from "../../api/projectSchedule";
import { listPunchItems } from "../../api/punchItems";
import { listCommitments } from "../../api/commitments";
import { listIpcs } from "../../api/ipcs";
import { listMeasurements } from "../../api/measurements";
import { listActivity } from "../../api/auditEvents";
import { useProjectContext } from "../context";
import { useTranslation } from "../../i18n/I18nProvider";
import type {
  ActivityEvent,
  BoqRevision,
  BudgetAlert,
  BudgetSummary,
  CashFlowResult,
  Commitment,
  Contract,
  ForecastResult,
  Ipc,
  Measurement,
  Project,
  ProjectLaborCost,
  ProjectTask,
  PunchItem,
} from "../../api/types";

// ─────────────────────────────────────────────────────────────────────────
// MIDAD — Dashboard 3.0: Construction Commercial Intelligence.
//
// A full presentational rebuild, not a rearrangement of Dashboard 2.0's
// card grid. Dashboard 2.0 (and its "widget grid" follow-up) still
// presented every fact as an equal-weight bordered/shadowed tile — this
// version deliberately has almost none of that: typography, whitespace,
// and dividers carry the hierarchy instead of card chrome. Reading order
// still answers, in order: WHAT is happening (the verdict + its three
// headline numbers) → WHY (the one-line insight + the per-domain health
// strip) → the connected financial and delivery picture → WHAT'S THE
// IMPACT (Cost vs Progress, Cash, Commercial) → WHAT TO DO (Exceptions,
// Quick Actions). Source order equals reading order on every breakpoint,
// unchanged invariant from every earlier version of this page — no
// per-breakpoint reordering.
//
// Every number still comes from this codebase's own already-authoritative
// endpoints (Contract/Budget/Forecast/Cash Flow/Commitments/IPCs/
// Measurements/Schedule/Punch List/Budget Alerts/Labor Cost/BOQ, plus the
// canonical audit_events feed filtered client-side to this project's own
// entity ids). computeHealth, buildNeedsAttention, and deriveVerdict are
// reused verbatim, unchanged, from every earlier version of this page —
// this rebuild replaces how their output is presented, never what they
// compute. The cost-vs-progress gap headline is now computed once and
// reused at two depths (the Verdict's one-line insight, and the full
// Cost vs Progress section) — the same real relationship shown twice on
// purpose, not two different claims. No new KPI, alert, or score is
// invented anywhere on this page.
//
// Fetching is one Promise.all, unchanged.
// ─────────────────────────────────────────────────────────────────────────

const alertSeverityKey: Record<BudgetAlert["severity"], string> = {
  info: "severityInfo",
  warning: "severityWarning",
  critical: "severityCritical",
};

interface OverviewData {
  contracts: Contract[];
  budget: BudgetSummary;
  forecast: ForecastResult;
  cashFlow: CashFlowResult;
  revisions: BoqRevision[];
  laborCost: ProjectLaborCost;
  budgetAlerts: BudgetAlert[];
  tasks: ProjectTask[];
  punchItems: PunchItem[];
  commitments: Commitment[];
  ipcs: Ipc[];
  measurements: Measurement[];
  activity: ActivityEvent[];
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function OverviewSection() {
  const { project, projectId } = useProjectContext();
  const { t, locale } = useTranslation();
  const [data, setData] = useState<OverviewData | null>(null);
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
      listBudgetAlerts({ projectId }),
      getProjectSchedule(projectId),
      listPunchItems(projectId),
      listCommitments(projectId),
      listIpcs(projectId),
      listMeasurements(projectId),
      listActivity({ limit: 50 }),
    ])
      .then(
        ([
          contracts,
          budget,
          forecast,
          cashFlow,
          revisions,
          laborCost,
          budgetAlerts,
          schedule,
          punchItems,
          commitments,
          ipcs,
          measurements,
          activityPage,
        ]) =>
          setData({
            contracts,
            budget,
            forecast,
            cashFlow,
            revisions,
            laborCost,
            budgetAlerts,
            tasks: schedule.tasks,
            punchItems,
            commitments,
            ipcs,
            measurements,
            activity: activityPage.events,
          }),
      )
      .catch((err) => setError(err instanceof Error ? err.message : t("dashboard.loadErrorFallback")));
  }
  useEffect(load, [projectId]);

  if (!project) return null;

  if (error && !data) {
    return (
      <div className="space-y-6">
        <HeaderSkeleton project={project} />
        <ErrorState message={error} onRetry={load} />
      </div>
    );
  }
  if (!data) {
    return (
      <div className="space-y-6">
        <HeaderSkeleton project={project} />
        <Skeleton rows={10} />
      </div>
    );
  }

  const mainContract = data.contracts.find((c) => c.contractType === "main") ?? null;
  const latestRevision = [...data.revisions].sort((a, b) => b.revisionNumber - a.revisionNumber)[0] ?? null;
  const forecastMethod = data.forecast.methods.commitment_aware;

  const activeAlerts = data.budgetAlerts.filter((a) => a.status !== "resolved");
  const overdueTasks = data.tasks.filter((t) => t.status !== "completed" && t.endDate < today());
  const scheduleTasks = data.tasks.filter((t) => t.taskType === "task");
  const nextMilestone = data.tasks
    .filter((t) => t.taskType === "milestone" && t.status !== "completed")
    .sort((a, b) => a.endDate.localeCompare(b.endDate))[0];
  // Physical progress: a plain average of the schedule's own per-task
  // progressPercent (an authoritative field entered on Schedule itself),
  // over ordinary tasks only — milestones are point-in-time markers
  // (0%→100% instantly), not a progress figure, and would skew the
  // average. null when there is no schedule data at all, never a
  // fabricated number.
  const avgProgress =
    scheduleTasks.length > 0
      ? scheduleTasks.reduce((sum, t) => sum + t.progressPercent, 0) / scheduleTasks.length
      : null;

  const openPunch = data.punchItems.filter((i) => ["open", "assigned", "in_progress"].includes(i.status));
  const criticalPunch = openPunch.filter((i) => i.priority === "critical");

  const liveCommitments = data.commitments.filter((c) => c.status !== "cancelled" && c.status !== "draft");
  const pendingCommitments = data.commitments.filter((c) => c.status === "pending_approval");
  const commitmentAmount = (c: Commitment) => Number(c.revisedAmount ?? c.originalAmount ?? 0);
  const totalCommitted = liveCommitments.reduce((sum, c) => sum + commitmentAmount(c), 0);
  const approvedCommitted = liveCommitments
    .filter((c) => c.status === "active" || c.status === "partially_fulfilled" || c.status === "closed")
    .reduce((sum, c) => sum + commitmentAmount(c), 0);
  const pendingCommitted = pendingCommitments.reduce((sum, c) => sum + commitmentAmount(c), 0);

  const ipcsAwaitingCertification = data.ipcs.filter((i) => i.status === "approved");
  const ipcsAwaitingApproval = data.ipcs.filter((i) => i.status === "submitted");
  const certifiedIpcs = data.ipcs.filter((i) => i.status === "certified");
  const certifiedTotal = certifiedIpcs.reduce((sum, i) => sum + Number(i.netCertified ?? 0), 0);

  const measurementsAwaitingApproval = data.measurements.filter((m) => m.status === "submitted");

  // Project-scoped activity: the canonical audit_events feed is
  // company-wide (no per-project filter exists server-side), so this
  // filters the already-fetched page down to events on entities this
  // project actually owns — real events, real timestamps, nothing invented.
  const knownEntityIds = new Set<string>([
    ...data.contracts.map((c) => c.id),
    ...data.ipcs.map((i) => i.id),
    ...data.commitments.map((c) => c.id),
    ...data.revisions.map((r) => r.id),
    ...data.measurements.map((m) => m.id),
    ...data.punchItems.map((p) => p.id),
  ]);
  const projectActivity = data.activity.filter((e) => knownEntityIds.has(e.entityId)).slice(0, 8);

  const needsAttention = buildNeedsAttention({
    t,
    locale,
    projectId,
    activeAlerts,
    overdueTasks,
    criticalPunch,
    ipcsAwaitingCertification,
    pendingCommitments,
    measurementsAwaitingApproval,
    forecastMethod,
  });

  const health = computeHealth({
    t,
    locale,
    activeAlerts,
    overdueTasks,
    scheduleHasData: scheduleTasks.length > 0,
    cashFlowNet: data.cashFlow.projected.net,
    pendingCommitments,
    measurementsAwaitingApproval,
    measurementsHaveData: data.measurements.length > 0,
  });
  const verdict = deriveVerdict(health);

  // The cost-vs-progress relationship, computed once and reused at two
  // depths: the Verdict block's one-line insight, and the full Cost vs
  // Progress section below — the same real relationship, not two
  // different claims.
  const costConsumption = data.budget.totals.planned > 0 ? (data.budget.totals.spent / data.budget.totals.planned) * 100 : null;
  const progressCostGap = avgProgress !== null && costConsumption !== null ? costConsumption - avgProgress : null;
  const gapIsWarning = progressCostGap !== null && progressCostGap > 5;
  const progressCostHeadline =
    progressCostGap === null
      ? t("dashboard.costProgress.noProgressData")
      : progressCostGap > 5
        ? t("dashboard.costProgress.costAheadOfProgress", { gap: formatPercent(progressCostGap, 0, locale) })
        : progressCostGap < -5
          ? t("dashboard.costProgress.progressAheadOfCost", { gap: formatPercent(Math.abs(progressCostGap), 0, locale) })
          : t("dashboard.costProgress.aligned");

  return (
    <div className="flex flex-col gap-10 lg:gap-14">
      <VerdictBlock
        project={project}
        contract={mainContract}
        verdict={verdict}
        insight={progressCostHeadline}
        progress={avgProgress}
        costConsumption={costConsumption}
        variancePercent={forecastMethod.variancePercent}
        lastActivityAt={data.activity[0]?.createdAt ?? project.createdAt}
      />

      <HealthLine health={health} projectId={projectId} />

      {/* xl, not lg: the desktop sidebar (ProjectSidebar.tsx) also claims
          its fixed width starting at `lg`, cutting the content area's real
          width well below 1024px at that exact breakpoint — every
          multi-column switch on this page waits for `xl` for the same
          reason (confirmed via a live 1024px screenshot in an earlier
          round of this dashboard). */}
      <div className="grid grid-cols-1 gap-10 xl:grid-cols-12 xl:gap-12">
        <div className="xl:col-span-8">
          <FinancialControl contract={mainContract} forecast={data.forecast} revision={latestRevision} projectId={projectId} />
        </div>
        <div className="xl:col-span-4">
          <ExceptionsPanel items={needsAttention} />
        </div>
      </div>

      <CostVsProgress
        budget={data.budget}
        avgProgress={avgProgress}
        costConsumption={costConsumption}
        gap={progressCostGap}
        warnGap={gapIsWarning}
        headline={progressCostHeadline}
      />

      <div className="grid grid-cols-1 gap-10 border-t border-stone-200 pt-10 xl:grid-cols-3 xl:gap-0 xl:divide-x xl:divide-x-reverse xl:divide-stone-200">
        <div className="xl:px-8 xl:first:ps-0 xl:last:pe-0">
          <DeliveryColumn
            projectId={projectId}
            tasks={data.tasks}
            overdueTasks={overdueTasks}
            nextMilestone={nextMilestone}
            avgProgress={avgProgress}
            measurementsAwaitingApproval={measurementsAwaitingApproval}
          />
        </div>
        <div className="xl:px-8">
          <CashColumn cashFlow={data.cashFlow} projectId={projectId} />
        </div>
        <div className="xl:px-8">
          <CommercialColumn
            projectId={projectId}
            totalCommitted={totalCommitted}
            approvedCommitted={approvedCommitted}
            pendingCommitted={pendingCommitted}
            pendingCount={pendingCommitments.length}
            awaitingCertification={ipcsAwaitingCertification.length}
            awaitingApproval={ipcsAwaitingApproval.length}
            certifiedTotal={certifiedTotal}
            certifiedCount={certifiedIpcs.length}
            currency={data.forecast.currency}
            laborCost={data.laborCost}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-8 border-t border-stone-200 pt-8 xl:grid-cols-3 xl:gap-12">
        <div className="xl:col-span-2">
          <ActivityPulse events={projectActivity} />
        </div>
        <QuickActionsRow projectId={projectId} />
      </div>
    </div>
  );
}

function HeaderSkeleton({ project }: { project: Project | null }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between">
      <div>
        <h1 className="text-xl font-bold text-stone-900">{t("dashboard.headerSkeletonTitle")}</h1>
        {project && <p className="mt-1 text-sm text-stone-500">{project.name}</p>}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// A small, consistent line-icon set — every icon here is a plain inline
// SVG (no new dependency), one stroke weight, used only where it marks a
// real domain or a real severity: the financial-flow stages, the health
// strip's six domains, exception severity, and the "+" on a quick action.
// ─────────────────────────────────────────────────────────────────────────
type IconProps = SVGProps<SVGSVGElement>;
const iconBase = { width: 15, height: 15, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

const IconAlertTriangle = (p: IconProps) => (
  <svg {...iconBase} {...p}><path d="M10.5 4 2 19h20L13.5 4a1.7 1.7 0 0 0-3 0z" /><path d="M12 10v4M12 17h.01" /></svg>
);
const IconAlertCircle = (p: IconProps) => (
  <svg {...iconBase} {...p}><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></svg>
);
const IconInfo = (p: IconProps) => (
  <svg {...iconBase} {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>
);
const IconPlus = (p: IconProps) => (
  <svg {...iconBase} {...p}><path d="M12 5v14M5 12h14" /></svg>
);
const IconMoney = (p: IconProps) => (
  <svg {...iconBase} {...p}><circle cx="12" cy="12" r="9" /><path d="M9 15c0 1.1 1.3 2 3 2s3-.9 3-2-1.3-1.6-3-2-3-.9-3-2 1.3-2 3-2 3 .9 3 2" /></svg>
);
const IconWallet = (p: IconProps) => (
  <svg {...iconBase} {...p}><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5h11A2.5 2.5 0 0 1 20 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z" /><path d="M15.5 12.5h2.5a1 1 0 0 0 0-2h-2.5a1 1 0 0 0 0 2z" /></svg>
);
const IconClipboard = (p: IconProps) => (
  <svg {...iconBase} {...p}><rect x="5" y="4.5" width="14" height="17" rx="2" /><path d="M9 4V3.5A1.5 1.5 0 0 1 10.5 2h3A1.5 1.5 0 0 1 15 3.5V4M8.5 11h7M8.5 15h5" /></svg>
);
const IconPackage = (p: IconProps) => (
  <svg {...iconBase} {...p}><path d="M21 8.5v7L12 20l-9-4.5v-7L12 4z" /><path d="M3.5 8.5L12 12l8.5-3.5M12 12v8" /></svg>
);
const IconBars = (p: IconProps) => (
  <svg {...iconBase} {...p}><path d="M5 20V10M12 20V4M19 20v-7" /></svg>
);
const IconShield = (p: IconProps) => (
  <svg {...iconBase} {...p}><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" /></svg>
);
const IconCalendar = (p: IconProps) => (
  <svg {...iconBase} {...p}><rect x="3.5" y="5" width="17" height="15.5" rx="2" /><path d="M3.5 9.5h17M8 3v4M16 3v4" /></svg>
);
const IconTrendUp = (p: IconProps) => (
  <svg {...iconBase} {...p}><path d="M4 16l5-5 4 4 7-8" /><path d="M14 6h6v6" /></svg>
);
const IconChevron = (p: IconProps & { mirror?: boolean }) => {
  const { mirror, ...rest } = p;
  return (
    <svg {...iconBase} {...rest} style={mirror ? { transform: "scaleX(-1)" } : undefined}>
      <path d="M9 5l7 7-7 7" />
    </svg>
  );
};

// ── Verdict block — condition, one-line insight, three headline numbers ─
// The hero: one bordered card (a defined surface, unlike every purely
// typographic section below it) carrying the verdict, its one-line
// insight, three headline stats each with its own thin progress bar, and
// — on wide screens — a compact identity panel (dates, contract value,
// an overall-progress ring) sharing the same card. Every figure here is
// real: progress/costConsumption/variancePercent are the same values
// already computed in OverviewSection(); startDate/endDate/daysRemaining
// are read straight off the project/contract records (a plain date
// subtraction for the day count, never a fabricated figure) and simply
// omitted when the underlying record has none, never shown as a guess.
function VerdictBlock({
  project,
  contract,
  verdict,
  insight,
  progress,
  costConsumption,
  variancePercent,
  lastActivityAt,
}: {
  project: Project;
  contract: Contract | null;
  verdict: "healthy" | "watch" | "critical";
  insight: string;
  progress: number | null;
  costConsumption: number | null;
  variancePercent: number | null;
  lastActivityAt: string;
}) {
  const { t, locale } = useTranslation();
  const verdictColor: Record<typeof verdict, string> = {
    healthy: "text-success-700",
    watch: "text-warning-700",
    critical: "text-danger-700",
  };
  const dotColor: Record<typeof verdict, string> = {
    healthy: "bg-success-500",
    watch: "bg-warning-500",
    critical: "bg-danger-500",
  };
  const badgePillTone: Record<typeof verdict, string> = {
    healthy: "bg-success-100 text-success-700",
    watch: "bg-warning-100 text-warning-700",
    critical: "bg-danger-100 text-danger-700",
  };
  const accentBorder: Record<typeof verdict, string> = {
    healthy: "border-s-success-500",
    watch: "border-s-warning-500",
    critical: "border-s-danger-500",
  };

  const startDate = project.startDate ?? contract?.startDate ?? null;
  const endDate = contract?.endDate ?? null;
  const daysRemaining = endDate ? Math.ceil((new Date(endDate).getTime() - Date.now()) / 86400000) : null;

  return (
    <div className={`rounded-xl border border-s-4 border-stone-200 bg-white p-5 sm:p-7 ${accentBorder[verdict]}`}>
      {/* xl, not lg: the desktop sidebar (ProjectSidebar.tsx) also claims
          its fixed width starting exactly at `lg` (1024px) — switching
          this hero to a row layout at that same breakpoint left the ring
          side-by-side with the 3-stat grid at the one width with the
          least real room, and the stats visually overlapped (confirmed
          live: "53%"/"62%"/"0%" rendered on top of each other at exactly
          1024px). Every other multi-column switch on this page already
          waits for `xl` for the same reason. */}
      <div className="flex flex-col gap-7 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${badgePillTone[verdict]}`}>
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotColor[verdict]}`} aria-hidden="true" />
              {t(`dashboard.status.${project.status}`)}
            </span>
            <span className="truncate text-xs font-medium text-stone-400">{project.name}</span>
          </div>

          <h1 className={`mt-3 text-2xl font-bold tracking-tight sm:text-3xl ${verdictColor[verdict]}`}>{t(`dashboard.verdict.${verdict}`)}</h1>
          <p className="mt-1.5 max-w-2xl text-sm text-stone-500">{insight}</p>

          <div className="mt-7 grid grid-cols-1 gap-6 sm:grid-cols-3">
            <HeroStat
              label={t("dashboard.identity.progress")}
              display={progress !== null ? formatPercent(progress, 1, locale) : "—"}
              tone="success"
              barValue={progress}
              barColor="bg-success-500"
              hint={progress === null ? t("dashboard.identity.noData") : undefined}
            />
            <HeroStat
              label={t("dashboard.costProgress.costConsumption")}
              display={costConsumption !== null ? formatPercent(costConsumption, 1, locale) : "—"}
              tone="info"
              barValue={costConsumption}
              barColor="bg-sky-500"
            />
            <HeroStat
              label={t("dashboard.financial.expectedVariance")}
              display={variancePercent !== null ? formatPercent(variancePercent, 1, locale) : "—"}
              tone="purple"
              barValue={variancePercent !== null ? Math.abs(variancePercent) : null}
              barColor="bg-purple-500"
            />
          </div>
        </div>

        <div className="flex shrink-0 flex-row items-center gap-6 border-t border-stone-100 pt-6 xl:flex-col xl:items-stretch xl:border-t-0 xl:border-s xl:ps-7 xl:pt-0">
          <ProgressRing value={progress} locale={locale} />
          <div className="min-w-0 flex-1 space-y-2.5 text-xs">
            {startDate && <InfoRow icon={IconCalendar} label={t("dashboard.identity.startDate")} value={formatDate(startDate, locale)} />}
            {endDate && <InfoRow icon={IconCalendar} label={t("dashboard.identity.expectedCompletion")} value={formatDate(endDate, locale)} />}
            {daysRemaining !== null && daysRemaining >= 0 && (
              <InfoRow icon={IconClipboard} label={t("dashboard.identity.expectedCompletion")} value={t("dashboard.identity.daysRemainingCount", { count: daysRemaining })} />
            )}
            {contract && <InfoRow icon={IconMoney} label={t("dashboard.identity.contractValue")} value={formatMoney(contract.revisedValue, contract.currency, locale)} />}
          </div>
        </div>
      </div>
    </div>
  );
}

function HeroStat({
  label,
  display,
  tone = "default",
  barValue,
  barColor,
  hint,
}: {
  label: string;
  display: string;
  tone?: "default" | "success" | "danger" | "info" | "purple";
  barValue?: number | null;
  barColor?: string;
  hint?: string;
}) {
  const color =
    tone === "danger"
      ? "text-danger-700"
      : tone === "success"
        ? "text-success-700"
        : tone === "info"
          ? "text-sky-700"
          : tone === "purple"
            ? "text-purple-700"
            : "text-stone-900";
  const pct = barValue !== undefined && barValue !== null ? Math.min(100, Math.max(0, barValue)) : null;
  return (
    <div className="min-w-0">
      <p className={`text-3xl font-extrabold tracking-tight tabular-nums sm:text-4xl ${color}`}>{display}</p>
      <p className="mt-1 text-xs font-medium text-stone-500">{label}</p>
      {hint && <p className="mt-0.5 text-[11px] text-stone-400">{hint}</p>}
      {barColor && (
        <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-stone-100">
          <div className={`h-full rounded-full ${barColor}`} style={{ width: `${pct ?? 0}%` }} />
        </div>
      )}
    </div>
  );
}

// The one genuine chart element in the hero: a single real percentage
// (avgProgress, already computed once in OverviewSection()) rendered as an
// SVG ring — never a fabricated time series.
function ProgressRing({ value, locale }: { value: number | null; locale: string }) {
  const size = 84;
  const stroke = 8;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const pct = Math.min(100, Math.max(0, value ?? 0));
  const offset = circumference * (1 - pct / 100);
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#f1f5f9" strokeWidth={stroke} />
        {value !== null && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="#0f766e"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
          />
        )}
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-base font-extrabold text-stone-900">{value !== null ? formatPercent(value, 0, locale) : "—"}</span>
      </div>
    </div>
  );
}

function InfoRow({ icon: Icon, label, value }: { icon: (p: IconProps) => JSX.Element; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="shrink-0 text-stone-300" />
      <span className="min-w-0 flex-1 truncate text-stone-400">{label}</span>
      <span className="shrink-0 whitespace-nowrap font-semibold text-stone-700">{value}</span>
    </div>
  );
}

// ── Health line — a single quiet inline strip, not a grid of colored tiles
type HealthTone = "healthy" | "watch" | "critical" | "neutral";
const healthDotColor: Record<HealthTone, string> = {
  healthy: "bg-success-500",
  watch: "bg-warning-500",
  critical: "bg-danger-500",
  neutral: "bg-stone-300",
};

interface HealthIndicator {
  key: string;
  label: string;
  tone: HealthTone;
  statusText: string;
  metric: string;
  href: string;
}

function computeHealth(input: {
  t: (key: string, vars?: Record<string, string | number>) => string;
  locale: string;
  activeAlerts: BudgetAlert[];
  overdueTasks: ProjectTask[];
  scheduleHasData: boolean;
  cashFlowNet: number;
  pendingCommitments: Commitment[];
  measurementsAwaitingApproval: Measurement[];
  measurementsHaveData: boolean;
}): HealthIndicator[] {
  const { t, locale } = input;
  const costTone: HealthTone = input.activeAlerts.some((a) => a.severity === "critical")
    ? "critical"
    : input.activeAlerts.length > 0
      ? "watch"
      : "healthy";

  const scheduleTone: HealthTone = !input.scheduleHasData ? "neutral" : input.overdueTasks.length > 0 ? "critical" : "healthy";

  const cashTone: HealthTone = input.cashFlowNet >= 0 ? "healthy" : "watch";

  const procurementTone: HealthTone = input.pendingCommitments.length > 0 ? "watch" : "healthy";

  const progressTone: HealthTone = !input.measurementsHaveData
    ? "neutral"
    : input.measurementsAwaitingApproval.length > 0
      ? "watch"
      : "healthy";

  return [
    {
      key: "cost",
      label: t("dashboard.health.cost"),
      tone: costTone,
      statusText:
        costTone === "critical"
          ? t("dashboard.health.costCritical")
          : costTone === "watch"
            ? t("dashboard.health.costWatch")
            : t("dashboard.health.costHealthy"),
      metric: t("dashboard.health.activeAlertsCount", { count: input.activeAlerts.length }),
      href: "cost-plan",
    },
    {
      key: "schedule",
      label: t("dashboard.health.schedule"),
      tone: scheduleTone,
      statusText: !input.scheduleHasData
        ? t("dashboard.health.scheduleNoData")
        : scheduleTone === "critical"
          ? t("dashboard.health.scheduleCritical")
          : t("dashboard.health.scheduleHealthy"),
      metric: input.scheduleHasData ? t("dashboard.health.overdueTasksCount", { count: input.overdueTasks.length }) : "—",
      href: "schedule",
    },
    {
      key: "cashflow",
      label: t("dashboard.health.cashflow"),
      tone: cashTone,
      statusText: cashTone === "healthy" ? t("dashboard.health.cashHealthy") : t("dashboard.health.cashWatch"),
      metric: formatMoney(input.cashFlowNet, "SAR", locale),
      href: "cash-flow",
    },
    {
      key: "procurement",
      label: t("dashboard.health.procurement"),
      tone: procurementTone,
      statusText:
        procurementTone === "healthy" ? t("dashboard.health.procurementHealthy") : t("dashboard.health.procurementWatch"),
      metric: t("dashboard.health.pendingCommitmentsCount", { count: input.pendingCommitments.length }),
      href: "procurement",
    },
    {
      key: "progress",
      label: t("dashboard.health.progress"),
      tone: progressTone,
      statusText: !input.measurementsHaveData
        ? t("dashboard.health.progressNoData")
        : progressTone === "watch"
          ? t("dashboard.health.progressWatch")
          : t("dashboard.health.progressHealthy"),
      metric: input.measurementsHaveData
        ? t("dashboard.health.pendingMeasurementsCount", { count: input.measurementsAwaitingApproval.length })
        : "—",
      href: "progress",
    },
    {
      key: "compliance",
      label: t("dashboard.health.compliance"),
      tone: "neutral",
      statusText: t("dashboard.health.complianceStatus"),
      metric: t("dashboard.health.complianceMetric"),
      href: "__company_compliance__",
    },
  ];
}

function deriveVerdict(health: HealthIndicator[]): "healthy" | "watch" | "critical" {
  if (health.some((h) => h.tone === "critical")) return "critical";
  if (health.some((h) => h.tone === "watch")) return "watch";
  return "healthy";
}

const healthIcon: Record<string, (p: IconProps) => JSX.Element> = {
  cost: IconMoney,
  schedule: IconCalendar,
  cashflow: IconWallet,
  procurement: IconPackage,
  progress: IconBars,
  compliance: IconShield,
};
const healthPillTone: Record<HealthTone, string> = {
  healthy: "bg-success-50 text-success-700 border-success-200",
  watch: "bg-warning-50 text-warning-700 border-warning-200",
  critical: "bg-danger-50 text-danger-700 border-danger-200",
  neutral: "bg-stone-50 text-stone-500 border-stone-200",
};

function HealthLine({ health, projectId }: { health: HealthIndicator[]; projectId: string }) {
  const { t } = useTranslation();
  return (
    <div>
      <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-stone-400">{t("dashboard.health.title")}</p>
      <div className="flex flex-wrap gap-2">
        {health.map((h) => {
          const Icon = healthIcon[h.key] ?? IconInfo;
          return (
            <Link
              key={h.key}
              to={h.href === "__company_compliance__" ? "/labor-compliance" : `/projects/${projectId}/${h.href}`}
              className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition hover:opacity-80 ${healthPillTone[h.tone]}`}
            >
              <Icon className="shrink-0" />
              <span className="font-semibold">{h.label}</span>
              <span className="opacity-80">{h.statusText}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

// ── Financial Control — a connected flow, not six independent cards ─────
// forecast.methods.commitment_aware already bundles the entire
// Contract→Budget→Actual→Committed→EAC→Variance chain in one
// already-authoritative object — this section is a presentation of that
// one object as a single connected track (thin dividers, not boxes),
// ending in one distinguished variance stat set off by a top rule instead
// of another equal cell.
const boqRevisionStatusTone: Record<BoqRevision["status"], "neutral" | "success" | "warning"> = {
  draft: "warning",
  published: "success",
  superseded: "neutral",
};

function FinancialControl({
  contract,
  forecast,
  revision,
  projectId,
}: {
  contract: Contract | null;
  forecast: ForecastResult;
  revision: BoqRevision | null;
  projectId: string;
}) {
  const { t, locale } = useTranslation();
  const m = forecast.methods.commitment_aware;
  const overBudget = m.variance < 0;

  // Every value read verbatim off forecast.methods.commitment_aware / the
  // contract, never recomputed. Each stage is a self-sized chip (icon +
  // label + value) in a flex-wrap row, never a forced equal-width column —
  // an earlier equal-column attempt at this same five-stage row left too
  // little room per figure and either broke a number mid-digit or hid it
  // behind an ellipsis entirely (confirmed live, both worse than wrapping).
  // A chip only ever wraps to its own next line; it never has to shrink
  // below its own content width, so a money value here can never truncate.
  const stages: { label: string; value: number; href: string; icon: (p: IconProps) => JSX.Element; iconTone: string }[] = [
    { label: t("dashboard.financial.contractValue"), value: contract ? Number(contract.revisedValue) : m.costPlan, href: "contract", icon: IconMoney, iconTone: "bg-sky-100 text-sky-700" },
    { label: t("dashboard.financial.approvedBudget"), value: m.costPlan, href: "cost-plan", icon: IconClipboard, iconTone: "bg-purple-100 text-purple-700" },
    { label: t("dashboard.financial.actualCost"), value: m.actualCost, href: "actual-cost", icon: IconWallet, iconTone: "bg-warning-100 text-warning-700" },
    { label: t("dashboard.financial.commitments"), value: m.committedCost, href: "procurement", icon: IconPackage, iconTone: "bg-success-100 text-success-700" },
    { label: t("dashboard.financial.forecastAtCompletion"), value: m.eac, href: "forecast", icon: IconBars, iconTone: "bg-sky-100 text-sky-700" },
  ];

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-bold uppercase tracking-wide text-stone-900">{t("dashboard.financial.title")}</h2>
        <span className="text-xs text-stone-400">{t("dashboard.financial.asOf", { date: formatDate(forecast.asOfDate, locale) })}</span>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-x-1 gap-y-4">
        {stages.map((s, i) => (
          <div key={s.label} className="flex items-center gap-1">
            {i > 0 && <span className="mx-1 hidden h-px w-4 shrink-0 bg-stone-200 sm:block" aria-hidden="true" />}
            <Link
              to={`/projects/${projectId}/${s.href}`}
              className="flex items-center gap-2.5 rounded-lg border border-stone-200 px-3 py-2.5 transition hover:border-stone-300 hover:bg-stone-50"
            >
              <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${s.iconTone}`}>
                <s.icon />
              </span>
              <span className="min-w-0">
                <span className="block whitespace-nowrap text-[11px] font-medium uppercase tracking-wide text-stone-400">{s.label}</span>
                <span className="block whitespace-nowrap text-sm font-bold tabular-nums text-stone-900">{formatMoney(s.value, forecast.currency, locale)}</span>
              </span>
            </Link>
          </div>
        ))}
        <span className="mx-1 hidden h-px w-4 shrink-0 bg-stone-200 sm:block" aria-hidden="true" />
        <div className={`flex items-center gap-2.5 rounded-lg border px-3 py-2.5 ${overBudget ? "border-danger-200 bg-danger-50" : "border-success-200 bg-success-50"}`}>
          <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${overBudget ? "bg-danger-100 text-danger-700" : "bg-success-100 text-success-700"}`}>
            {overBudget ? <IconAlertTriangle /> : <IconTrendUp />}
          </span>
          <span className="min-w-0">
            <span className={`block whitespace-nowrap text-[11px] font-medium uppercase tracking-wide ${overBudget ? "text-danger-600" : "text-success-600"}`}>
              {t("dashboard.financial.expectedVariance")}
              {overBudget ? t("dashboard.financial.overBudgetSuffix") : ""}
            </span>
            <span className={`block whitespace-nowrap text-sm font-extrabold tabular-nums ${overBudget ? "text-danger-700" : "text-success-700"}`}>
              {formatMoney(m.variance, forecast.currency, locale)} ({formatPercent(m.variancePercent, 1, locale)})
            </span>
          </span>
        </div>
      </div>

      {revision && (
        <p className="mt-4 text-xs text-stone-400">
          {t("dashboard.financial.boqRevision", { number: revision.revisionNumber })}{" "}
          <Badge tone={boqRevisionStatusTone[revision.status]}>{t(`dashboard.financial.boqRevisionStatus.${revision.status}`)}</Badge>{" "}
          <Link to={`/projects/${projectId}/boq`} className="text-primary hover:underline">
            {t("dashboard.financial.openBoq")}
          </Link>
        </p>
      )}
    </div>
  );
}

// ── Exceptions — an action system, not an activity feed ─────────────────
type AttentionSeverity = "critical" | "attention" | "info";
interface AttentionItem {
  severity: AttentionSeverity;
  text: string;
  metric?: string;
  href: string;
}

function buildNeedsAttention(input: {
  t: (key: string, vars?: Record<string, string | number>) => string;
  locale: string;
  projectId: string;
  activeAlerts: BudgetAlert[];
  overdueTasks: ProjectTask[];
  criticalPunch: PunchItem[];
  ipcsAwaitingCertification: Ipc[];
  pendingCommitments: Commitment[];
  measurementsAwaitingApproval: Measurement[];
  forecastMethod: ForecastResult["methods"]["commitment_aware"];
}): AttentionItem[] {
  const { t, locale } = input;
  const items: AttentionItem[] = [];
  const p = input.projectId;

  if (input.forecastMethod.variance < 0) {
    items.push({
      severity: "critical",
      text: t("dashboard.needsAttention.forecastOverBudget"),
      metric: formatMoney(Math.abs(input.forecastMethod.variance), "SAR", locale),
      href: `/projects/${p}/forecast`,
    });
  }
  for (const a of [...input.activeAlerts].sort((x, y) => (x.severity === "critical" ? -1 : 1)).slice(0, 3)) {
    items.push({
      severity: a.severity === "critical" ? "critical" : a.severity === "warning" ? "attention" : "info",
      text: a.title,
      metric: t(`dashboard.needsAttention.${alertSeverityKey[a.severity]}`),
      href: `/budget-alerts?projectId=${p}`,
    });
  }
  if (input.criticalPunch.length > 0) {
    items.push({
      severity: "critical",
      text: t("dashboard.needsAttention.criticalPunchCount", { count: input.criticalPunch.length }),
      href: `/projects/${p}/punch-list`,
    });
  }
  if (input.overdueTasks.length > 0) {
    items.push({
      severity: "attention",
      text: t("dashboard.needsAttention.overdueTasksCount", { count: input.overdueTasks.length }),
      href: `/projects/${p}/schedule`,
    });
  }
  if (input.ipcsAwaitingCertification.length > 0) {
    items.push({
      severity: "attention",
      text: t("dashboard.needsAttention.ipcAwaitingCertCount", { count: input.ipcsAwaitingCertification.length }),
      href: `/projects/${p}/ipc`,
    });
  }
  if (input.pendingCommitments.length > 0) {
    items.push({
      severity: "attention",
      text: t("dashboard.needsAttention.pendingCommitmentsCount", { count: input.pendingCommitments.length }),
      href: `/projects/${p}/procurement`,
    });
  }
  if (input.measurementsAwaitingApproval.length > 0) {
    items.push({
      severity: "info",
      text: t("dashboard.needsAttention.measurementsAwaitingCount", { count: input.measurementsAwaitingApproval.length }),
      href: `/projects/${p}/progress`,
    });
  }

  const rank: Record<AttentionSeverity, number> = { critical: 0, attention: 1, info: 2 };
  return items.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

const attentionIcon: Record<AttentionSeverity, (p: IconProps) => JSX.Element> = {
  critical: IconAlertTriangle,
  attention: IconAlertCircle,
  info: IconInfo,
};
const attentionAccent: Record<AttentionSeverity, string> = {
  critical: "border-s-danger-500 text-danger-600",
  attention: "border-s-warning-500 text-warning-600",
  info: "border-s-info-500 text-info-600",
};

const attentionBg: Record<AttentionSeverity, string> = {
  critical: "bg-danger-50/60 hover:bg-danger-50",
  attention: "bg-warning-50/60 hover:bg-warning-50",
  info: "bg-info-50/60 hover:bg-info-50",
};

function ExceptionsPanel({ items }: { items: AttentionItem[] }) {
  const { t, locale } = useTranslation();
  const mirrorChevron = locale === "ar";
  return (
    <div>
      <h2 className="text-sm font-bold uppercase tracking-wide text-stone-900">{t("dashboard.needsAttention.title")}</h2>
      {items.length === 0 ? (
        <p className="mt-4 text-sm text-stone-400">{t("dashboard.needsAttention.empty")}</p>
      ) : (
        <ul className="mt-4 space-y-2">
          {items.map((item, i) => {
            const Icon = attentionIcon[item.severity];
            const [borderClass, colorClass] = attentionAccent[item.severity].split(" ");
            return (
              <li key={i}>
                {/* The text gets its own full-width row and the action
                    button its own row below (never sharing one line) — a
                    shared row squeezed the text into an ugly word-by-word
                    wrap in the narrower English column once a button was
                    added beside it (confirmed live at 1440px). */}
                <Link
                  to={item.href}
                  className={`group block rounded-lg border-s-4 py-2.5 ps-3 pe-2.5 transition ${borderClass} ${attentionBg[item.severity]}`}
                >
                  <div className="flex items-start gap-3">
                    <Icon className={`mt-0.5 shrink-0 ${colorClass}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-stone-700">{item.text}</span>
                      {item.metric && <span className="mt-0.5 block text-xs font-semibold text-stone-500">{item.metric}</span>}
                    </span>
                  </div>
                  <div className="mt-2 flex justify-end">
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-stone-600 transition group-hover:border-stone-300 group-hover:bg-stone-50">
                      {t("dashboard.needsAttention.openAction")}
                      <IconChevron mirror={mirrorChevron} className="shrink-0 text-stone-400" />
                    </span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ── Cost vs Progress — a shared-axis comparison, not two decorative rings
function CostVsProgress({
  budget,
  avgProgress,
  costConsumption,
  gap,
  warnGap,
  headline,
}: {
  budget: BudgetSummary;
  avgProgress: number | null;
  costConsumption: number | null;
  gap: number | null;
  warnGap: boolean;
  headline: string;
}) {
  const { t, locale } = useTranslation();
  const costOverBudget = budget.totals.remaining < 0;

  return (
    <div className="border-t border-stone-200 pt-10">
      <h2 className="text-sm font-bold uppercase tracking-wide text-stone-900">{t("dashboard.costProgress.title")}</h2>
      <p className={`mt-2 text-sm font-semibold ${warnGap ? "text-warning-700" : gap !== null ? "text-success-700" : "text-stone-400"}`}>{headline}</p>

      <div className="mt-6 max-w-2xl space-y-4">
        <ComparisonBar label={t("dashboard.costProgress.actualProgress")} value={avgProgress} color="bg-stone-700" />
        <ComparisonBar label={t("dashboard.costProgress.costConsumption")} value={costConsumption} color={warnGap ? "bg-danger-500" : "bg-success-500"} />
      </div>

      {/* grid-cols-1 below sm: at narrow widths, three-across left too
          little room per figure — text-ellipsis on a right-aligned/RTL
          number truncates from the *start*, hiding the significant
          leading digits (confirmed live: "152,000.00" rendered as
          "…2,000.00"). One column per row at narrow widths always gives a
          money value its full container width instead. */}
      <div className="mt-6 grid max-w-2xl grid-cols-1 gap-4 border-t border-stone-200 pt-5 sm:grid-cols-3 sm:gap-6">
        <PlainStat label={t("dashboard.costProgress.totalPlanned")} value={formatMoney(budget.totals.planned, "SAR", locale)} />
        <PlainStat label={t("dashboard.costProgress.totalSpent")} value={formatMoney(budget.totals.spent, "SAR", locale)} />
        <PlainStat
          label={costOverBudget ? t("dashboard.costProgress.overBudget") : t("dashboard.costProgress.remaining")}
          value={formatMoney(budget.totals.remaining, "SAR", locale)}
          tone={costOverBudget ? "danger" : "default"}
        />
      </div>
    </div>
  );
}

function ComparisonBar({ label, value, color }: { label: string; value: number | null; color: string }) {
  const { locale } = useTranslation();
  const pct = Math.min(100, Math.max(0, value ?? 0));
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between text-sm">
        <span className="font-medium text-stone-600">{label}</span>
        <span className="font-bold tabular-nums text-stone-900">{value !== null ? formatPercent(value, 0, locale) : "—"}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-stone-100">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function PlainStat({ label, value, tone = "default" }: { label: string; value: string; tone?: "default" | "danger" }) {
  const color = tone === "danger" ? "text-danger-700" : "text-stone-900";
  return (
    <div className="min-w-0">
      <p className="truncate text-xs text-stone-500">{label}</p>
      <p className={`mt-1 whitespace-nowrap text-base font-bold tabular-nums ${color}`}>{value}</p>
    </div>
  );
}

// A compact label:value row shared by the Delivery/Cash/Commercial columns.
function PlainRow({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "default" | "success" | "warning" | "danger";
}) {
  const color = tone === "success" ? "text-success-700" : tone === "warning" ? "text-warning-700" : tone === "danger" ? "text-danger-700" : "text-stone-800";
  // Label above, value below — the same convention as PlainStat and the
  // Financial Control ledger, used everywhere on this page now. Stacking
  // (rather than a same-line label:value pair) means the value never
  // competes with the label for width, so neither one needs to truncate
  // even in the narrowest of the three Delivery/Cash/Commercial columns —
  // a same-line layout tried earlier here still truncated long English
  // labels ("Total com…", "Awaiting ap…") at that width.
  return (
    <div>
      <p className="text-xs text-stone-500">{label}</p>
      <p className={`mt-0.5 whitespace-nowrap text-sm font-semibold tabular-nums ${color}`}>{value}</p>
      {hint && <p className="mt-0.5 truncate text-xs text-stone-400">{hint}</p>}
    </div>
  );
}

// ── Delivery / Cash / Commercial — three quiet columns, divided by a thin
// rule instead of three separate boxes ───────────────────────────────────
function DeliveryColumn({
  projectId,
  tasks,
  overdueTasks,
  nextMilestone,
  avgProgress,
  measurementsAwaitingApproval,
}: {
  projectId: string;
  tasks: ProjectTask[];
  overdueTasks: ProjectTask[];
  nextMilestone: ProjectTask | undefined;
  avgProgress: number | null;
  measurementsAwaitingApproval: Measurement[];
}) {
  const { t, locale } = useTranslation();
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-bold text-stone-900">{t("dashboard.progressSchedule.title")}</h3>
        <Link to={`/projects/${projectId}/schedule`} className="text-xs font-medium text-primary hover:underline">
          {t("dashboard.progressSchedule.openSchedule")}
        </Link>
      </div>
      {tasks.length === 0 ? (
        <p className="mt-3 text-sm text-stone-400">{t("dashboard.progressSchedule.noData")}</p>
      ) : (
        <div className="mt-3 space-y-3">
          <PlainRow label={t("dashboard.progressSchedule.overallProgress")} value={avgProgress !== null ? formatPercent(avgProgress, 1, locale) : "—"} />
          <PlainRow
            label={t("dashboard.progressSchedule.scheduleStatus")}
            value={overdueTasks.length > 0 ? t("dashboard.progressSchedule.tasksOverdueCount", { count: overdueTasks.length }) : t("dashboard.progressSchedule.onTrack")}
            tone={overdueTasks.length > 0 ? "warning" : "success"}
          />
          <PlainRow label={t("dashboard.progressSchedule.nextMilestone")} value={nextMilestone ? formatDate(nextMilestone.endDate, locale) : "—"} hint={nextMilestone?.name} />
        </div>
      )}
      {measurementsAwaitingApproval.length > 0 && (
        <p className="mt-3 text-xs text-stone-500">
          <Link to={`/projects/${projectId}/progress`} className="text-primary hover:underline">
            {t("dashboard.progressSchedule.measurementsAwaitingCount", { count: measurementsAwaitingApproval.length })}
          </Link>
        </p>
      )}
    </div>
  );
}

function CashColumn({ cashFlow, projectId }: { cashFlow: CashFlowResult; projectId: string }) {
  const { t, locale } = useTranslation();
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-bold text-stone-900">{t("dashboard.cashFlow.title")}</h3>
        <Link to={`/projects/${projectId}/cash-flow`} className="text-xs font-medium text-primary hover:underline">
          {t("dashboard.cashFlow.fullDetails")}
        </Link>
      </div>
      <div className="mt-3 space-y-3">
        <PlainRow label={t("dashboard.cashFlow.collected")} value={formatMoney(cashFlow.historical.cashReceived, cashFlow.currency, locale)} />
        <PlainRow label={t("dashboard.cashFlow.incurredCost")} value={formatMoney(cashFlow.historical.incurredCost, cashFlow.currency, locale)} />
        <PlainRow label={t("dashboard.cashFlow.expectedReceivables")} value={formatMoney(cashFlow.projected.receivables, cashFlow.currency, locale)} />
        <PlainRow
          label={t("dashboard.cashFlow.projectedNet")}
          value={formatMoney(cashFlow.projected.net, cashFlow.currency, locale)}
          tone={cashFlow.projected.net < 0 ? "danger" : "success"}
        />
      </div>
    </div>
  );
}

// IPC and distributed labor cost are two distinct real data sources (Ipc[]
// and ProjectLaborCost) — grouped with Procurement purely as presentation
// (three sub-blocks sharing one column instead of three competing cards),
// each keeping its own figures and drill-down link untouched. IPC never
// blends with Forecast/Cash Flow/Actual Cost — each sub-block reads only
// its own already-authoritative source.
function CommercialColumn({
  projectId,
  totalCommitted,
  approvedCommitted,
  pendingCommitted,
  pendingCount,
  awaitingCertification,
  awaitingApproval,
  certifiedTotal,
  certifiedCount,
  currency,
  laborCost,
}: {
  projectId: string;
  totalCommitted: number;
  approvedCommitted: number;
  pendingCommitted: number;
  pendingCount: number;
  awaitingCertification: number;
  awaitingApproval: number;
  certifiedTotal: number;
  certifiedCount: number;
  currency: string;
  laborCost: ProjectLaborCost;
}) {
  const { t, locale } = useTranslation();
  return (
    <div>
      <h3 className="text-sm font-bold text-stone-900">{t("dashboard.commercial.title")}</h3>
      <p className="text-xs text-stone-400">{t("dashboard.commercial.subtitle")}</p>

      <div className="mt-4 flex items-baseline justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-stone-400">{t("dashboard.procurement.title")}</p>
        <Link to={`/projects/${projectId}/procurement`} className="text-xs font-medium text-primary hover:underline">
          {t("dashboard.procurement.open")}
        </Link>
      </div>
      <div className="mt-2 space-y-3">
        <PlainRow label={t("dashboard.procurement.totalCommitted")} value={formatMoney(totalCommitted, currency, locale)} />
        <PlainRow label={t("dashboard.procurement.activeExecuted")} value={formatMoney(approvedCommitted, currency, locale)} tone="success" />
        <PlainRow label={t("dashboard.procurement.pendingApprovalCount", { count: pendingCount })} value={formatMoney(pendingCommitted, currency, locale)} tone="warning" />
      </div>

      <div className="mt-4 flex items-baseline justify-between gap-2 border-t border-stone-200 pt-4">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-stone-400">{t("dashboard.commercial.ipcTitle")}</p>
        <Link to={`/projects/${projectId}/ipc`} className="text-xs font-medium text-primary hover:underline">
          {t("dashboard.commercial.openCertificates")}
        </Link>
      </div>
      <div className="mt-2 space-y-3">
        <PlainRow label={t("dashboard.commercial.certifiedValueCount", { count: certifiedCount })} value={formatMoney(certifiedTotal, currency, locale)} tone="success" />
        <PlainRow label={t("dashboard.commercial.awaitingCertification")} value={String(awaitingCertification)} tone={awaitingCertification > 0 ? "warning" : "default"} />
        <PlainRow label={t("dashboard.commercial.awaitingApproval")} value={String(awaitingApproval)} tone={awaitingApproval > 0 ? "warning" : "default"} />
      </div>

      <div className="mt-4 flex items-baseline justify-between gap-2 border-t border-stone-200 pt-4">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-stone-400">{t("dashboard.commercial.laborTitle")}</p>
        {laborCost.allocationCount > 0 && laborCost.posted && <Badge tone="success">{t("dashboard.commercial.fullyPosted")}</Badge>}
      </div>
      {laborCost.allocationCount === 0 ? (
        <p className="mt-2 text-sm text-stone-400">{t("dashboard.commercial.noLaborCost")}</p>
      ) : (
        <div className="mt-2 space-y-3">
          <PlainRow label={t("dashboard.commercial.totalAllocated")} value={formatMoney(laborCost.allocatedTotal, "SAR", locale)} />
          <PlainRow label={t("dashboard.commercial.allocationCount")} value={String(laborCost.allocationCount)} />
        </div>
      )}
      <p className="mt-3 text-end text-xs">
        <Link to="/payroll" className="font-medium text-primary hover:underline">
          {t("dashboard.commercial.viewPayrollDetails")}
        </Link>
      </p>
    </div>
  );
}

// ── Pulse + Quick Actions — the lowest-priority information on the page ─
const KNOWN_ACTIVITY_VERBS = new Set([
  "ipc.certified",
  "ipc.approved",
  "ipc.submitted",
  "ipc.rejected",
  "commitment.approved",
  "commitment.submitted",
  "commitment.termsUpdated",
  "measurement.approved",
  "measurement.submitted",
  "boq_revision.published",
]);

function activityVerbLabel(t: (key: string) => string, action: string): string {
  return KNOWN_ACTIVITY_VERBS.has(action) ? t(`dashboard.activity.verbs.${action}`) : action;
}

function ActivityPulse({ events }: { events: ActivityEvent[] }) {
  const { t, locale } = useTranslation();
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-400">{t("dashboard.activity.title")}</h3>
      {events.length === 0 ? (
        <p className="mt-2 text-sm text-stone-400">{t("dashboard.activity.empty")}</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {events.map((e) => (
            <li key={e.id} className="flex items-center justify-between gap-3 text-xs">
              <span className="text-stone-600">{activityVerbLabel(t, e.action)}</span>
              <span className="shrink-0 text-stone-400">{formatDateTime(e.createdAt, locale)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Plain navigation to each domain's own existing, already permission-gated
// create flow — this never duplicates a Can-wrapped create button itself,
// it only links to the screen that owns it.
function QuickActionsRow({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  // Document upload has no owner-only gate anywhere in this codebase
  // (create/read are member-open, same posture as Tasks/Daily Logs), so
  // it renders unconditionally — every other action below mirrors an
  // existing owner-only permission from auth/permissions.ts exactly.
  const gatedActions: { labelKey: string; href: string; permission: Parameters<typeof Can>[0]["permission"] }[] = [
    { labelKey: "boqItem", href: "boq", permission: "boq.manage" },
    { labelKey: "commitment", href: "procurement", permission: "commitment.manage" },
    { labelKey: "expense", href: "actual-cost", permission: "budget.manage" },
    { labelKey: "ipc", href: "ipc", permission: "ipc.manage" },
  ];
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-stone-400">{t("dashboard.quickActions.title")}</h3>
      <div className="mt-2 flex flex-wrap gap-2">
        {gatedActions.map((a, i) => (
          <Can key={a.href} permission={a.permission}>
            <Link to={`/projects/${projectId}/${a.href}`}>
              <Button variant={i === 0 ? "primary" : "secondary"} size="sm" className="flex items-center gap-1.5">
                <IconPlus width={14} height={14} />
                {t(`dashboard.quickActions.${a.labelKey}`)}
              </Button>
            </Link>
          </Can>
        ))}
        <Link to={`/projects/${projectId}/documents`}>
          <Button variant="secondary" size="sm" className="flex items-center gap-1.5">
            <IconPlus width={14} height={14} />
            {t("dashboard.quickActions.uploadDocument")}
          </Button>
        </Link>
      </div>
    </div>
  );
}
