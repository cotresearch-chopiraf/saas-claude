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
// MIDAD — Dashboard 2.0: Construction Executive Command Center.
//
// Composition answers five questions in strict reading-priority order,
// never a flat list of equal-weight cards: (1) Verdict — is the project
// under control, stated as one headline with its one biggest reason, plus
// the three numbers an executive checks first (contract value, physical
// progress, forecast variance). (2) Risk — a single Risk & Health rail
// (compact health chips + the prioritized action list) placed at the
// reading-start position, ahead of the financial detail, because risk
// outranks detail in urgency. (3) Performance — the Contract → Budget →
// Actual → Committed → Forecast chain as one connected flow (not six
// separate cards) directly followed by the Cost-vs-Progress relationship,
// inside one panel. (4) Delivery/Cash/Commercial — three compact,
// deliberately lighter-weight strips (schedule, cash position, procurement
// + IPC + labor), never given the same visual weight as the two primary
// panels above. (5) Pulse — a minimal activity feed and a bare row of
// quick-create links, the lowest-priority information on the page.
//
// Source order equals reading/priority order on every breakpoint (the same
// invariant this page has always held): the same JSX collapses to that
// exact sequence on mobile with no per-breakpoint `order-N` overrides.
// Every figure still comes from this codebase's own already-authoritative
// endpoints (Contract/Budget/Forecast/Cash Flow/Commitments/IPCs/
// Measurements/Schedule/Punch List/Budget Alerts/Labor Cost/BOQ, plus the
// canonical audit_events feed filtered client-side to this project's own
// entity ids) — nothing here computes a second version of a financial
// number the backend already owns, and this redesign changes none of that
// math. The two client-side *compositions* of existing facts (never new
// calculations) are unchanged from the previous design: the prioritized
// Needs Attention list, and the project-scoped Activity feed. The one
// genuine chart on this page (the cost-consumption radial gauge) renders a
// single already-real percentage — no time series exists in this codebase
// to plot, and none is invented here.
//
// Fetching is one Promise.all, unchanged.
// ─────────────────────────────────────────────────────────────────────────

