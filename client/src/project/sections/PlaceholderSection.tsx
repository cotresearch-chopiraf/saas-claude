import { ComingSoon } from "../../ui/ComingSoon";

// Shared by every not-yet-built project section (Contract, BOQ, Cost
// Plan, Procurement, Actual Cost, Progress, IPC, Forecast, Cash Flow,
// Invoices, Documents) — see App.tsx's route wiring in project/sections.ts.
export function PlaceholderSection({ title, description }: { title: string; description?: string }) {
  return <ComingSoon title={title} description={description} />;
}
