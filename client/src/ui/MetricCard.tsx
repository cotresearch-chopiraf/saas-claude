type Tone = "default" | "success" | "warning" | "danger";

const toneText: Record<Tone, string> = {
  default: "text-stone-800",
  success: "text-success-700",
  warning: "text-warning-700",
  danger: "text-danger-700",
};

// A single labeled figure — generalizes the ad hoc StatCard that used to
// live inline in BudgetPanel. Deliberately dumb: it renders whatever
// pre-formatted string it's given (via lib/format.ts) and never computes
// anything itself, so a Cost Plan card and a Cash Flow card can sit next
// to each other without ever risking silently blending two different
// financial concepts into one component's internal logic.
export function MetricCard({ label, value, tone = "default", hint }: { label: string; value: string; tone?: Tone; hint?: string }) {
  return (
    <div className="rounded-lg border border-stone-200 bg-white p-4">
      <p className="text-xs text-stone-500">{label}</p>
      <p className={`mt-1 text-lg font-bold ${toneText[tone]}`}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-stone-400">{hint}</p>}
    </div>
  );
}
