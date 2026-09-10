import type { PortalProjectStatus } from "../api/types";

// A client-facing presentation layer over the exact same project_status
// enum the internal company Dashboard reads (client/src/pages/Dashboard.tsx's
// own statusLabel/statusColor) — same three values
// (server/src/db/schema.ts's projectStatusEnum), never an invented
// fourth. The wording here is deliberately the fuller, more
// externally-legible phrasing ("قيد التنفيذ" rather than the internal
// short "نشط") specified for the Client Portal — never a change to the
// underlying enum, only its external translation.
export const portalStatusLabel: Record<PortalProjectStatus, string> = {
  active: "قيد التنفيذ",
  on_hold: "متوقف مؤقتاً",
  completed: "مكتمل",
};

export const portalStatusTone: Record<PortalProjectStatus, "success" | "warning" | "neutral"> = {
  active: "success",
  on_hold: "warning",
  completed: "neutral",
};
