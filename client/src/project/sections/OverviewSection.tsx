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
    // A single-viewport command center on desktop, not a long vertical
    // report: gap-3/xl:gap-4 (not the gap-10/gap-14 every earlier version
    // of this page used) and every card below is deliberately compact —
    // reduced padding, smaller type, tighter internal spacing — so the
    // whole page's primary decision-making information (hero, health,
    // financial pipeline, exceptions, cost vs progress, delivery, cash,
    // commercial, pulse, quick actions) targets fitting inside a
    // 1440×900 viewport without scrolling (verified live). Two panels
    // whose real content can genuinely outgrow that budget — Needs
    // Attention's item list and the activity feed — get their own
    // internal scroll (max-h + overflow-y-auto) instead: every item is
    // still fully present and one scroll away, never removed, shrunk
    // illegibly, or hidden behind a tooltip.
    <div className="flex flex-col gap-2 xl:gap-2">
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
      <div className="grid grid-cols-1 gap-2 xl:grid-cols-12 xl:gap-2 xl:[&>*]:h-[140px]">
        <div className="xl:col-span-7">
          <FinancialControl contract={mainContract} forecast={data.forecast} revision={latestRevision} projectId={projectId} />
        </div>
        <div className="xl:col-span-5">
          <ExceptionsPanel items={needsAttention} />
        </div>
      </div>

      {/* Cost vs Progress, Delivery, Cash, Commercial, and Pulse all share
          one row on desktop instead of stacking as four separate full-
          width sections — the composition the reference targets. */}
      {/* xl:h-64 pins this whole row to one fixed height instead of letting
          the tallest card (Commercial, with three sub-sections) stretch
          every sibling to match it — Commercial and Pulse, the two cards
          whose real content can genuinely exceed that height, scroll
          internally instead (nothing dropped, one scroll away). */}
      <div className="grid grid-cols-1 gap-2 xl:grid-cols-12 xl:gap-2 xl:[&>*]:h-[195px]">
        <div className="xl:col-span-4">
          <CostVsProgress
            budget={data.budget}
            avgProgress={avgProgress}
            costConsumption={costConsumption}
            gap={progressCostGap}
            warnGap={gapIsWarning}
            headline={progressCostHeadline}
          />
        </div>
        <div className="xl:col-span-2">
          <DeliveryColumn
            projectId={projectId}
            tasks={data.tasks}
            overdueTasks={overdueTasks}
            nextMilestone={nextMilestone}
            avgProgress={avgProgress}
            measurementsAwaitingApproval={measurementsAwaitingApproval}
          />
        </div>
        <div className="xl:col-span-2">
          <CashColumn cashFlow={data.cashFlow} projectId={projectId} />
        </div>
        <div className="xl:col-span-2">
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
        <div className="xl:col-span-2">
          <ActivityPulse events={projectActivity} />
        </div>
      </div>

      <QuickActionsRow projectId={projectId} />
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
    <div className={`rounded-xl border border-s-4 border-stone-200 bg-white p-2.5 ${accentBorder[verdict]}`}>
      {/* xl, not lg: the desktop sidebar (ProjectSidebar.tsx) also claims
          its fixed width starting exactly at `lg` (1024px) — switching
          this hero to a row layout at that same breakpoint left the ring
          side-by-side with the 3-stat grid at the one width with the
          least real room, and the stats visually overlapped (confirmed
          live: "53%"/"62%"/"0%" rendered on top of each other at exactly
          1024px). Every other multi-column switch on this page already
          waits for `xl` for the same reason. The side panel stays a row
          (icon beside info, never stacked above it) at every width —
          stacking it at xl was the single biggest height cost in the
          whole page in an earlier round, and this hero must stay short
          for the page to fit one desktop viewport. */}
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${badgePillTone[verdict]}`}>
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotColor[verdict]}`} aria-hidden="true" />
              {t(`dashboard.status.${project.status}`)}
            </span>
            <span className="truncate text-xs font-medium text-stone-400">{project.name}</span>
          </div>

          <h1 className={`mt-1 text-base font-bold tracking-tight sm:text-lg ${verdictColor[verdict]}`}>{t(`dashboard.verdict.${verdict}`)}</h1>
          <p className="mt-0.5 max-w-2xl text-xs text-stone-500">{insight}</p>

          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
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

        {/* A deliberately distinct dark brand panel (bg-primary, the app's
            own token) stands in for the reference's project photo — this
            codebase has no real photo of the project to show, so rather
            than fabricate a stock image, the panel itself carries the
            visual weight through color/contrast instead of imagery. */}
        {/* A 2-column mini-grid, not a vertical list: keeps all four real
            facts (start date, end date, days remaining, contract value)
            visible — none dropped to save space — in roughly half the
            vertical room a single column would take. */}
        <div className="relative flex shrink-0 items-center gap-4 overflow-hidden rounded-xl bg-primary p-3 xl:w-80">
          <ConstructionMotif />
          <Gauge value={progress} locale={locale} color="#2dd4bf" trackColor="rgba(255,255,255,0.18)" labelColor="text-white" size={56} stroke={6} />
          <div className="relative grid min-w-0 flex-1 grid-cols-2 gap-x-3 gap-y-1 text-xs">
            {startDate && <InfoRow dark icon={IconCalendar} label={t("dashboard.identity.startDate")} value={formatDate(startDate, locale)} />}
            {endDate && <InfoRow dark icon={IconCalendar} label={t("dashboard.identity.expectedCompletion")} value={formatDate(endDate, locale)} />}
            {daysRemaining !== null && daysRemaining >= 0 && (
              <InfoRow dark icon={IconClipboard} label={t("dashboard.identity.expectedCompletion")} value={t("dashboard.identity.daysRemainingCount", { count: daysRemaining })} />
            )}
            {contract && <InfoRow dark icon={IconMoney} label={t("dashboard.identity.contractValue")} value={formatMoney(contract.revisedValue, contract.currency, locale)} />}
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
      <p className={`text-lg font-extrabold tracking-tight tabular-nums sm:text-xl ${color}`}>{display}</p>
      <p className="text-[11px] font-medium text-stone-500">{label}</p>
      {hint && <p className="text-[10px] text-stone-400">{hint}</p>}
      {barColor && (
        <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-stone-100">
          <div className={`h-full rounded-full ${barColor}`} style={{ width: `${pct ?? 0}%` }} />
        </div>
      )}
    </div>
  );
}