const statusTone: Record<Project["status"], "success" | "warning" | "neutral"> = {
  active: "success",
  on_hold: "warning",
  completed: "neutral",
};

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

  return (
    <div className="flex flex-col gap-6 lg:gap-7">
      {/* The instrument cluster: a familiar top row of stat cards (the same
          "icon + big number + label" convention Procore/Buildertrend/
          Autodesk Construction Cloud all use for their own dashboards) so a
          user coming from any of those platforms recognizes this screen
          immediately, plus one slim warning-light strip underneath for the
          verdict — never a full-width colored takeover. Everything MIDAD-
          specific (the connected financial chain, the prioritized risk
          rail, the cost-vs-progress relationship) still lives one scroll
          down, unchanged — this row is the dashboard, not the whole car. */}
      <KpiRow
        project={project}
        contract={mainContract}
        avgProgress={avgProgress}
        budget={data.budget}
        forecastMethod={forecastMethod}
        currency={data.forecast.currency}
        overdueTasks={overdueTasks}
        scheduleHasData={scheduleTasks.length > 0}
      />
      <AlertStrip verdict={deriveVerdict(health)} topAttention={needsAttention[0]} lastActivityAt={data.activity[0]?.createdAt ?? project.createdAt} />

      {/* Risk sits at the reading-start position (right in Arabic, left in
          English/French) ahead of Performance — priority order, not detail
          volume, decides source order. Performance still gets the larger
          column because a connected six-figure financial chain genuinely
          needs more width than a compact risk rail. */}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-12 xl:gap-6">
        <div className="xl:col-span-4">
          <RiskPanel health={health} items={needsAttention} projectId={projectId} />
        </div>
        <div className="xl:col-span-8">
          <PerformancePanel
            contract={mainContract}
            forecast={data.forecast}
            revision={latestRevision}
            budget={data.budget}
            avgProgress={avgProgress}
            projectId={projectId}
          />
        </div>
      </div>

      {/* Deliberately lighter surfaces than the two primary panels above —
          borderless-shadow strips, smaller type, list rows instead of card
          grids — so the hierarchy is visible at a glance, not just implied
          by position. xl, not lg, for the same reason as the Performance
          panel's flow track: the desktop sidebar (ProjectSidebar.tsx) also
          claims its fixed width starting at `lg`, so three columns at that
          same breakpoint left each strip too little real width (confirmed
          via a live 1024px screenshot). */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <DeliveryStrip
          projectId={projectId}
          tasks={data.tasks}
          overdueTasks={overdueTasks}
          nextMilestone={nextMilestone}
          avgProgress={avgProgress}
          measurementsAwaitingApproval={measurementsAwaitingApproval}
        />
        <CashStrip cashFlow={data.cashFlow} projectId={projectId} />
        <CommercialStrip
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

      <ActivityFeedCard events={projectActivity} />
      <QuickActionsCard projectId={projectId} />
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
// Section weight: the dashboard deliberately does NOT give every panel
// equal visual prominence. Two tiers do real work here: `primary` is the
// Risk and Performance panels — the strongest surface on the page (shadow,
// full padding, larger title). `secondary` is used only for sub-headings
// *inside* a primary panel (Cost vs Progress under Performance, the two
// sub-headings under Risk) and as the header size inside the three lighter
// strips below, which use the separate `FlatStrip` shell (no shadow,
// thinner border, less padding) rather than a smaller version of the same
// card — the weight difference has to be visible, not just implied by a
// few fewer pixels of padding.
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

// A small label row above a sub-block inside a strip (e.g. "Procurement"
// under the Commercial strip) — never its own card, just a quiet divider
// between sub-blocks that share one strip's boundary.
function MicroHeading({ title, action, className = "" }: { title: string; action?: ReactNode; className?: string }) {
  return (
    <div className={`mb-2 flex items-center justify-between gap-3 ${className}`}>
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-stone-400">{title}</h3>
      {action}
    </div>
  );
}

// Elevated-card shell for the two primary panels (Risk, Performance) — the
// strongest surface on the page. Only two of these exist now, where the
// previous design had up to eight (four Zone-pairs, each an independent
// bordered card).
function Panel({ className = "", tier = "primary", children }: { className?: string; tier?: SectionTier; children: ReactNode }) {
  return (
    <Card
      className={`h-full border-stone-200/80 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_1px_8px_rgba(15,23,42,0.03)] ${panelPaddingByTier[tier]} ${className}`}
    >
      {children}
    </Card>
  );
}

// The lighter secondary-tier shell (Delivery/Cash/Commercial strips) —
// deliberately no shadow and a plainer border, so these three visibly read
// as "detail available on request," never competing with Risk/Performance
// for attention.
function FlatStrip({ children }: { children: ReactNode }) {
  return <div className="h-full rounded-lg border border-stone-200 bg-white p-4">{children}</div>;
}

// A compact label:value list row — the secondary-tier equivalent of
// MetricCard, used inside strips where a full card-per-metric grid would
// be too heavy for a tier that's supposed to read as quieter than Risk/
// Performance.
function StatRow({ label, value, hint, tone = "default" }: { label: string; value: string; hint?: string; tone?: "default" | "success" | "warning" | "danger" }) {
  const valueColor = tone === "success" ? "text-success-700" : tone === "warning" ? "text-warning-700" : tone === "danger" ? "text-danger-700" : "text-stone-800";
  return (
    <div className="flex items-baseline justify-between gap-3 py-2 first:pt-0 last:pb-0">
      <span className="shrink-0 text-xs text-stone-500">{label}</span>
      <span className="min-w-0 text-end">
        <span className={`block break-words text-sm font-bold ${valueColor}`}>{value}</span>
        {hint && <span className="mt-0.5 block break-words text-[11px] text-stone-400">{hint}</span>}
      </span>
    </div>
  );
}

// The 2-up grid variant of StatRow, for the few places a strip still needs
// two numbers side by side (e.g. awaiting-certification / awaiting-approval
// counts) rather than a stacked list.
function StatBlock({ label, value, tone = "default" }: { label: string; value: string; tone?: "default" | "success" | "warning" | "danger" }) {
  const valueColor = tone === "success" ? "text-success-700" : tone === "warning" ? "text-warning-700" : tone === "danger" ? "text-danger-700" : "text-stone-800";
  return (
    <div className="min-w-0">
      <p className="text-xs text-stone-500">{label}</p>
      <p className={`mt-0.5 break-words text-sm font-bold ${valueColor}`}>{value}</p>
    </div>
  );
}

// ── Instrument cluster: KPI row + verdict strip ─────────────────────────
// `deriveVerdict` is unchanged: worst tone wins across the already-computed
// health array (one critical indicator makes the whole verdict critical,
// regardless of how many others are healthy) — a summary of facts already
// shown individually below, never a new score.
function deriveVerdict(health: HealthIndicator[]): "healthy" | "watch" | "critical" {
  if (health.some((h) => h.tone === "critical")) return "critical";
  if (health.some((h) => h.tone === "watch")) return "watch";
  return "healthy";
}

// One card = one instrument (speedometer, fuel gauge, warning light) — the
// same "icon + big number + label" tile every competitor dashboard
// (Procore, Buildertrend, Autodesk Construction Cloud) leads with, so a
// user coming from any of them recognizes this row immediately. Deeper,
// MIDAD-specific analysis (the connected financial chain, the prioritized
// risk rail, the cost-vs-progress relationship) is one scroll down,
// unabridged — this row is only the familiar entry point, not a
// replacement for the depth.
function StatCard({
  icon,
  tone = "primary",
  label,
  value,
  valueTone = "default",
  hint,
}: {
  icon: (p: IconProps) => JSX.Element;
  tone?: keyof typeof badgeTone;
  label: string;
  value: string;
  valueTone?: "default" | "success" | "warning" | "danger";
  hint?: string;
}) {
  const valueColor =
    valueTone === "danger" ? "text-danger-700" : valueTone === "success" ? "text-success-700" : valueTone === "warning" ? "text-warning-700" : "text-stone-900";
  // min-w-0 + break-words: same MetricCard-documented fix as every other
  // stat component on this page — a long formatted money string must wrap
  // inside its own card, never overlap the next one.
  return (
    <div className="min-w-0 rounded-lg border border-stone-200 bg-white p-3.5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <div className="flex items-center gap-2">
        <IconBadge icon={icon} tone={tone} tier="secondary" />
        <span className="truncate text-xs font-medium text-stone-500">{label}</span>
      </div>
      <p className={`mt-2 break-words text-xl font-extrabold tracking-tight ${valueColor}`}>{value}</p>
      {hint && <p className="mt-0.5 truncate text-[11px] text-stone-400">{hint}</p>}
    </div>
  );
}

function KpiRow({
  project,
  contract,
  avgProgress,
  budget,
  forecastMethod,
  currency,
  overdueTasks,
  scheduleHasData,
}: {
  project: Project;
  contract: Contract | null;
  avgProgress: number | null;
  budget: BudgetSummary;
  forecastMethod: ForecastResult["methods"]["commitment_aware"];
  currency: string;
  overdueTasks: ProjectTask[];
  scheduleHasData: boolean;
}) {
  const { t, locale } = useTranslation();
  const overBudget = forecastMethod.variance < 0;
  const costConsumption = budget.totals.planned > 0 ? (budget.totals.spent / budget.totals.planned) * 100 : null;

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
      <StatCard
        icon={IconShield}
        tone={statusTone[project.status] === "success" ? "success" : statusTone[project.status] === "warning" ? "warning" : "neutral"}
        label={t("common.status")}
        value={t(`dashboard.status.${project.status}`)}
      />
      <StatCard icon={IconMoney} label={t("dashboard.identity.contractValue")} value={contract ? formatMoney(contract.revisedValue, contract.currency, locale) : "—"} />
      <StatCard
        icon={IconBars}
        label={t("dashboard.identity.progress")}
        value={avgProgress !== null ? formatPercent(avgProgress, 1, locale) : t("dashboard.identity.noData")}
        hint={avgProgress !== null ? t("dashboard.identity.fromSchedule") : undefined}
      />
      <StatCard
        icon={IconTrend}
        label={t("dashboard.costProgress.costConsumption")}
        value={costConsumption !== null ? formatPercent(costConsumption, 1, locale) : "—"}
      />
      <StatCard
        icon={overBudget ? IconAlertTriangle : IconTrend}
        tone={overBudget ? "danger" : "success"}
        label={t("dashboard.financial.expectedVariance")}
        value={`${formatMoney(forecastMethod.variance, currency, locale)} (${formatPercent(forecastMethod.variancePercent, 1, locale)})`}
        valueTone={overBudget ? "danger" : "success"}
      />
      <StatCard
        icon={IconCalendar}
        tone={!scheduleHasData ? "neutral" : overdueTasks.length > 0 ? "warning" : "success"}
        label={t("dashboard.progressSchedule.scheduleStatus")}
        value={
          !scheduleHasData
            ? t("dashboard.health.scheduleNoData")
            : overdueTasks.length > 0
              ? t("dashboard.progressSchedule.tasksOverdueCount", { count: overdueTasks.length })
              : t("dashboard.progressSchedule.onTrack")
        }
        valueTone={scheduleHasData && overdueTasks.length > 0 ? "warning" : "default"}
      />
    </div>
  );
}

// The one warning light on the instrument cluster — a single-line strip,
// never a full-width colored takeover, still carrying the verdict headline
// plus its one biggest reason (or an honest all-clear) so the executive
// read stays a single glance even though the KPI row above no longer
// states it directly.
function AlertStrip({
  verdict,
  topAttention,
  lastActivityAt,
}: {
  verdict: "healthy" | "watch" | "critical";
  topAttention?: AttentionItem;
  lastActivityAt: string;
}) {
  const { t, locale } = useTranslation();
  const toneClass: Record<"healthy" | "watch" | "critical", string> = {
    healthy: "border-success-200 bg-success-50 text-success-700",
    watch: "border-warning-200 bg-warning-50 text-warning-700",
    critical: "border-danger-200 bg-danger-50 text-danger-700",
  };
  const Icon = verdict === "critical" ? IconAlertTriangle : verdict === "watch" ? IconAlertCircle : IconTrend;

  return (
    <div className={`flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-2.5 text-sm ${toneClass[verdict]}`}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Icon width={16} height={16} className="shrink-0" />
        <span className="font-semibold">{t(`dashboard.verdict.${verdict}`)}</span>
        {topAttention ? (
          <Link to={topAttention.href} className="flex flex-wrap items-center gap-x-2 hover:underline">
            <span className="text-stone-400" aria-hidden="true">
              —
            </span>
            <span>{topAttention.text}</span>
            {topAttention.metric && <span className="font-bold">{topAttention.metric}</span>}
          </Link>
        ) : (
          <>
            <span className="text-stone-400" aria-hidden="true">
              —
            </span>
            <span>{t("dashboard.needsAttention.empty")}</span>
          </>
        )}
      </div>
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-stone-400">
        <IconClock width={13} height={13} />
        {t("dashboard.identity.lastUpdated")} {formatDateTime(lastActivityAt, locale)}
      </span>
    </div>
  );
}

// ── Project Health (compact chips, used inside the Risk panel) ─────────
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

// One line per indicator (icon, label, status) rather than the previous
// four-line tile — this rail is now a narrower column, and the detailed
// metric a click away on each domain's own screen.
function HealthChips({ health, projectId }: { health: HealthIndicator[]; projectId: string }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {health.map((h) => {
        const Icon = healthIcon[h.key] ?? IconInfo;
        return (
          <Link
            key={h.key}
            to={h.href === "__company_compliance__" ? "/labor-compliance" : `/projects/${projectId}/${h.href}`}
            className="flex items-center gap-2 rounded-md border border-stone-200 px-2.5 py-2 transition hover:border-stone-300 hover:bg-stone-50"
          >
            <IconBadge icon={Icon} tone={healthBadgeTone[h.tone]} tier="secondary" />
            <span className="min-w-0">
              <span className="block truncate text-xs font-semibold text-stone-700">{h.label}</span>
              <span className="block truncate text-[11px] text-stone-400">{h.statusText}</span>
            </span>
          </Link>
        );
      })}
    </div>
  );
}

