import type { ReactNode } from "react";

type Tone = "neutral" | "success" | "warning" | "danger" | "info";

const toneClasses: Record<Tone, string> = {
  neutral: "bg-stone-100 text-stone-600",
  success: "bg-success-100 text-success-700",
  warning: "bg-warning-100 text-warning-700",
  danger: "bg-danger-100 text-danger-700",
  info: "bg-info-100 text-info-700",
};

// A colored status pill — purely presentational. Callers own mapping a
// backend status string ("draft", "certified", ...) to a tone; this
// component never encodes domain-specific status meaning itself, so it
// stays reusable across every future MIDAD screen (Commitment, IPC,
// Measurement, Invoice all have their own distinct status vocabularies).
export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${toneClasses[tone]}`}>{children}</span>;
}