// A decorative skyline-and-crane illustration for the hero's dark identity
// panel — deliberately a drawn SVG motif, never a stock photo: this
// codebase has no real photograph of the project, and passing off a stock
// image as if it depicted this specific building would be exactly the
// kind of fabrication the rest of this page refuses to do. An illustrated
// pattern makes no such claim; it's the same honest move as a skeleton
// loader or a placeholder avatar.
function ConstructionMotif() {
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox="0 0 320 96"
      preserveAspectRatio="xMidYMax slice"
      fill="none"
    >
      <g opacity="0.16" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="18" y="40" width="22" height="56" fill="white" fillOpacity="0.5" stroke="none" />
        <rect x="46" y="26" width="18" height="70" fill="white" fillOpacity="0.35" stroke="none" />
        <rect x="70" y="50" width="16" height="46" fill="white" fillOpacity="0.5" stroke="none" />
        <rect x="230" y="34" width="20" height="62" fill="white" fillOpacity="0.4" stroke="none" />
        <rect x="256" y="52" width="16" height="44" fill="white" fillOpacity="0.5" stroke="none" />
        <rect x="278" y="20" width="18" height="76" fill="white" fillOpacity="0.3" stroke="none" />
        <path d="M92 96V16" />
        <path d="M92 16h58" />
        <path d="M92 30l-14 8" />
        <path d="M150 16v10" />
      </g>
    </svg>
  );
}