// ── Performance panel: Financial flow + Cost vs Progress ────────────────
// forecast.methods.commitment_aware already bundles the entire
// Contract→Budget→Actual→Committed→EAC→Variance chain in one
// already-authoritative object — this panel is a presentation of that one
// object (rendered as one connected flow track, not six separate cards),
// followed immediately by the Cost-vs-Progress relationship, inside one
// panel boundary.
const boqRevisionStatusTone: Record<BoqRevision["status"], "neutral" | "success" | "warning"> = {
  draft: "warning",
  published: "success",
  superseded: "neutral",
};

function PerformancePanel({
  contract,
  forecast,
  revision,
  budget,
  avgProgress,
  projectId,
}: {
  contract: Contract | null;
  forecast: ForecastResult;
  revision: BoqRevision | null;
  budget: BudgetSummary;
  avgProgress: number | null;
  projectId: string;
}) {
  const { t, locale } = useTranslation();
  const m = forecast.methods.commitment_aware;
  const overBudget = m.variance < 0;

  // Every value read verbatim off forecast.methods.commitment_aware / the
  // contract, never recomputed — the step track below is presentation
  // only. No divider arrows (this app has no RTL-aware icon-mirroring
  // convention anywhere yet) — a plain divide-x/divide-x-reverse rule
  // between stages reads correctly in both directions with zero risk of a
  // backwards arrow.
  const stages: { label: string; value: number; href: string }[] = [
    { label: t("dashboard.financial.contractValue"), value: contract ? Number(contract.revisedValue) : m.costPlan, href: "contract" },
    { label: t("dashboard.financial.approvedBudget"), value: m.costPlan, href: "cost-plan" },
    { label: t("dashboard.financial.actualCost"), value: m.actualCost, href: "actual-cost" },
    { label: t("dashboard.financial.commitments"), value: m.committedCost, href: "procurement" },
    { label: t("dashboard.financial.forecastAtCompletion"), value: m.eac, href: "forecast" },
  ];

  const costConsumption = budget.totals.planned > 0 ? (budget.totals.spent / budget.totals.planned) * 100 : null;
  // Same subtraction the previous design already made — surfaced as a
  // plain-language headline with the actual point gap, still just a
  // difference of two already-displayed percentages, not a new financial
  // figure.
  const gap = avgProgress !== null && costConsumption !== null ? costConsumption - avgProgress : null;
  const warnGap = gap !== null && gap > 5;
  const costOverBudget = budget.totals.remaining < 0;

  const headline =
    gap === null
      ? t("dashboard.costProgress.noProgressData")
      : gap > 5
        ? t("dashboard.costProgress.costAheadOfProgress", { gap: formatPercent(gap, 0, locale) })
        : gap < -5
          ? t("dashboard.costProgress.progressAheadOfCost", { gap: formatPercent(Math.abs(gap), 0, locale) })
          : t("dashboard.costProgress.aligned");

  return (
    <Panel tier="primary">
      <SectionHeader
        icon={IconMoney}
        tier="primary"
        title={t("dashboard.financial.title")}
        meta={t("dashboard.financial.asOf", { date: formatDate(forecast.asOfDate, locale) })}
      />

      {/* xl, not lg: the desktop sidebar (ProjectSidebar.tsx) also appears
          starting at `lg`, cutting the content area's real width well
          below 1024px at that exact breakpoint — switching this row to
          horizontal at the same breakpoint the sidebar claims space left
          each of 5 stages too little room and overlapped neighboring
          values (confirmed via a live 1024px screenshot). `min-w-0` +
          `break-words` on each stage is the same MetricCard-documented
          fix as HeroKpi/StatBlock above, kept even after moving the
          breakpoint since a long value can still overflow a narrow
          in-between width. */}
      <div className="flex flex-col divide-y divide-stone-100 overflow-hidden rounded-lg border border-stone-200 xl:flex-row xl:divide-x xl:divide-y-0 xl:divide-x-reverse">
        {stages.map((s) => (
          <Link key={s.label} to={`/projects/${projectId}/${s.href}`} className="min-w-0 flex-1 px-3.5 py-3 transition hover:bg-stone-50">
            <p className="text-[11px] font-medium text-stone-500">{s.label}</p>
            <p className="mt-1 break-words text-sm font-bold text-stone-900 lg:text-base">{formatMoney(s.value, forecast.currency, locale)}</p>
          </Link>
        ))}
      </div>

      <div className={`mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4 ${overBudget ? "border-danger-200 bg-danger-50" : "border-success-200 bg-success-50"}`}>
        <span className={`flex items-center gap-2 text-sm font-semibold ${overBudget ? "text-danger-700" : "text-success-700"}`}>
          {overBudget ? <IconAlertTriangle width={18} height={18} /> : <IconTrend width={18} height={18} />}
          {t("dashboard.financial.expectedVariance")}
          {overBudget ? t("dashboard.financial.overBudgetSuffix") : ""}
        </span>
        <span className={`text-xl font-extrabold ${overBudget ? "text-danger-700" : "text-success-700"}`}>
          {formatMoney(m.variance, forecast.currency, locale)} ({formatPercent(m.variancePercent, 1, locale)})
        </span>
      </div>

      {revision && (
        <p className="mt-3 text-xs text-stone-400">
          {t("dashboard.financial.boqRevision", { number: revision.revisionNumber })}{" "}
          <Badge tone={boqRevisionStatusTone[revision.status]}>{t(`dashboard.financial.boqRevisionStatus.${revision.status}`)}</Badge>{" "}
          <Link to={`/projects/${projectId}/boq`} className="text-primary hover:underline">
            {t("dashboard.financial.openBoq")}
          </Link>
        </p>
      )}

      <div className="mt-6 border-t border-stone-100 pt-5">
        <SectionHeader icon={IconBars} tier="secondary" title={t("dashboard.costProgress.title")} />
        <p className={`mb-5 flex items-center gap-2 text-sm font-bold ${warnGap ? "text-warning-700" : gap !== null ? "text-success-700" : "text-stone-400"}`}>
          {warnGap ? <IconAlertTriangle width={18} height={18} /> : gap !== null ? <IconTrend width={18} height={18} /> : null}
          {headline}
        </p>
        <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-stretch sm:justify-center">
          <RadialGauge value={avgProgress} label={t("dashboard.costProgress.actualProgress")} color="#2563eb" locale={locale} />
          <RadialGauge value={costConsumption} label={t("dashboard.costProgress.costConsumption")} color={warnGap ? "#dc2626" : "#16a34a"} locale={locale} />
        </div>
        <div className="mt-5 grid grid-cols-3 gap-3 border-t border-stone-100 pt-4">
          <MetricCard label={t("dashboard.costProgress.totalPlanned")} value={formatMoney(budget.totals.planned, "SAR", locale)} />
          <MetricCard label={t("dashboard.costProgress.totalSpent")} value={formatMoney(budget.totals.spent, "SAR", locale)} />
          <MetricCard
            label={costOverBudget ? t("dashboard.costProgress.overBudget") : t("dashboard.costProgress.remaining")}
            value={formatMoney(budget.totals.remaining, "SAR", locale)}
            tone={costOverBudget ? "danger" : "default"}
          />
        </div>
      </div>
    </Panel>
  );
}

