import { useEffect, useState, type ReactNode, type SVGProps } from "react";
import { Link } from "react-router-dom";
import { Card } from "../../ui/Card";
import { Badge } from "../../ui/Badge";
import { MetricCard } from "../../ui/MetricCard";
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
import type {
  ActivityEvent,
  BoqRevision,
  BudgetAlert,
  BudgetSummary,
  CashFlowResult,
  Commitment,
  CommitmentStatus,
  Contract,
  ForecastResult,
  Ipc,
  IpcStatus,
  Measurement,
  Project,
  ProjectLaborCost,
  ProjectTask,
  PunchItem,
} from "../../api/types";

// ─────────────────────────────────────────────────────────────────────────
// MIDAD — Executive Command Center (project-level).
//
// Composition is one asymmetric 12-column grid (see the JSX below), not a
// vertical stack of equal-weight cards: identity (full width) -> health +
// financial control -> cost-vs-progress (large) + needs attention ->
// progress/schedule + cash flow -> procurement + commercial execution ->
// activity + quick actions (full width, lowest priority). Source order
// equals reading/priority order on every breakpoint, so the same JSX
// collapses to that exact sequence on mobile with no per-breakpoint
// `order-N` overrides needed. Every figure still comes from this
// codebase's own already-authoritative endpoints (Contract/Budget/
// Forecast/Cash Flow/
// Commitments/IPCs/Measurements/Schedule/Punch List/Budget Alerts/Labor
// Cost/BOQ, plus the canonical audit_events feed filtered client-side to
// this project's own entity ids) — nothing here computes a second version
// of a financial number the backend already owns. Two things ARE new
// client-side *compositions* of existing facts, not new calculations: the
// unified "Needs Attention" list (grouping already-real risk signals by
// severity) and the project-scoped Activity feed (filtering the company-
// wide audit log to entities this project actually owns). The one genuine
// "chart" on this page (the cost-consumption radial gauge) renders a
// single already-real percentage as an SVG ring — no time series exists in
// this codebase to plot, and none is invented here.
//
// Fetching is consolidated into one Promise.all (previously six separately
// mounted cards fired their own requests, two of them duplicating the same
// Budget Alerts call) — fewer requests, one loading/error state.
// ─────────────────────────────────────────────────────────────────────────

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

const ipcStatusLabel: Record<IpcStatus, string> = {
  draft: "مسودة",
  submitted: "بانتظار الاعتماد",
  approved: "معتمدة (بانتظار التصديق)",
  certified: "مصدَّقة",
  rejected: "مرفوضة",
};

const commitmentStatusLabel: Record<CommitmentStatus, string> = {
  draft: "مسودة",
  pending_approval: "بانتظار الاعتماد",
  active: "نشط",
  partially_fulfilled: "منفَّذ جزئياً",
  closed: "مغلق",
  cancelled: "ملغى",
};

const alertSeverityLabel: Record<BudgetAlert["severity"], string> = { info: "معلومات", warning: "تحذير", critical: "حرج" };

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
      .catch((err) => setError(err instanceof Error ? err.message : "تعذّر تحميل نظرة عامة المشروع"));
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
    activeAlerts,
    overdueTasks,
    scheduleHasData: scheduleTasks.length > 0,
    cashFlowNet: data.cashFlow.projected.net,
    pendingCommitments,
    measurementsAwaitingApproval,
    measurementsHaveData: data.measurements.length > 0,
  });

  // Executive Command Center composition: Identity, then four Zones (each
  // one Card holding a related pair split by an internal divider — see
  // the `Zone` component), then two low-priority full-width strips.
  // Source order equals reading/priority order on every breakpoint, so
  // the same JSX collapses to that exact sequence on mobile with no
  // per-breakpoint `order-N` overrides needed. The asymmetric widths
  // (Health 5 / Financial 7, Cost-vs-Progress 7 / Needs Attention 5) live
  // inside each Zone's own basis split, not in an outer grid — below
  // `xl` every Zone stacks its two halves vertically with a horizontal
  // divider instead of splitting columns.
  return (
    <div className="flex flex-col gap-5 lg:gap-6">
      <IdentityStrip project={project} contract={mainContract} avgProgress={avgProgress} activity={data.activity} />

      <Zone
        tier="primary"
        leftBasis="xl:basis-5/12"
        left={<HealthGrid health={health} projectId={projectId} />}
        rightBasis="xl:basis-7/12"
        right={<FinancialWaterfallCard contract={mainContract} forecast={data.forecast} projectId={projectId} revision={latestRevision} />}
      />

      <Zone
        tier="primary"
        leftBasis="xl:basis-7/12"
        left={<CostVsProgressCard budget={data.budget} avgProgress={avgProgress} />}
        rightBasis="xl:basis-5/12"
        right={<NeedsAttentionCard items={needsAttention} />}
      />

      <Zone
        tier="secondary"
        left={
          <ProgressScheduleCard
            projectId={projectId}
            tasks={data.tasks}
            overdueTasks={overdueTasks}
            nextMilestone={nextMilestone}
            avgProgress={avgProgress}
            measurementsAwaitingApproval={measurementsAwaitingApproval}
          />
        }
        right={<CashFlowCard cashFlow={data.cashFlow} projectId={projectId} />}
      />

      <Zone
        tier="secondary"
        left={
          <ProcurementCard
            projectId={projectId}
            totalCommitted={totalCommitted}
            approvedCommitted={approvedCommitted}
            pendingCommitted={pendingCommitted}
            pendingCount={pendingCommitments.length}
            currency={data.forecast.currency}
          />
        }
        right={
          <CommercialExecutionCard
            projectId={projectId}
            awaitingCertification={ipcsAwaitingCertification.length}
            awaitingApproval={ipcsAwaitingApproval.length}
            certifiedTotal={certifiedTotal}
            certifiedCount={certifiedIpcs.length}
            currency={data.forecast.currency}
            laborCost={data.laborCost}
          />
        }
      />

      <ActivityFeedCard events={projectActivity} />
      <QuickActionsCard projectId={projectId} />
    </div>
  );
}