// The one genuine chart element in the hero: a single real percentage
// (avgProgress, already computed once in OverviewSection()) rendered as an
// SVG ring — never a fabricated time series. Generalized (color/track/size)
// so the same gauge also drives the Cost vs Progress pair below.
function Gauge({
  value,
  locale,
  color = "#0f766e",
  trackColor = "#f1f5f9",
  labelColor = "text-stone-900",
  size = 84,
  stroke = 8,
}: {
  value: number | null;
  locale: string;
  color?: string;
  trackColor?: string;
  labelColor?: string;
  size?: number;
  stroke?: number;
}) {
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const pct = Math.min(100, Math.max(0, value ?? 0));
  const offset = circumference * (1 - pct / 100);
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={trackColor} strokeWidth={stroke} />
        {value !== null && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
          />
        )}
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className={`text-base font-extrabold ${labelColor}`}>{value !== null ? formatPercent(value, 0, locale) : "—"}</span>
      </div>
    </div>
  );
}

function InfoRow({ icon: Icon, label, value, dark }: { icon: (p: IconProps) => JSX.Element; label: string; value: string; dark?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <Icon className={`shrink-0 ${dark ? "text-white/40" : "text-stone-300"}`} />
      <span className={`min-w-0 flex-1 truncate ${dark ? "text-white/60" : "text-stone-400"}`}>{label}</span>
      <span className={`shrink-0 whitespace-nowrap font-semibold ${dark ? "text-white" : "text-stone-700"}`}>{value}</span>
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
    // sr-only, not a visible heading row: the title text must stay in the
    // DOM (an existing test anchors on it, and it names the section for
    // screen readers), but a printed label above six already
    // self-labeled pills was pure vertical cost with no reading-order
    // benefit — every pill already leads with its own bolded domain name.
    <div>
      <p className="sr-only">{t("dashboard.health.title")}</p>
      <div className="flex flex-wrap gap-1.5">
        {health.map((h) => {
          const Icon = healthIcon[h.key] ?? IconInfo;
          return (
            <Link
              key={h.key}
              to={h.href === "__company_compliance__" ? "/labor-compliance" : `/projects/${projectId}/${h.href}`}
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition hover:opacity-80 ${healthPillTone[h.tone]}`}
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
  const mirrorChevron = locale === "ar";

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
    <div className="h-full overflow-y-auto rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-bold uppercase tracking-wide text-stone-900">{t("dashboard.financial.title")}</h2>
        <span className="text-xs text-stone-400">{t("dashboard.financial.asOf", { date: formatDate(forecast.asOfDate, locale) })}</span>
      </div>

      {/* A single connected pipeline, not five independent boxed chips: each
          stage is icon-on-top (matching the reference), with only a thin
          neutral rule between stages — never a directional arrow glyph,
          which this codebase deliberately avoids everywhere since it
          flips ambiguously in RTL (see IconChevron's mirror prop below
          for the one place a direction genuinely is needed). */}
      {/* flex-nowrap + overflow-x-auto, not flex-wrap: this card is capped
          to a fixed height on desktop (it shares a row with Delivery/Cash/
          Commercial/Pulse), and letting six stages wrap to a second line
          pushed real content below the card's visible area (confirmed
          live). A single row that scrolls horizontally in the rare case
          it doesn't fit keeps every stage reachable without stealing
          height from the rest of the page. */}
      <div className="mt-3 flex flex-nowrap items-start gap-x-1 overflow-x-auto pb-1">
        {stages.map((s, i) => (
          <div key={s.label} className="flex shrink-0 items-start gap-1 sm:gap-2">
            {i > 0 && <IconChevron mirror={mirrorChevron} className="mt-4 hidden shrink-0 text-stone-300 sm:block" aria-hidden="true" />}
            <Link to={`/projects/${projectId}/${s.href}`} className="flex flex-col items-center gap-1.5 px-1 text-center transition hover:opacity-70">
              <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${s.iconTone}`}>
                <s.icon />
              </span>
              <span className="max-w-[76px] truncate text-[10px] font-medium uppercase tracking-wide text-stone-400">{s.label}</span>
              <span className="whitespace-nowrap text-xs font-bold tabular-nums text-stone-900 sm:text-sm">{formatMoney(s.value, forecast.currency, locale)}</span>
            </Link>
          </div>
        ))}
        <IconChevron mirror={mirrorChevron} className="mt-4 hidden shrink-0 text-stone-300 sm:block" aria-hidden="true" />
        <div className={`flex shrink-0 flex-col items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-center ${overBudget ? "bg-danger-50" : "bg-success-50"}`}>
          <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${overBudget ? "bg-danger-100 text-danger-700" : "bg-success-100 text-success-700"}`}>
            {overBudget ? <IconAlertTriangle /> : <IconTrendUp />}
          </span>
          <span className={`whitespace-nowrap text-[10px] font-medium uppercase tracking-wide ${overBudget ? "text-danger-600" : "text-success-600"}`}>
            {t("dashboard.financial.expectedVariance")}
            {overBudget ? t("dashboard.financial.overBudgetSuffix") : ""}
          </span>
          <span className={`whitespace-nowrap text-xs font-extrabold tabular-nums sm:text-sm ${overBudget ? "text-danger-700" : "text-success-700"}`}>
            {formatMoney(m.variance, forecast.currency, locale)} ({formatPercent(m.variancePercent, 1, locale)})
          </span>
        </div>
      </div>

      {revision && (
        <p className="mt-3 border-t border-stone-100 pt-2 text-xs text-stone-400">
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
    <div className="relative flex h-full flex-col rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
      <h2 className="shrink-0 text-sm font-bold uppercase tracking-wide text-stone-900">{t("dashboard.needsAttention.title")}</h2>
      {items.length === 0 ? (
        <p className="mt-3 text-sm text-stone-400">{t("dashboard.needsAttention.empty")}</p>
      ) : (
        // A capped, internally scrolling list, not an ever-taller card:
        // every item is still fully present, one scroll away, never
        // dropped — this keeps the whole row's height predictable so the
        // page can target fitting one desktop viewport (a card that grows
        // with data would defeat that on any project with many open
        // exceptions).
        <ul className="mt-2 min-h-0 flex-1 space-y-1.5 overflow-y-auto pe-1">
          {items.map((item, i) => {
            const Icon = attentionIcon[item.severity];
            const [borderClass, colorClass] = attentionAccent[item.severity].split(" ");
            return (
              <li key={i}>
                <Link
                  to={item.href}
                  className={`group flex items-center gap-2 rounded-lg border-s-4 py-1.5 ps-2.5 pe-2 transition ${borderClass} ${attentionBg[item.severity]}`}
                >
                  <Icon className={`shrink-0 ${colorClass}`} />
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-stone-700 sm:text-sm">
                    {item.text}
                    {item.metric && <span className="font-normal text-stone-500"> — {item.metric}</span>}
                  </span>
                  <IconChevron mirror={mirrorChevron} className="shrink-0 text-stone-400" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {items.length > 0 && <ScrollFade />}
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
  const costColor = warnGap ? "#dc2626" : "#059669";

  return (
    <div className="h-full overflow-y-auto rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
      <h2 className="text-sm font-bold uppercase tracking-wide text-stone-900">{t("dashboard.costProgress.title")}</h2>
      <p className={`mt-1 text-xs font-semibold sm:text-sm ${warnGap ? "text-warning-700" : gap !== null ? "text-success-700" : "text-stone-400"}`}>{headline}</p>

      {/* A paired gauge, not two decorative bars: both real, already-
          computed snapshot percentages (avgProgress / costConsumption —
          the same two values the hero and the headline above already use),
          never a fabricated month-by-month trend line — this codebase has
          no real historical time series for either figure, so it never
          pretends to. This card is only 4-of-12 columns wide (it shares a
          row with Delivery/Cash/Commercial/Pulse), so the gauge's own
          center label IS the number — no separate big-number callout
          duplicating the identical two values beside it, which is what
          made this card overflow its own narrow width in an earlier pass. */}
      <div className="mt-3 flex items-center justify-center gap-6">
        <div className="flex flex-col items-center gap-1">
          <Gauge value={avgProgress} locale={locale} color="#0f766e" size={72} stroke={7} />
          <span className="text-[11px] font-medium text-stone-500">{t("dashboard.costProgress.actualProgress")}</span>
        </div>
        <div className="flex flex-col items-center gap-1">
          <Gauge value={costConsumption} locale={locale} color={costColor} size={72} stroke={7} />
          <span className="text-[11px] font-medium text-stone-500">{t("dashboard.costProgress.costConsumption")}</span>
        </div>
      </div>

      {/* grid-cols-1 below sm: at narrow widths, three-across left too
          little room per figure — text-ellipsis on a right-aligned/RTL
          number truncates from the *start*, hiding the significant
          leading digits (confirmed live: "152,000.00" rendered as
          "…2,000.00"). One column per row at narrow widths always gives a
          money value its full container width instead. */}
      <div className="mt-3 grid grid-cols-1 gap-3 border-t border-stone-200 pt-3 sm:grid-cols-3">
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

function PlainStat({ label, value, tone = "default" }: { label: string; value: string; tone?: "default" | "danger" }) {
  const color = tone === "danger" ? "text-danger-700" : "text-stone-900";
  return (
    <div className="min-w-0">
      <p className="truncate text-[11px] text-stone-500">{label}</p>
      <p className={`mt-0.5 whitespace-nowrap text-sm font-bold tabular-nums ${color}`}>{value}</p>
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
      {/* truncate, not a bare span: an untruncated label was free to wrap
          to a second line for longer English text ("Pending approval
          (1)"), and in this row's now-fixed-height, internally-scrolling
          card, that extra line pushed the row below it out of view —
          visually slicing a money VALUE in half instead of just hiding a
          label word, which is worse than what the truncate convention
          elsewhere on this page already guards against (confirmed live). */}
      <p className="truncate text-[11px] text-stone-500">{label}</p>
      <p className={`whitespace-nowrap text-xs font-semibold tabular-nums sm:text-sm ${color}`}>{value}</p>
      {hint && <p className="truncate text-[11px] text-stone-400">{hint}</p>}
    </div>
  );
}

// A small colored count bubble for a bare, already-real count (never a
// derived/estimated figure) — reused for the two IPC "awaiting" rows below.
function CountBadge({ count, tone }: { count: number; tone: "purple" | "warning" | "success" }) {
  const toneClass = tone === "purple" ? "bg-purple-100 text-purple-700" : tone === "warning" ? "bg-warning-100 text-warning-700" : "bg-success-100 text-success-700";
  return <span className={`inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5 text-[11px] font-bold tabular-nums ${toneClass}`}>{count}</span>;
}

function BadgeRow({ label, count, tone }: { label: string; count: number; tone: "purple" | "warning" | "success" }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="min-w-0 truncate text-sm text-stone-600">{label}</span>
      <CountBadge count={count} tone={count > 0 ? tone : "success"} />
    </div>
  );
}

// A quiet bottom fade over an internally-scrolling card's last visible row
// — signals "more below, scroll for it" instead of a hard, unexplained
// cut. A card whose content happens to fit exactly needs no such cue, but
// rendering the fade unconditionally is harmless there (the gradient sits
// over an already-empty few pixels of white).
function ScrollFade() {
  return <div className="pointer-events-none absolute inset-x-0 bottom-0 h-6 rounded-b-xl bg-gradient-to-t from-white to-transparent" aria-hidden="true" />;
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
  const isOnTrack = overdueTasks.length === 0;
  return (
    <div className="h-full overflow-y-auto rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
      <h3 className="text-sm font-bold text-stone-900">{t("dashboard.progressSchedule.title")}</h3>
      {tasks.length > 0 && (
        <span className={`mt-1.5 inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ${isOnTrack ? "bg-success-100 text-success-700" : "bg-warning-100 text-warning-700"}`}>
          {isOnTrack ? t("dashboard.progressSchedule.onTrack") : t("dashboard.progressSchedule.tasksOverdueCount", { count: overdueTasks.length })}
        </span>
      )}
      {tasks.length === 0 ? (
        <p className="mt-2 text-xs text-stone-400">{t("dashboard.progressSchedule.noData")}</p>
      ) : (
        <div className="mt-2.5 space-y-2">
          <PlainRow label={t("dashboard.progressSchedule.overallProgress")} value={avgProgress !== null ? formatPercent(avgProgress, 1, locale) : "—"} />
          <PlainRow label={t("dashboard.progressSchedule.nextMilestone")} value={nextMilestone ? formatDate(nextMilestone.endDate, locale) : "—"} hint={nextMilestone?.name} />
        </div>
      )}
      {measurementsAwaitingApproval.length > 0 && (
        <p className="mt-2 text-[11px] text-stone-500">
          <Link to={`/projects/${projectId}/progress`} className="text-primary hover:underline">
            {t("dashboard.progressSchedule.measurementsAwaitingCount", { count: measurementsAwaitingApproval.length })}
          </Link>
        </p>
      )}
      <p className="mt-2.5 text-end text-[11px]">
        <Link to={`/projects/${projectId}/schedule`} className="font-medium text-primary hover:underline">
          {t("dashboard.progressSchedule.openSchedule")}
        </Link>
      </p>
    </div>
  );
}

function CashColumn({ cashFlow, projectId }: { cashFlow: CashFlowResult; projectId: string }) {
  const { t, locale } = useTranslation();
  const netPositive = cashFlow.projected.net >= 0;
  return (
    <div className="h-full overflow-y-auto rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
      <h3 className="text-sm font-bold text-stone-900">{t("dashboard.cashFlow.title")}</h3>

      {/* The one real headline figure this card has — cashFlow.projected.net,
          already computed server-side — promoted to a hero stat instead of
          buried in a list. No sparkline/trend badge sits beside it: this
          codebase has no real historical cash-flow time series to plot, so
          it never fakes one (unlike a reference dashboard's decorative
          "+12%" trend chip). */}
      {/* Intl's currency formatter joins the code to the number with a
          non-breaking space ("-SAR 65,000.00") — at a hero font size
          in this narrow (1-of-3) card, that single unbreakable run first
          overflowed the card's own border, and reducing the font alone
          only turned it into a ragged 3-line break with "00" stranded
          alone on its own line (both confirmed live). Swapping the nbsp
          for a normal space means it wraps at most once, cleanly, between
          the currency code and the number — never mid-number. */}
      <p className={`mt-2 text-lg font-extrabold tabular-nums sm:text-xl ${netPositive ? "text-success-700" : "text-danger-700"}`}>
        {formatMoney(cashFlow.projected.net, cashFlow.currency, locale).replace(/ /g, " ")}
      </p>
      <p className="text-[11px] font-medium text-stone-500">{t("dashboard.cashFlow.projectedNet")}</p>

      <div className="mt-2.5 space-y-2 border-t border-stone-100 pt-2.5">
        <PlainRow label={t("dashboard.cashFlow.collected")} value={formatMoney(cashFlow.historical.cashReceived, cashFlow.currency, locale)} />
        <PlainRow label={t("dashboard.cashFlow.incurredCost")} value={formatMoney(cashFlow.historical.incurredCost, cashFlow.currency, locale)} />
        <PlainRow label={t("dashboard.cashFlow.expectedReceivables")} value={formatMoney(cashFlow.projected.receivables, cashFlow.currency, locale)} />
      </div>
      <p className="mt-2.5 text-end text-[11px]">
        <Link to={`/projects/${projectId}/cash-flow`} className="font-medium text-primary hover:underline">
          {t("dashboard.cashFlow.fullDetails")}
        </Link>
      </p>
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
    // flex-col + a scrollable body: this card genuinely has the most
    // content on the page (three real sub-sections) — capping it at the
    // row's shared height and letting the body scroll internally keeps
    // every figure present without stretching its four siblings to match.
    <div className="relative flex h-full flex-col rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
      <h3 className="shrink-0 text-sm font-bold text-stone-900">{t("dashboard.commercial.title")}</h3>
      <div className="mt-2 min-h-0 flex-1 space-y-3 overflow-y-auto pe-1">
        <div>
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-stone-400">{t("dashboard.procurement.title")}</p>
            <Link to={`/projects/${projectId}/procurement`} className="text-[11px] font-medium text-primary hover:underline">
              {t("dashboard.procurement.open")}
            </Link>
          </div>
          <div className="mt-1.5 space-y-1.5">
            <PlainRow label={t("dashboard.procurement.totalCommitted")} value={formatMoney(totalCommitted, currency, locale)} />
            <PlainRow label={t("dashboard.procurement.activeExecuted")} value={formatMoney(approvedCommitted, currency, locale)} tone="success" />
            <PlainRow label={t("dashboard.procurement.pendingApprovalCount", { count: pendingCount })} value={formatMoney(pendingCommitted, currency, locale)} tone="warning" />
          </div>
        </div>

        <div className="border-t border-stone-100 pt-3">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-stone-400">{t("dashboard.commercial.ipcTitle")}</p>
            <Link to={`/projects/${projectId}/ipc`} className="text-[11px] font-medium text-primary hover:underline">
              {t("dashboard.commercial.openCertificates")}
            </Link>
          </div>
          <div className="mt-1.5 space-y-1.5">
            <PlainRow label={t("dashboard.commercial.certifiedValueCount", { count: certifiedCount })} value={formatMoney(certifiedTotal, currency, locale)} tone="success" />
            <BadgeRow label={t("dashboard.commercial.awaitingCertification")} count={awaitingCertification} tone="warning" />
            <BadgeRow label={t("dashboard.commercial.awaitingApproval")} count={awaitingApproval} tone="purple" />
          </div>
        </div>

        <div className="border-t border-stone-100 pt-3">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-stone-400">{t("dashboard.commercial.laborTitle")}</p>
            {laborCost.allocationCount > 0 && laborCost.posted && <Badge tone="success">{t("dashboard.commercial.fullyPosted")}</Badge>}
          </div>
          {laborCost.allocationCount === 0 ? (
            <p className="mt-1.5 text-xs text-stone-400">{t("dashboard.commercial.noLaborCost")}</p>
          ) : (
            <div className="mt-1.5 space-y-1.5">
              <PlainRow label={t("dashboard.commercial.totalAllocated")} value={formatMoney(laborCost.allocatedTotal, "SAR", locale)} />
              <PlainRow label={t("dashboard.commercial.allocationCount")} value={String(laborCost.allocationCount)} />
            </div>
          )}
          <p className="mt-1.5 text-end text-[11px]">
            <Link to="/payroll" className="font-medium text-primary hover:underline">
              {t("dashboard.commercial.viewPayrollDetails")}
            </Link>
          </p>
        </div>
      </div>
      <ScrollFade />
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

// The activity feed's action strings are a fixed, already-known vocabulary
// (KNOWN_ACTIVITY_VERBS above) — mapping their domain prefix to the same
// icon already used for that domain elsewhere on this page (Financial
// Control, Health line) is a presentation choice over real event data,
// never a new classification.
const activityDomainIcon: Record<string, (p: IconProps) => JSX.Element> = {
  ipc: IconMoney,
  commitment: IconPackage,
  measurement: IconBars,
  boq_revision: IconClipboard,
};

function ActivityPulse({ events }: { events: ActivityEvent[] }) {
  const { t, locale } = useTranslation();
  return (
    // Same capped-height + internal-scroll treatment as Commercial: up to
    // 8 real events can be present, and every one of them stays reachable
    // by scrolling this one card instead of pushing the whole row taller.
    <div className="relative flex h-full flex-col rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
      <h3 className="shrink-0 text-sm font-bold text-stone-900">{t("dashboard.activity.title")}</h3>
      {events.length === 0 ? (
        <p className="mt-2 text-xs text-stone-400">{t("dashboard.activity.empty")}</p>
      ) : (
        <ul className="mt-2 min-h-0 flex-1 space-y-2 overflow-y-auto pe-1">
          {events.map((e) => {
            const Icon = activityDomainIcon[e.action.split(".")[0]] ?? IconInfo;
            return (
              <li key={e.id} className="flex items-center gap-2 text-xs">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-stone-100 text-stone-500">
                  <Icon width={12} height={12} />
                </span>
                <span className="min-w-0 flex-1 truncate text-stone-700">{activityVerbLabel(t, e.action)}</span>
                <span className="shrink-0 text-[10px] text-stone-400">{formatDateTime(e.createdAt, locale)}</span>
              </li>
            );
          })}
        </ul>
      )}
      {events.length > 0 && <ScrollFade />}
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
    <div className="flex flex-wrap items-center gap-3">
      <h3 className="shrink-0 text-xs font-semibold uppercase tracking-wide text-stone-400">{t("dashboard.quickActions.title")}</h3>
      <div className="flex flex-wrap gap-2">
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