// A single real percentage (never a fabricated time series) rendered as an
// SVG radial gauge — the one genuine chart on this page, used twice above.
function RadialGauge({ value, label, color, locale }: { value: number | null; label: string; color: string; locale: string }) {
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
          <span className="text-2xl font-extrabold text-stone-900">{value !== null ? formatPercent(value, 0, locale) : "—"}</span>
        </div>
      </div>
      <span className="text-sm font-semibold text-stone-600">{label}</span>
    </div>
  );
}

// ── Risk panel: Health chips + Needs Attention ──────────────────────────
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
const attentionCountKey: Record<AttentionSeverity, string> = {
  critical: "critical",
  attention: "attention",
  info: "info",
};

function RiskPanel({ health, items, projectId }: { health: HealthIndicator[]; items: AttentionItem[]; projectId: string }) {
  const { t } = useTranslation();
  const counts = {
    critical: items.filter((i) => i.severity === "critical").length,
    attention: items.filter((i) => i.severity === "attention").length,
    info: items.filter((i) => i.severity === "info").length,
  };

  return (
    <Panel tier="primary">
      <SectionHeader icon={IconShield} tier="secondary" title={t("dashboard.health.title")} />
      <HealthChips health={health} projectId={projectId} />

      <div className="mt-6 border-t border-stone-100 pt-5">
        <SectionHeader
          icon={IconAlertTriangle}
          tone={counts.critical > 0 ? "danger" : counts.attention > 0 ? "warning" : "success"}
          tier="secondary"
          title={t("dashboard.needsAttention.title")}
          action={
            <div className="flex flex-wrap items-center gap-1.5">
              {(["critical", "attention", "info"] as const).map((sev) => (
                <span key={sev} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${badgeTone[healthBadgeTone[sev === "critical" ? "critical" : sev === "attention" ? "watch" : "neutral"]]}`}>
                  {counts[sev]} {t(`dashboard.needsAttention.${attentionCountKey[sev]}`)}
                </span>
              ))}
            </div>
          }
        />
        {items.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-stone-400">
            <IconTrend width={16} height={16} />
            {t("dashboard.needsAttention.empty")}
          </p>
        ) : (
          <ul className="space-y-2">
            {items.map((item, i) => {
              const Icon = attentionIcon[item.severity];
              return (
                <li key={i}>
                  <Link
                    to={item.href}
                    className={`flex items-center justify-between gap-3 rounded-md border-s-4 bg-stone-50/60 px-3 py-2.5 text-sm transition hover:bg-stone-100 ${attentionAccent[item.severity]}`}
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
      </div>
    </Panel>
  );
}

// ── Secondary strips: Delivery, Cash, Commercial ────────────────────────
function DeliveryStrip({
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
    <FlatStrip>
      <SectionHeader
        icon={IconCalendar}
        tier="secondary"
        title={t("dashboard.progressSchedule.title")}
        action={
          <Link to={`/projects/${projectId}/schedule`} className="text-xs font-medium text-primary hover:underline">
            {t("dashboard.progressSchedule.openSchedule")}
          </Link>
        }
      />
      {tasks.length === 0 ? (
        <p className="text-sm text-stone-400">{t("dashboard.progressSchedule.noData")}</p>
      ) : (
        <div className="divide-y divide-stone-100">
          <StatRow label={t("dashboard.progressSchedule.overallProgress")} value={avgProgress !== null ? formatPercent(avgProgress, 1, locale) : "—"} />
          <StatRow
            label={t("dashboard.progressSchedule.scheduleStatus")}
            value={overdueTasks.length > 0 ? t("dashboard.progressSchedule.tasksOverdueCount", { count: overdueTasks.length }) : t("dashboard.progressSchedule.onTrack")}
            tone={overdueTasks.length > 0 ? "warning" : "success"}
          />
          <StatRow label={t("dashboard.progressSchedule.nextMilestone")} value={nextMilestone ? formatDate(nextMilestone.endDate, locale) : "—"} hint={nextMilestone?.name} />
        </div>
      )}
      {measurementsAwaitingApproval.length > 0 && (
        <p className="mt-3 text-xs text-stone-500">
          <Link to={`/projects/${projectId}/progress`} className="text-primary hover:underline">
            {t("dashboard.progressSchedule.measurementsAwaitingCount", { count: measurementsAwaitingApproval.length })}
          </Link>
        </p>
      )}
    </FlatStrip>
  );
}

function CashStrip({ cashFlow, projectId }: { cashFlow: CashFlowResult; projectId: string }) {
  const { t, locale } = useTranslation();
  return (
    <FlatStrip>
      <SectionHeader
        icon={IconWallet}
        tier="secondary"
        title={t("dashboard.cashFlow.title")}
        action={
          <Link to={`/projects/${projectId}/cash-flow`} className="text-xs font-medium text-primary hover:underline">
            {t("dashboard.cashFlow.fullDetails")}
          </Link>
        }
      />
      <div className="divide-y divide-stone-100">
        <StatRow label={t("dashboard.cashFlow.collected")} value={formatMoney(cashFlow.historical.cashReceived, cashFlow.currency, locale)} />
        <StatRow label={t("dashboard.cashFlow.incurredCost")} value={formatMoney(cashFlow.historical.incurredCost, cashFlow.currency, locale)} />
        <StatRow label={t("dashboard.cashFlow.expectedReceivables")} value={formatMoney(cashFlow.projected.receivables, cashFlow.currency, locale)} />
        <StatRow
          label={t("dashboard.cashFlow.projectedNet")}
          value={formatMoney(cashFlow.projected.net, cashFlow.currency, locale)}
          tone={cashFlow.projected.net < 0 ? "danger" : "success"}
        />
      </div>
    </FlatStrip>
  );
}

// IPC and distributed labor cost are two distinct real data sources (Ipc[]
// and ProjectLaborCost) — grouped with Procurement purely as presentation
// (three sub-blocks sharing one strip instead of three competing cards),
// each keeping its own figures and drill-down link untouched.
function CommercialStrip({
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
    <FlatStrip>
      <SectionHeader icon={IconClipboard} tier="secondary" title={t("dashboard.commercial.title")} meta={t("dashboard.commercial.subtitle")} />

      <MicroHeading
        title={t("dashboard.procurement.title")}
        action={
          <Link to={`/projects/${projectId}/procurement`} className="text-xs font-medium text-primary hover:underline">
            {t("dashboard.procurement.open")}
          </Link>
        }
      />
      <div className="divide-y divide-stone-100">
        <StatRow label={t("dashboard.procurement.totalCommitted")} value={formatMoney(totalCommitted, currency, locale)} />
        <StatRow label={t("dashboard.procurement.activeExecuted")} value={formatMoney(approvedCommitted, currency, locale)} tone="success" />
        <StatRow label={t("dashboard.procurement.pendingApprovalCount", { count: pendingCount })} value={formatMoney(pendingCommitted, currency, locale)} tone="warning" />
      </div>

      <MicroHeading
        className="mt-4 border-t border-stone-100 pt-4"
        title={t("dashboard.commercial.ipcTitle")}
        action={
          <Link to={`/projects/${projectId}/ipc`} className="text-xs font-medium text-primary hover:underline">
            {t("dashboard.commercial.openCertificates")}
          </Link>
        }
      />
      <StatRow label={t("dashboard.commercial.certifiedValueCount", { count: certifiedCount })} value={formatMoney(certifiedTotal, currency, locale)} tone="success" />
      <div className="mt-2 grid grid-cols-2 gap-3">
        <StatBlock label={t("dashboard.commercial.awaitingCertification")} value={String(awaitingCertification)} tone={awaitingCertification > 0 ? "warning" : "default"} />
        <StatBlock label={t("dashboard.commercial.awaitingApproval")} value={String(awaitingApproval)} tone={awaitingApproval > 0 ? "warning" : "default"} />
      </div>

      <MicroHeading
        className="mt-4 border-t border-stone-100 pt-4"
        title={t("dashboard.commercial.laborTitle")}
        action={laborCost.allocationCount > 0 && laborCost.posted ? <Badge tone="success">{t("dashboard.commercial.fullyPosted")}</Badge> : undefined}
      />
      {laborCost.allocationCount === 0 ? (
        <p className="text-sm text-stone-400">{t("dashboard.commercial.noLaborCost")}</p>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <StatBlock label={t("dashboard.commercial.totalAllocated")} value={formatMoney(laborCost.allocatedTotal, "SAR", locale)} />
          <StatBlock label={t("dashboard.commercial.allocationCount")} value={String(laborCost.allocationCount)} />
        </div>
      )}
      <div className="mt-2 text-end">
        <Link to="/payroll" className="text-xs font-medium text-primary hover:underline">
          {t("dashboard.commercial.viewPayrollDetails")}
        </Link>
      </div>
    </FlatStrip>
  );
}

// ── Pulse: Recent Activity + Quick Actions ──────────────────────────────
// The action codes below (e.g. "ipc.certified") are the canonical
// audit_events identifiers, not display text — they double as the dot-path
// suffix under dashboard.activity.verbs.* in every locale dictionary. An
// action code outside this known set (never emitted today, but not
// impossible for a future event type) falls back to the raw code rather
// than a translation lookup, matching the previous `?? e.action` fallback.
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

function ActivityFeedCard({ events }: { events: ActivityEvent[] }) {
  const { t, locale } = useTranslation();
  return (
    <Panel tier="tertiary">
      <SectionHeader icon={IconActivity} tier="tertiary" title={t("dashboard.activity.title")} />
      {events.length === 0 ? (
        <p className="text-sm text-stone-400">{t("dashboard.activity.empty")}</p>
      ) : (
        <ul className="space-y-1">
          {events.map((e, i) => (
            <li key={e.id} className="relative flex items-center justify-between gap-3 py-2 text-sm">
              <span className="flex items-center gap-2.5 text-stone-700">
                <span className="relative flex h-2 w-2 shrink-0 items-center justify-center">
                  <span className="h-1.5 w-1.5 rounded-full bg-primary" />
                  {i < events.length - 1 && <span className="absolute top-2.5 h-6 w-px bg-stone-200" aria-hidden="true" />}
                </span>
                {activityVerbLabel(t, e.action)}
              </span>
              <span className="shrink-0 text-xs text-stone-400">{formatDateTime(e.createdAt, locale)}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// Plain navigation to each domain's own existing, already permission-gated
// create flow — this never duplicates a Can-wrapped create button itself,
// it only links to the screen that owns it.
function QuickActionsCard({ projectId }: { projectId: string }) {
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
  // A bare compact action bar, not a card — Quick Actions is the
  // lowest-priority section on the page and shouldn't carry any card
  // treatment at all. Just a top divider + a row of buttons.
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-stone-200 pt-4">
      <span className="text-xs font-semibold text-stone-400">{t("dashboard.quickActions.title")}</span>
      {gatedActions.map((a) => (
        <Can key={a.href} permission={a.permission}>
          <Link to={`/projects/${projectId}/${a.href}`}>
            <Button variant="secondary" size="sm" className="flex items-center gap-1.5">
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
  );
}
