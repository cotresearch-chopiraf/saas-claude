import { Router } from "express";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { companies, incidents } from "../db/schema.js";
import { requirePlatformCapability } from "../lib/platformPermissions.js";
import { recordAuditEvent } from "../lib/audit.js";
import { logger } from "../lib/logger.js";

// MIDAD Final Pre-Launch audit, Phase 13 — Observability/Incident Center.
// Manual creation/tracking only, deliberately NOT an automatic
// error->incident pipeline — see db/schema.ts's own header comment above
// the incidents table for the full scope reasoning. Gated by
// "incidents.read"/"incidents.manage" (see lib/platformPermissions.ts):
// owner/admin get both, compliance gets both (ZATCA-domain incidents are
// its own to manage), auditor gets read-only, support gets neither.
//
// companyId is nullable on the table itself, so audit-trail handling
// branches per row: a tenant-scoped incident gets a real audit_events row
// (companyId NOT NULL there, same as every other tenant-scoped platform
// action — see routes/platformOrganizations.ts's suspend/reactivate for
// the identical pattern), while a platform-wide incident (no company) has
// no tenant to attach an audit_events row to and uses logger.info()
// instead, the same precedent Phase 2's global feature-flag changes and
// Phase 9's ownership transfer already established.
export const platformIncidentsRouter = Router();

const createSchema = z.object({
  companyId: z.string().uuid().nullable().optional(),
  title: z.string().trim().min(3, "عنوان الحادثة مطلوب"),
  description: z.string().trim().min(3, "وصف الحادثة مطلوب"),
  severity: z.enum(["low", "medium", "high", "critical"]),
  affectedService: z.string().trim().min(1, "الخدمة المتأثرة مطلوبة"),
  correlationId: z.string().trim().min(1).optional(),
});

platformIncidentsRouter.post("/", requirePlatformCapability("incidents.manage"), async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { companyId, title, description, severity, affectedService, correlationId } = parsed.data;

  if (companyId) {
    const company = await db.query.companies.findFirst({ where: eq(companies.id, companyId), columns: { id: true } });
    if (!company) return res.status(404).json({ error: "الشركة غير موجودة" });
  }

  const incident = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(incidents)
      .values({
        companyId: companyId ?? null,
        title,
        description,
        severity,
        affectedService,
        correlationId: correlationId ?? null,
        source: "manual",
        createdByPlatformOperatorId: req.platformOperatorId!,
      })
      .returning();

    if (created.companyId) {
      await recordAuditEvent(tx, {
        companyId: created.companyId,
        actorUserId: null,
        action: "incident.created",
        entityType: "incident",
        entityId: created.id,
        afterValue: { title, severity, affectedService, status: "open" },
        source: "platform_admin",
        metadata: { platformOperatorId: req.platformOperatorId, requestId: req.requestId },
      });
    } else {
      logger.info("platform_incident_created", {
        incidentId: created.id,
        title,
        severity,
        affectedService,
        platformOperatorId: req.platformOperatorId,
        requestId: req.requestId,
      });
    }

    return created;
  });

  res.status(201).json(incident);
});

const listQuerySchema = z.object({
  status: z.enum(["open", "investigating", "resolved"]).optional(),
  companyId: z.string().uuid().optional(),
});

platformIncidentsRouter.get("/", requirePlatformCapability("incidents.read"), async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const conditions = [];
  if (parsed.data.status) conditions.push(eq(incidents.status, parsed.data.status));
  if (parsed.data.companyId) conditions.push(eq(incidents.companyId, parsed.data.companyId));

  const rows = await db.query.incidents.findMany({
    where: conditions.length ? and(...conditions) : undefined,
    orderBy: [desc(incidents.createdAt)],
  });

  res.json(rows);
});

platformIncidentsRouter.get("/:id", requirePlatformCapability("incidents.read"), async (req, res) => {
  const incident = await db.query.incidents.findFirst({ where: eq(incidents.id, req.params.id) });
  if (!incident) return res.status(404).json({ error: "الحادثة غير موجودة" });
  res.json(incident);
});

const updateStatusSchema = z.object({
  status: z.enum(["open", "investigating", "resolved"]),
  resolutionNotes: z.string().trim().min(1).optional(),
});

platformIncidentsRouter.patch("/:id/status", requirePlatformCapability("incidents.manage"), async (req, res) => {
  const parsed = updateStatusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  const { status, resolutionNotes } = parsed.data;

  const existing = await db.query.incidents.findFirst({ where: eq(incidents.id, req.params.id) });
  if (!existing) return res.status(404).json({ error: "الحادثة غير موجودة" });

  // Resolution notes are required to close an incident out — a status
  // flip to "resolved" with no explanation of what was actually done
  // defeats the point of tracking it at all.
  if (status === "resolved" && !resolutionNotes && !existing.resolutionNotes) {
    return res.status(400).json({ error: "ملاحظات الحل مطلوبة عند إغلاق الحادثة" });
  }

  const now = new Date();
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(incidents)
      .set({
        status,
        resolutionNotes: resolutionNotes ?? existing.resolutionNotes,
        resolvedByPlatformOperatorId: status === "resolved" ? req.platformOperatorId! : existing.resolvedByPlatformOperatorId,
        resolvedAt: status === "resolved" ? now : existing.status === "resolved" ? existing.resolvedAt : null,
        updatedAt: now,
      })
      .where(eq(incidents.id, req.params.id))
      .returning();

    if (row.companyId) {
      await recordAuditEvent(tx, {
        companyId: row.companyId,
        actorUserId: null,
        action: "incident.status_updated",
        entityType: "incident",
        entityId: row.id,
        beforeValue: { status: existing.status },
        afterValue: { status, resolutionNotes: row.resolutionNotes },
        source: "platform_admin",
        metadata: { platformOperatorId: req.platformOperatorId, requestId: req.requestId },
      });
    } else {
      logger.info("platform_incident_status_updated", {
        incidentId: row.id,
        previousStatus: existing.status,
        status,
        platformOperatorId: req.platformOperatorId,
        requestId: req.requestId,
      });
    }

    return row;
  });

  res.json(updated);
});