function HeaderSkeleton({ project }: { project: Project | null }) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <h1 className="text-xl font-bold text-stone-900">مركز القيادة التنفيذي</h1>
        {project && <p className="mt-1 text-sm text-stone-500">{project.name}</p>}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Icon set — a small, consistent, stroke-based line-icon language (the same
// visual family professional construction-SaaS dashboards use), inlined as
// plain SVG so no new dependency is introduced anywhere in this codebase.
// ─────────────────────────────────────────────────────────────────────────
type IconProps = SVGProps<SVGSVGElement>;
const iconBase = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.75, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

const IconMoney = (p: IconProps) => (
  <svg {...iconBase} {...p}><circle cx="12" cy="12" r="9" /><path d="M9 15c0 1.1 1.3 2 3 2s3-.9 3-2-1.3-1.6-3-2-3-.9-3-2 1.3-2 3-2 3 .9 3 2" /></svg>
);
const IconCalendar = (p: IconProps) => (
  <svg {...iconBase} {...p}><rect x="3.5" y="5" width="17" height="15.5" rx="2" /><path d="M3.5 9.5h17M8 3v4M16 3v4" /></svg>
);
const IconTrend = (p: IconProps) => (
  <svg {...iconBase} {...p}><path d="M4 16l5-5 4 4 7-8" /><path d="M14 6h6v6" /></svg>
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
const IconAlertTriangle = (p: IconProps) => (
  <svg {...iconBase} {...p}><path d="M10.5 4 2 19h20L13.5 4a1.7 1.7 0 0 0-3 0z" /><path d="M12 10v4M12 17h.01" /></svg>
);
const IconAlertCircle = (p: IconProps) => (
  <svg {...iconBase} {...p}><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></svg>
);
const IconInfo = (p: IconProps) => (
  <svg {...iconBase} {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>
);
const IconActivity = (p: IconProps) => (
  <svg {...iconBase} {...p}><path d="M3 12h4l2-7 4 14 2-7h6" /></svg>
);
const IconClipboard = (p: IconProps) => (
  <svg {...iconBase} {...p}><rect x="5" y="4.5" width="14" height="17" rx="2" /><path d="M9 4V3.5A1.5 1.5 0 0 1 10.5 2h3A1.5 1.5 0 0 1 15 3.5V4M8.5 11h7M8.5 15h5" /></svg>
);
const IconWallet = (p: IconProps) => (
  <svg {...iconBase} {...p}><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5h11A2.5 2.5 0 0 1 20 7.5v9a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z" /><path d="M15.5 12.5h2.5a1 1 0 0 0 0-2h-2.5a1 1 0 0 0 0 2z" /></svg>
);
const IconPlus = (p: IconProps) => (
  <svg {...iconBase} {...p}><path d="M12 5v14M5 12h14" /></svg>
);
const IconClock = (p: IconProps) => (
  <svg {...iconBase} {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></svg>
);

const healthIcon: Record<string, (p: IconProps) => JSX.Element> = {
  cost: IconMoney,
  schedule: IconCalendar,
  cashflow: IconWallet,
  procurement: IconPackage,
  progress: IconBars,
  compliance: IconShield,
};

// A small, colored icon badge used consistently as every section's visual
// anchor — the same "icon in a tinted rounded square, next to a heading"
// pattern professional dashboards (Procore/Autodesk-class) use throughout.
const badgeTone: Record<"primary" | "success" | "warning" | "danger" | "info" | "neutral", string> = {
  primary: "bg-primary/10 text-primary",
  success: "bg-success-100 text-success-700",
  warning: "bg-warning-100 text-warning-700",
  danger: "bg-danger-100 text-danger-700",
  info: "bg-info-100 text-info-700",
  neutral: "bg-stone-100 text-stone-500",
};
// Section weight: the dashboard deliberately does NOT give every card equal
// visual prominence (Project Health / Financial Control / Cost vs Progress /
// Needs Attention read as the executive-primary layer; Progress-Schedule /
// Cash Flow / Procurement as secondary; IPC / Labor / Activity / Quick
// Actions / BOQ status as supporting tertiary detail). The scale is
// intentionally restrained — smaller padding, icon and title size, not a
// louder primary tier — so the hierarchy reads as calm information design,
// not decoration.
type SectionTier = "primary" | "secondary" | "tertiary";
const badgeSizeByTier: Record<SectionTier, string> = {
  primary: "h-8 w-8",
  secondary: "h-7 w-7",
  tertiary: "h-6 w-6",
};
const iconPxByTier: Record<SectionTier, number> = { primary: 16, secondary: 14, tertiary: 13 };
const titleSizeByTier: Record<SectionTier, string> = {
  primary: "text-[15px] font-bold",
  secondary: "text-sm font-bold",
  tertiary: "text-sm font-semibold",
};
const panelPaddingByTier: Record<SectionTier, string> = {
  primary: "p-4 lg:p-5",
  secondary: "p-4",
  tertiary: "p-3.5 lg:p-4",
};

function IconBadge({
  icon: Icon,
  tone = "primary",
  tier = "primary",
}: {
  icon: (p: IconProps) => JSX.Element;
  tone?: keyof typeof badgeTone;
  tier?: SectionTier;
}) {
  return (
    <span className={`flex ${badgeSizeByTier[tier]} shrink-0 items-center justify-center rounded-lg ${badgeTone[tone]}`}>
      <Icon width={iconPxByTier[tier]} height={iconPxByTier[tier]} />
    </span>
  );
}

function SectionHeader({
  icon,
  tone = "primary",
  tier = "primary",
  title,
  meta,
  action,
}: {
  icon: (p: IconProps) => JSX.Element;
  tone?: keyof typeof badgeTone;
  tier?: SectionTier;
  title: string;
  meta?: string;
  action?: ReactNode;
}) {
  return (
    <div className={`${tier === "tertiary" ? "mb-3" : "mb-4"} flex items-center justify-between gap-3`}>
      <div className="flex items-center gap-2.5">
        <IconBadge icon={icon} tone={tone} tier={tier} />
        <div>
          <h2 className={`${titleSizeByTier[tier]} text-stone-900`}>{title}</h2>
          {meta && <p className="text-xs text-stone-400">{meta}</p>}
        </div>
      </div>
      {action}
    </div>
  );
}

// Shared elevated-card shell every standalone section below uses — a
// subtle shadow + refined border replaces the previous flat border-only
// Card usage. `tier` controls padding only. This is now used only for
// sections that are NOT paired inside a Zone (Identity, Activity):
// paired sections render inside one shared Zone card instead of their
// own, so the page carries far fewer separate card boundaries overall.
function Panel({ className = "", tier = "primary", children }: { className?: string; tier?: SectionTier; children: ReactNode }) {
  return (
    <Card
      className={`border-stone-200/80 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_1px_8px_rgba(15,23,42,0.03)] ${panelPaddingByTier[tier]} ${className}`}
    >
      {children}
    </Card>
  );
}

// A single Card boundary holding TWO related sections split by a subtle
// internal divider — vertical on desktop, horizontal once stacked —
// instead of two independent Cards sitting next to each other. This is
// what actually collapses "cards in a grid" into genuine zones: the page
// carries one visible boundary per related pair, not one per metric
// group. `leftBasis`/`rightBasis` set the asymmetric split (e.g. Health
// 5/12 next to Financial Control 7/12); both default to an even split.
function Zone({
  tier = "primary",
  left,
  leftBasis = "xl:basis-1/2",
  right,
  rightBasis = "xl:basis-1/2",
}: {
  tier?: SectionTier;
  left: ReactNode;
  leftBasis?: string;
  right: ReactNode;
  rightBasis?: string;
}) {
  return (
    <Card className="flex flex-col divide-y divide-stone-200 border-stone-200/80 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_1px_8px_rgba(15,23,42,0.03)] xl:flex-row xl:divide-x xl:divide-y-0 xl:divide-x-reverse">
      <div className={`${leftBasis} ${panelPaddingByTier[tier]}`}>{left}</div>
      <div className={`${rightBasis} ${panelPaddingByTier[tier]}`}>{right}</div>
    </Card>
  );
}

// ── LEVEL 1 — Identity strip ────────────────────────────────────────────
// The workspace shell (ProjectHeader.tsx) already shows the project name,
// client, and a back-link above every section — this strip deliberately
// does not repeat those, it adds the facts that genuinely aren't shown
// anywhere else yet: status, contract value, schedule-based progress, and
// when this project was last touched (the most recent real activity event
// on it, falling back to the project's own creation date).
function IdentityStrip({
  project,
  contract,
  avgProgress,
  activity,
}: {
  project: Project;
  contract: Contract | null;
  avgProgress: number | null;
  activity: ActivityEvent[];
}) {
  const lastActivityAt = activity[0]?.createdAt ?? project.createdAt;
  const statusDot: Record<Project["status"], string> = { active: "bg-success-500", on_hold: "bg-warning-500", completed: "bg-stone-400" };
  return (
    <div className="flex flex-wrap items-center gap-x-8 gap-y-3 rounded-lg border border-stone-200/80 bg-white px-4 py-3 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_1px_8px_rgba(15,23,42,0.03)]">
      <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${statusTone[project.status] === "success" ? "bg-success-100 text-success-700" : statusTone[project.status] === "warning" ? "bg-warning-100 text-warning-700" : "bg-stone-100 text-stone-600"}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${statusDot[project.status]}`} aria-hidden="true" />
        {statusLabel[project.status]}
      </span>
      <HeroStat label="قيمة العقد" value={contract ? formatMoney(contract.revisedValue, contract.currency) : "—"} />
      <HeroStat label="نسبة الإنجاز" value={avgProgress !== null ? formatPercent(avgProgress) : "لا توجد بيانات"} hint="من الجدول الزمني" />
      <div className="mr-auto flex items-center gap-1.5 text-xs text-stone-400">
        <IconClock width={14} height={14} />
        آخر تحديث: {formatDateTime(lastActivityAt)}
      </div>
    </div>
  );
}

function HeroStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <p className="text-xs text-stone-500">{label}</p>
      <p className="text-xl font-extrabold tracking-tight text-stone-900">{value}</p>
      {hint && <p className="text-xs text-stone-400">{hint}</p>}
    </div>
  );
}

// ── LEVEL 2 — Project Health ────────────────────────────────────────────
type HealthTone = "healthy" | "watch" | "critical" | "neutral";
const healthDotColor: Record<HealthTone, string> = {
  healthy: "bg-success-500",
  watch: "bg-warning-500",
  critical: "bg-danger-500",
  neutral: "bg-stone-300",
};
const healthBadgeTone: Record<HealthTone, keyof typeof badgeTone> = {
  healthy: "success",
  watch: "warning",
  critical: "danger",
  neutral: "neutral",
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
  activeAlerts: BudgetAlert[];
  overdueTasks: ProjectTask[];
  scheduleHasData: boolean;
  cashFlowNet: number;
  pendingCommitments: Commitment[];
  measurementsAwaitingApproval: Measurement[];
  measurementsHaveData: boolean;
}): HealthIndicator[] {
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
      label: "التكلفة",
      tone: costTone,
      statusText: costTone === "critical" ? "تنبيهات حرجة" : costTone === "watch" ? "تحتاج مراقبة" : "على المسار الصحيح",
      metric: `${input.activeAlerts.length} تنبيه نشط`,
      href: "cost-plan",
    },
    {
      key: "schedule",
      label: "الجدول الزمني",
      tone: scheduleTone,
      statusText: !input.scheduleHasData ? "لا توجد بيانات" : scheduleTone === "critical" ? "متأخر" : "ضمن الجدول",
      metric: input.scheduleHasData ? `${input.overdueTasks.length} مهمة متأخرة` : "—",
      href: "schedule",
    },
    {
      key: "cashflow",
      label: "التدفق النقدي",
      tone: cashTone,
      statusText: cashTone === "healthy" ? "سليم" : "يحتاج متابعة",
      metric: formatMoney(input.cashFlowNet),
      href: "cash-flow",
    },
    {
      key: "procurement",
      label: "المشتريات",
      tone: procurementTone,
      statusText: procurementTone === "healthy" ? "لا إجراء مطلوب" : "بانتظار اعتماد",
      metric: `${input.pendingCommitments.length} التزام معلَّق`,
      href: "procurement",
    },
    {
      key: "progress",
      label: "الإنجاز",
      tone: progressTone,
      statusText: !input.measurementsHaveData ? "لا توجد بيانات" : progressTone === "watch" ? "بانتظار اعتماد" : "محدَّث",
      metric: input.measurementsHaveData ? `${input.measurementsAwaitingApproval.length} قياس معلَّق` : "—",
      href: "progress",
    },
    {
      key: "compliance",
      label: "الامتثال",
      tone: "neutral",
      statusText: "على مستوى الشركة",
      metric: "نطاقات وGOSI",
      href: "__company_compliance__",
    },
  ];
}

function HealthGrid({ health, projectId }: { health: HealthIndicator[]; projectId: string }) {
  return (
    <>
      <SectionHeader icon={IconShield} tier="primary" title="صحة المشروع" />
      {/* Capped at 2 columns, not 3 — this zone now lives in a permanently
          partial-width column (not full page width like before), so a 3rd
          column leaves too little room for longer labels ("المشتريات"). */}
      <div className="grid grid-cols-2 gap-3">
        {health.map((h) => {
          const Icon = healthIcon[h.key] ?? IconInfo;
          return (
            <Link
              key={h.key}
              to={h.href === "__company_compliance__" ? "/labor-compliance" : `/projects/${projectId}/${h.href}`}
              className="group relative overflow-hidden rounded-lg border border-stone-200 p-3.5 transition hover:-translate-y-0.5 hover:border-stone-300 hover:shadow-md"
            >
              <span className={`absolute inset-y-0 right-0 w-1 ${healthDotColor[h.tone]}`} aria-hidden="true" />
              <div className="flex items-center gap-2">
                <IconBadge icon={Icon} tone={healthBadgeTone[h.tone]} />
                <span className="text-sm font-semibold text-stone-800">{h.label}</span>
              </div>
              <p className="mt-2 text-sm font-medium text-stone-600">{h.statusText}</p>
              <p className="mt-0.5 text-xs text-stone-400">{h.metric}</p>
            </Link>
          );
        })}
      </div>
    </>
  );
}

// ── LEVEL 3 — Financial Command Center ──────────────────────────────────
// forecast.methods.commitment_aware already bundles the entire
// Contract→Budget→Actual→Committed→EAC→Variance chain in one
// already-authoritative object — this card is a presentation of that one
// object, never a second computation of any of its figures.
function FinancialWaterfallCard({
  contract,
  forecast,
  projectId,
  revision,
}: {
  contract: Contract | null;
  forecast: ForecastResult;
  projectId: string;
  revision: BoqRevision | null;
}) {
  const m = forecast.methods.commitment_aware;
  const overBudget = m.variance < 0;
  // Contract -> Budget -> Actual + Commitments -> Forecast, as a vertical
  // label:value list (not a horizontal step chain) so every figure reads
  // at full size regardless of the column this zone sits in. Every value
  // is still read verbatim off forecast.methods.commitment_aware / the
  // contract, never recomputed — grouping into three rows is presentation
  // only.
  const rows: { label: string; value: number; href: string }[][] = [
    [
      { label: "قيمة العقد", value: contract ? Number(contract.revisedValue) : m.costPlan, href: "contract" },
      { label: "الميزانية المعتمدة", value: m.costPlan, href: "cost-plan" },
    ],
    [
      { label: "التكلفة الفعلية", value: m.actualCost, href: "actual-cost" },
      { label: "الالتزامات", value: m.committedCost, href: "procurement" },
    ],
  ];

  return (
    <>
      <SectionHeader icon={IconMoney} tier="primary" title="المركز المالي" meta={`بتاريخ ${formatDate(forecast.asOfDate)}`} />
      <div className="space-y-1">
        {rows.map((group, gi) => (
          <div key={gi} className={gi > 0 ? "border-t border-stone-100 pt-1" : ""}>
            {group.map((r) => (
              <Link
                key={r.label}
                to={`/projects/${projectId}/${r.href}`}
                className="flex items-center justify-between gap-3 rounded-md px-2 py-2 text-sm transition hover:bg-stone-50"
              >
                <span className="text-stone-500">{r.label}</span>
                <span className="font-bold text-stone-900">{formatMoney(r.value, forecast.currency)}</span>
              </Link>
            ))}
          </div>
        ))}
      </div>
      <div className="mt-2 border-t border-stone-100 pt-3">
        <Link
          to={`/projects/${projectId}/forecast`}
          className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5 transition hover:bg-stone-50"
        >
          <span className="text-sm text-stone-500">التوقع عند الإنجاز</span>
          <span className="text-lg font-extrabold text-stone-900">{formatMoney(m.eac, forecast.currency)}</span>
        </Link>
        <div className={`mt-2 flex items-center justify-between gap-3 rounded-lg border p-3.5 ${overBudget ? "border-danger-200 bg-danger-50" : "border-success-200 bg-success-50"}`}>
          <span className={`flex items-center gap-2 text-sm font-semibold ${overBudget ? "text-danger-700" : "text-success-700"}`}>
            {overBudget ? <IconAlertTriangle width={18} height={18} /> : <IconTrend width={18} height={18} />}
            الانحراف المتوقع{overBudget ? " — تجاوز متوقع للميزانية" : ""}
          </span>
          <span className={`text-xl font-extrabold ${overBudget ? "text-danger-700" : "text-success-700"}`}>
            {formatMoney(m.variance, forecast.currency)} ({formatPercent(m.variancePercent)})
          </span>
        </div>
      </div>
      {revision && (
        <p className="mt-3 border-t border-stone-100 pt-2.5 text-xs text-stone-400">
          جدول الكميات — النسخة #{revision.revisionNumber}{" "}
          <Badge tone={boqRevisionStatusTone[revision.status]}>{boqRevisionStatusLabel[revision.status]}</Badge>{" "}
          <Link to={`/projects/${projectId}/boq`} className="text-primary hover:underline">
            فتح جدول الكميات
          </Link>
        </p>
      )}
    </>
  );
}

// ── LEVEL 4 — Cost vs Progress ───────────────────────────────────────────
// Also the one place the Cost Plan's own raw planned/spent/remaining
// figures are shown verbatim (the previous Overview's CostPlanCard) — the
// gauge/bar above summarize the *relationship*, but the underlying money
// figures stay visible right below, never dropped.
function CostVsProgressCard({ budget, avgProgress }: { budget: BudgetSummary; avgProgress: number | null }) {
  const costConsumption = budget.totals.planned > 0 ? (budget.totals.spent / budget.totals.planned) * 100 : null;
  // Same subtraction the old `warn` flag already made — surfaced as a plain-
  // language headline with the actual point gap instead of only a boolean,
  // since this zone is now the dashboard's primary analytical moment. Still
  // just a difference of two already-displayed percentages, not a new
  // financial figure.
  const gap = avgProgress !== null && costConsumption !== null ? costConsumption - avgProgress : null;
  const warn = gap !== null && gap > 5;
  const overBudget = budget.totals.remaining < 0;

  const headline =
    gap === null
      ? "لا تتوفر بيانات إنجاز من الجدول الزمني بعد."
      : gap > 5
        ? `استهلاك التكلفة يسبق الإنجاز الفعلي بفارق ${formatPercent(gap, 0)}`
        : gap < -5
          ? `الإنجاز الفعلي يسبق استهلاك التكلفة بفارق ${formatPercent(Math.abs(gap), 0)}`
          : "استهلاك التكلفة متوافق مع الإنجاز الفعلي للمشروع";

  return (
    <>
      <SectionHeader icon={IconBars} tier="primary" title="الإنجاز الفعلي مقابل استهلاك التكلفة" />
      <p
        className={`mb-5 flex items-center gap-2 text-base font-bold ${
          warn ? "text-warning-700" : gap !== null ? "text-success-700" : "text-stone-400"
        }`}
      >
        {warn ? <IconAlertTriangle width={20} height={20} /> : gap !== null ? <IconTrend width={20} height={20} /> : null}
        {headline}
      </p>
      <div className="flex flex-col items-center gap-8 sm:flex-row sm:items-stretch sm:justify-center">
        <RadialGauge value={avgProgress} label="الإنجاز الفعلي" color="#2563eb" />
        <RadialGauge value={costConsumption} label="استهلاك التكلفة" color={warn ? "#dc2626" : "#16a34a"} />
      </div>
      {/* Capped at 2 columns (not 3) — this zone shares its row with Needs
          Attention now, so it never has true full-page width to spare. */}
      <div className="mt-6 grid grid-cols-2 gap-3 border-t border-stone-100 pt-4">
        <MetricCard label="إجمالي المخطَّط" value={formatMoney(budget.totals.planned)} />
        <MetricCard label="إجمالي المُنفَق" value={formatMoney(budget.totals.spent)} />
        <MetricCard
          label={overBudget ? "تجاوز الميزانية" : "المتبقي"}
          value={formatMoney(budget.totals.remaining)}
          tone={overBudget ? "danger" : "default"}
        />
      </div>
    </>
  );
}

// A single real percentage (never a fabricated time series) rendered as an
// SVG radial gauge — the one genuine chart on this page, used twice above.
function RadialGauge({ value, label, color }: { value: number | null; label: string; color: string }) {
  const size = 132;
  const stroke = 11;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const pct = Math.min(100, Math.max(0, value ?? 0));
  const offset = circumference * (1 - pct / 100);
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#f1f5f9" strokeWidth={stroke} />
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
          <span className="text-2xl font-extrabold text-stone-900">{value !== null ? formatPercent(value, 0) : "—"}</span>
        </div>
      </div>
      <span className="text-sm font-semibold text-stone-600">{label}</span>
    </div>
  );
}

// ── LEVEL 5 — Needs Attention ────────────────────────────────────────────
type AttentionSeverity = "critical" | "attention" | "info";
interface AttentionItem {
  severity: AttentionSeverity;
  text: string;
  metric?: string;
  href: string;
}

function buildNeedsAttention(input: {
  projectId: string;
  activeAlerts: BudgetAlert[];
  overdueTasks: ProjectTask[];
  criticalPunch: PunchItem[];
  ipcsAwaitingCertification: Ipc[];
  pendingCommitments: Commitment[];
  measurementsAwaitingApproval: Measurement[];
  forecastMethod: ForecastResult["methods"]["commitment_aware"];
}): AttentionItem[] {
  const items: AttentionItem[] = [];
  const p = input.projectId;

  if (input.forecastMethod.variance < 0) {
    items.push({
      severity: "critical",
      text: "التوقعات تتجاوز الميزانية المعتمدة",
      metric: formatMoney(Math.abs(input.forecastMethod.variance)),
      href: `/projects/${p}/forecast`,
    });
  }
  for (const a of [...input.activeAlerts].sort((x, y) => (x.severity === "critical" ? -1 : 1)).slice(0, 3)) {
    items.push({
      severity: a.severity === "critical" ? "critical" : a.severity === "warning" ? "attention" : "info",
      text: a.title,
      metric: alertSeverityLabel[a.severity],
      href: `/budget-alerts?projectId=${p}`,
    });
  }
  if (input.criticalPunch.length > 0) {
    items.push({
      severity: "critical",
      text: `${input.criticalPunch.length} ملاحظة حرجة مفتوحة في قائمة الملاحظات`,
      href: `/projects/${p}/punch-list`,
    });
  }
  if (input.overdueTasks.length > 0) {
    items.push({
      severity: "attention",
      text: `${input.overdueTasks.length} مهمة متأخرة عن الجدول الزمني`,
      href: `/projects/${p}/schedule`,
    });
  }
  if (input.ipcsAwaitingCertification.length > 0) {
    items.push({
      severity: "attention",
      text: `${input.ipcsAwaitingCertification.length} شهادة دفع (IPC) بانتظار التصديق`,
      href: `/projects/${p}/ipc`,
    });
  }
  if (input.pendingCommitments.length > 0) {
    items.push({
      severity: "attention",
      text: `${input.pendingCommitments.length} التزام شراء بانتظار الاعتماد`,
      href: `/projects/${p}/procurement`,
    });
  }
  if (input.measurementsAwaitingApproval.length > 0) {
    items.push({
      severity: "info",
      text: `${input.measurementsAwaitingApproval.length} قياس إنجاز بانتظار الاعتماد`,
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
  critical: "border-r-danger-500 text-danger-600",
  attention: "border-r-warning-500 text-warning-600",
  info: "border-r-info-500 text-info-600",
};
const attentionCountLabel: Record<AttentionSeverity, string> = { critical: "حرج", attention: "تنبيه", info: "معلومات" };

function NeedsAttentionCard({ items }: { items: AttentionItem[] }) {
  const counts = {
    critical: items.filter((i) => i.severity === "critical").length,
    attention: items.filter((i) => i.severity === "attention").length,
    info: items.filter((i) => i.severity === "info").length,
  };

  return (
    <>
      <SectionHeader
        icon={IconAlertTriangle}
        tone={counts.critical > 0 ? "danger" : counts.attention > 0 ? "warning" : "success"}
        tier="primary"
        title="يحتاج إلى انتباه"
        action={
          <div className="flex items-center gap-1.5">
            {(["critical", "attention", "info"] as const).map((sev) => (
              <span key={sev} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${badgeTone[healthBadgeTone[sev === "critical" ? "critical" : sev === "attention" ? "watch" : "neutral"]]}`}>
                {counts[sev]} {attentionCountLabel[sev]}
              </span>
            ))}
          </div>
        }
      />
      {items.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-stone-400">
          <IconTrend width={16} height={16} />
          لا توجد حالياً بنود تحتاج إلى انتباه.
        </p>
      ) : (
        <ul className="space-y-2">
          {items.map((item, i) => {
            const Icon = attentionIcon[item.severity];
            return (
              <li key={i}>
                <Link
                  to={item.href}
                  className={`flex items-center justify-between gap-3 rounded-md border-r-4 bg-stone-50/60 px-3 py-2.5 text-sm transition hover:bg-stone-100 ${attentionAccent[item.severity]}`}
                >
                  <span className="flex items-center gap-2.5 text-stone-700">
                    <Icon width={16} height={16} className={attentionAccent[item.severity].split(" ")[1]} />
                    {item.text}
                  </span>
                  {item.metric && <span className="shrink-0 text-xs font-bold text-stone-600">{item.metric}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

// ── LEVEL 6 — Progress + Schedule ───────────────────────────────────────
function ProgressScheduleCard({
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
  return (
    <>
      <SectionHeader
        icon={IconCalendar}
        tier="secondary"
        title="الإنجاز والجدول الزمني"
        action={
          <Link to={`/projects/${projectId}/schedule`} className="text-sm font-medium text-primary hover:underline">
            فتح الجدول الزمني
          </Link>
        }
      />
      {tasks.length === 0 ? (
        <p className="text-sm text-stone-400">لا توجد بيانات جدولة بعد.</p>
      ) : (
        // Capped at 2 columns (not 3) — this zone shares its row with Cash
        // Flow now, so it never has true full-page width to spare.
        <div className="grid grid-cols-2 gap-4">
          <MetricCard label="الإنجاز العام" value={avgProgress !== null ? formatPercent(avgProgress) : "—"} />
          <MetricCard
            label="حالة الجدول"
            value={overdueTasks.length > 0 ? `${overdueTasks.length} متأخرة` : "على المسار الصحيح"}
            tone={overdueTasks.length > 0 ? "warning" : "success"}
          />
          <MetricCard
            label="المعلم القادم"
            value={nextMilestone ? formatDate(nextMilestone.endDate) : "—"}
            hint={nextMilestone?.name}
          />
        </div>
      )}
      {measurementsAwaitingApproval.length > 0 && (
        <p className="mt-3 text-xs text-stone-500">
          <Link to={`/projects/${projectId}/progress`} className="text-primary hover:underline">
            {measurementsAwaitingApproval.length} قياس إنجاز بانتظار الاعتماد
          </Link>
        </p>
      )}
    </>
  );
}

// ── LEVEL 7 — Cash Flow ──────────────────────────────────────────────────
function CashFlowCard({ cashFlow, projectId }: { cashFlow: CashFlowResult; projectId: string }) {
  return (
    <>
      <SectionHeader
        icon={IconWallet}
        tier="secondary"
        title="التدفق النقدي"
        action={
          <Link to={`/projects/${projectId}/cash-flow`} className="text-sm font-medium text-primary hover:underline">
            التفاصيل الكاملة
          </Link>
        }
      />
      <div className="grid grid-cols-2 gap-3">
        <MetricCard label="المُحصَّل فعلياً" value={formatMoney(cashFlow.historical.cashReceived, cashFlow.currency)} />
        <MetricCard label="التكلفة المتكبَّدة" value={formatMoney(cashFlow.historical.incurredCost, cashFlow.currency)} />
        <MetricCard label="مستحقات متوقعة" value={formatMoney(cashFlow.projected.receivables, cashFlow.currency)} />
        <MetricCard
          label="صافي المتوقع"
          value={formatMoney(cashFlow.projected.net, cashFlow.currency)}
          tone={cashFlow.projected.net < 0 ? "danger" : "success"}
        />
      </div>
    </>
  );
}

// ── LEVEL 8 — Procurement / Commitments ─────────────────────────────────
function ProcurementCard({
  projectId,
  totalCommitted,
  approvedCommitted,
  pendingCommitted,
  pendingCount,
  currency,
}: {
  projectId: string;
  totalCommitted: number;
  approvedCommitted: number;
  pendingCommitted: number;
  pendingCount: number;
  currency: string;
}) {
  return (
    <>
      <SectionHeader
        icon={IconPackage}
        tier="secondary"
        title="المشتريات والالتزامات"
        action={
          <Link to={`/projects/${projectId}/procurement`} className="text-sm font-medium text-primary hover:underline">
            فتح المشتريات
          </Link>
        }
      />
      <MetricCard label="إجمالي الالتزامات" value={formatMoney(totalCommitted, currency)} />
      <div className="mt-3 grid grid-cols-2 gap-3">
        <MetricCard label="نشطة / منفَّذة" value={formatMoney(approvedCommitted, currency)} tone="success" />
        <MetricCard label={`بانتظار الاعتماد (${pendingCount})`} value={formatMoney(pendingCommitted, currency)} tone="warning" />
      </div>
    </>
  );
}

// ── LEVEL 9 — Commercial Execution (IPC + Labor Cost) ───────────────────
// IPC and distributed labor cost are two distinct real data sources
// (Ipc[] and ProjectLaborCost) — grouped under one panel purely as
// presentation (one visual object instead of two competing tertiary
// cards), each keeping its own heading, figures, and drill-down link
// untouched.
function CommercialExecutionCard({
  projectId,
  awaitingCertification,
  awaitingApproval,
  certifiedTotal,
  certifiedCount,
  currency,
  laborCost,
}: {
  projectId: string;
  awaitingCertification: number;
  awaitingApproval: number;
  certifiedTotal: number;
  certifiedCount: number;
  currency: string;
  laborCost: ProjectLaborCost;
}) {
  return (
    <>
      <SectionHeader icon={IconClipboard} tier="secondary" title="التنفيذ التجاري" meta="شهادات الدفع وتكلفة العمالة" />
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold text-stone-500">شهادات الدفع (IPC)</h3>
          <Link to={`/projects/${projectId}/ipc`} className="text-xs font-medium text-primary hover:underline">
            فتح الشهادات
          </Link>
        </div>
        <MetricCard label={`القيمة المصدَّقة (${certifiedCount})`} value={formatMoney(certifiedTotal, currency)} tone="success" />
        <div className="mt-3 grid grid-cols-2 gap-3">
          <MetricCard label="بانتظار التصديق" value={String(awaitingCertification)} tone={awaitingCertification > 0 ? "warning" : "default"} />
          <MetricCard label="بانتظار الاعتماد" value={String(awaitingApproval)} tone={awaitingApproval > 0 ? "warning" : "default"} />
        </div>
      </div>
      <div className="mt-4 border-t border-stone-100 pt-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold text-stone-500">تكلفة العمالة الموزَّعة</h3>
          {laborCost.allocationCount > 0 && laborCost.posted ? <Badge tone="success">مرحّلة بالكامل</Badge> : null}
        </div>
        {laborCost.allocationCount === 0 ? (
          <p className="text-sm text-stone-400">لا توجد تكلفة عمالة موزعة</p>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <MetricCard label="إجمالي الموزَّع" value={formatMoney(laborCost.allocatedTotal)} />
            <MetricCard label="عدد التوزيعات" value={String(laborCost.allocationCount)} />
          </div>
        )}
        <div className="mt-3 text-end">
          <Link to="/payroll" className="text-xs font-medium text-primary hover:underline">
            عرض تفاصيل توزيع الرواتب
          </Link>
        </div>
      </div>
    </>
  );
}

// ── LEVEL 10 — Recent Activity ───────────────────────────────────────────
const activityVerb: Record<string, string> = {
  "ipc.certified": "تم تصديق شهادة الدفع",
  "ipc.approved": "تم اعتماد شهادة الدفع",
  "ipc.submitted": "تم إرسال شهادة الدفع للاعتماد",
  "ipc.rejected": "تم رفض شهادة الدفع",
  "commitment.approved": "تم اعتماد التزام الشراء",
  "commitment.submitted": "تم إرسال التزام الشراء للاعتماد",
  "commitment.termsUpdated": "تم تعديل شروط التزام الشراء",
  "measurement.approved": "تم اعتماد قياس الإنجاز",
  "measurement.submitted": "تم إرسال قياس الإنجاز للاعتماد",
  "boq_revision.published": "تم نشر نسخة جدول الكميات",
};

function ActivityFeedCard({ events }: { events: ActivityEvent[] }) {
  return (
    <Panel tier="tertiary">
      <SectionHeader icon={IconActivity} tier="tertiary" title="آخر النشاطات" />
      {events.length === 0 ? (
        <p className="text-sm text-stone-400">لا توجد نشاطات مسجَّلة لهذا المشروع بعد.</p>
      ) : (
        <ul className="space-y-1">
          {events.map((e, i) => (
            <li key={e.id} className="relative flex items-center justify-between gap-3 py-2 text-sm">
              <span className="flex items-center gap-2.5 text-stone-700">
                <span className="relative flex h-2 w-2 shrink-0 items-center justify-center">
                  <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                  {i < events.length - 1 && <span className="absolute top-2.5 h-6 w-px bg-stone-200" aria-hidden="true" />}
                </span>
                {activityVerb[e.action] ?? e.action}
              </span>
              <span className="shrink-0 text-xs text-stone-400">{formatDateTime(e.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ── LEVEL 11 — Quick Actions ─────────────────────────────────────────────
// Plain navigation to each domain's own existing, already permission-
// gated create flow — this never duplicates a Can-wrapped create button
// itself, it only links to the screen that owns it.
function QuickActionsCard({ projectId }: { projectId: string }) {
  // Document upload has no owner-only gate anywhere in this codebase
  // (create/read are member-open, same posture as Tasks/Daily Logs), so
  // it renders unconditionally — every other action below mirrors an
  // existing owner-only permission from auth/permissions.ts exactly.
  const gatedActions: { label: string; href: string; permission: Parameters<typeof Can>[0]["permission"] }[] = [
    { label: "بند جدول كميات", href: "boq", permission: "boq.manage" },
    { label: "التزام شراء", href: "procurement", permission: "commitment.manage" },
    { label: "مصروف", href: "actual-cost", permission: "budget.manage" },
    { label: "شهادة دفع", href: "ipc", permission: "ipc.manage" },
  ];
  // A bare compact action bar, not a Card — Quick Actions is the lowest-
  // priority section on the page and shouldn't carry the same card
  // treatment as an executive zone. Just a top divider + a row of buttons.
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-stone-200 pt-4">
      <span className="text-xs font-semibold text-stone-400">إجراءات سريعة</span>
      {gatedActions.map((a) => (
        <Can key={a.href} permission={a.permission}>
          <Link to={`/projects/${projectId}/${a.href}`}>
            <Button variant="secondary" size="sm" className="flex items-center gap-1.5">
              <IconPlus width={14} height={14} />
              {a.label}
            </Button>
          </Link>
        </Can>
      ))}
      <Link to={`/projects/${projectId}/documents`}>
        <Button variant="secondary" size="sm" className="flex items-center gap-1.5">
          <IconPlus width={14} height={14} />
          رفع مستند
        </Button>
      </Link>
    </div>
  );
}

// ── BOQ revision status — folded into the Financial Control panel's
// footnote (see FinancialWaterfallCard) instead of its own zone, since
// it's a "what was agreed" fact in the same family as Contract/Budget.
// Labels/tones kept as their own constants, unchanged.
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
