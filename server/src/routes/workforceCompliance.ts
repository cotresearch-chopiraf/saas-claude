import { Router, type Request, type Response } from "express";
import multer from "multer";
import { z } from "zod";
import { and, eq, desc } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  compliancePeriods,
  complianceWorkforceSnapshots,
  nitaqatComplianceRecords,
  gosiComplianceRecords,
  complianceExceptions,
  files,
} from "../db/schema.js";
import { requirePermission } from "../lib/permissions.js";
import { recordAuditEvent } from "../lib/audit.js";
import { uploadFile, getFile, readFileBuffer } from "../lib/storage/index.js";

// =============================================================================
// MIDAD Phase D1 — Nitaqat + GOSI Compliance Tracking Foundation.
//
// NO OFFICIAL GOVERNMENT INTEGRATION EXISTS HERE. This router never calls
// Qiwa, Nitaqat, GOSI, or any Ministry of Human Resources / Social
// Insurance API — no such integration was discovered, verified, or built.
// Every record this router creates starts sourceType="manual" and
// verificationStatus="unverified"; nothing here ever sets
// verificationStatus="verified" except the three dedicated .../verify
// routes below, and even those never claim official government
// confirmation — they only record that an authorized internal user, with
// supporting evidence/reference, asserts the data is accurate. There is no
// Nitaqat classification FORMULA anywhere in this file: `classification`
// on a Nitaqat record is free text the user copies from wherever they were
// told it (e.g. a Qiwa screen) — MIDAD never computes it. There is no GOSI
// contribution-rate calculation anywhere in this file — registered
// employee counts and status fields are recorded exactly as reported,
// never derived from an invented rate.
//
// Mount collision note: this is deliberately NOT under /api/compliance —
// that prefix and its "compliance.manage" permission already belong to
// the tax/ZATCA compliance domain (routes/compliance.ts). See
// lib/permissions.ts's own comment on laborCompliance.manage for why a
// separate name was required.
//
// Internal only: never mounted under /api/portal/*, and no field here is
// ever named or behaves like clientVisible. See app.ts's own mount
// comment.
// =============================================================================

export const workforceComplianceRouter = Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateField = z.string().regex(DATE_RE, "تنسيق التاريخ غير صالح");

const SOURCE_TYPES = ["manual", "csv_import", "excel_import", "external_reference"] as const;
const VERIFICATION_STATUSES = ["unverified", "pending_verification", "verified"] as const;
const GOSI_STATUSES = ["not_recorded", "recorded", "pending_verification", "verified", "exception"] as const;
const EXCEPTION_SEVERITIES = ["low", "medium", "high", "critical"] as const;

// --- Response shapers — never include companyId (internal detail). ---
function toPeriodResponse(row: typeof compliancePeriods.$inferSelect) {
  return {
    id: row.id,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    label: row.label,
    status: row.status,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
function toSnapshotResponse(row: typeof complianceWorkforceSnapshots.$inferSelect) {
  return {
    id: row.id,
    compliancePeriodId: row.compliancePeriodId,
    snapshotDate: row.snapshotDate,
    totalEmployees: row.totalEmployees,
    saudiEmployees: row.saudiEmployees,
    nonSaudiEmployees: row.nonSaudiEmployees,
    sourceType: row.sourceType,
    sourceReference: row.sourceReference,
    verificationStatus: row.verificationStatus,
    verifiedAt: row.verifiedAt,
    verifiedByUserId: row.verifiedByUserId,
    notes: row.notes,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
function toNitaqatResponse(row: typeof nitaqatComplianceRecords.$inferSelect) {
  return {
    id: row.id,
    compliancePeriodId: row.compliancePeriodId,
    sourceType: row.sourceType,
    verificationStatus: row.verificationStatus,
    classification: row.classification,
    saudiCount: row.saudiCount,
    nonSaudiCount: row.nonSaudiCount,
    totalCount: row.totalCount,
    externalReference: row.externalReference,
    verifiedAt: row.verifiedAt,
    verifiedByUserId: row.verifiedByUserId,
    notes: row.notes,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
function toGosiResponse(row: typeof gosiComplianceRecords.$inferSelect) {
  return {
    id: row.id,
    compliancePeriodId: row.compliancePeriodId,
    registeredEmployeeCount: row.registeredEmployeeCount,
    contributionStatus: row.contributionStatus,
    submissionStatus: row.submissionStatus,
    paymentStatus: row.paymentStatus,
    sourceType: row.sourceType,
    verificationStatus: row.verificationStatus,
    externalReference: row.externalReference,
    verifiedAt: row.verifiedAt,
    verifiedByUserId: row.verifiedByUserId,
    notes: row.notes,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
function toExceptionResponse(row: typeof complianceExceptions.$inferSelect) {
  return {
    id: row.id,
    compliancePeriodId: row.compliancePeriodId,
    category: row.category,
    description: row.description,
    severity: row.severity,
    status: row.status,
    dueDate: row.dueDate,
    resolvedAt: row.resolvedAt,
    resolvedByUserId: row.resolvedByUserId,
    closedAt: row.closedAt,
    closedByUserId: row.closedByUserId,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
function toEvidenceResponse(row: { id: string; fileName: string; mimeType: string; size: number; uploadedAt: Date }) {
  return { id: row.id, fileName: row.fileName, mimeType: row.mimeType, size: row.size, uploadedAt: row.uploadedAt };
}

// --- Dashboard ---
// A small, honest summary — never a computed compliance score/percentage.
// "latest" = most recently created record per period; the caller can see
// every record's true status via the list endpoints.
workforceComplianceRouter.get("/", async (req: Request, res: Response) => {
  const [latestNitaqat, latestGosi, exceptions] = await Promise.all([
    db.query.nitaqatComplianceRecords.findFirst({
      where: eq(nitaqatComplianceRecords.companyId, req.companyId!),
      orderBy: desc(nitaqatComplianceRecords.createdAt),
    }),
    db.query.gosiComplianceRecords.findFirst({
      where: eq(gosiComplianceRecords.companyId, req.companyId!),
      orderBy: desc(gosiComplianceRecords.createdAt),
    }),
    db.query.complianceExceptions.findMany({ where: eq(complianceExceptions.companyId, req.companyId!) }),
  ]);

  const openExceptions = exceptions.filter((e) => e.status === "open" || e.status === "in_progress");
  res.json({
    nitaqat: latestNitaqat ? toNitaqatResponse(latestNitaqat) : null,
    gosi: latestGosi ? toGosiResponse(latestGosi) : null,
    exceptions: {
      open: openExceptions.length,
      highOrCritical: openExceptions.filter((e) => e.severity === "high" || e.severity === "critical").length,
    },
  });
});

// --- Periods ---
const createPeriodSchema = z
  .object({
    periodStart: dateField,
    periodEnd: dateField,
    label: z.string().max(200).optional(),
  })
  .refine((data) => data.periodStart <= data.periodEnd, { message: "تاريخ البداية يجب أن يسبق تاريخ النهاية أو يساويه", path: ["periodEnd"] });

workforceComplianceRouter.get("/periods", async (req: Request, res: Response) => {
  const rows = await db.query.compliancePeriods.findMany({
    where: eq(compliancePeriods.companyId, req.companyId!),
    orderBy: desc(compliancePeriods.periodStart),
  });
  res.json(rows.map(toPeriodResponse));
});

workforceComplianceRouter.post("/periods", requirePermission("laborCompliance.manage"), async (req: Request, res: Response) => {
  const parsed = createPeriodSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const period = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(compliancePeriods)
      .values({ companyId: req.companyId!, periodStart: parsed.data.periodStart, periodEnd: parsed.data.periodEnd, label: parsed.data.label ?? null, createdBy: req.userId! })
      .returning();
    await recordAuditEvent(tx, {
      companyId: req.companyId!,
      actorUserId: req.userId!,
      action: "complianceperiod.created",
      entityType: "compliance_period",
      entityId: created.id,
      afterValue: toPeriodResponse(created),
    });
    return created;
  });
  res.status(201).json(toPeriodResponse(period));
});

workforceComplianceRouter.get("/periods/:id", async (req: Request<{ id: string }>, res: Response) => {
  const period = await db.query.compliancePeriods.findFirst({ where: and(eq(compliancePeriods.id, req.params.id), eq(compliancePeriods.companyId, req.companyId!)) });
  if (!period) return res.status(404).json({ error: "الفترة غير موجودة" });
  res.json(toPeriodResponse(period));
});

const updatePeriodSchema = z
  .object({
    label: z.string().max(200).nullable().optional(),
    status: z.enum(["open", "closed"]).optional(),
  })
  .strict();

workforceComplianceRouter.patch("/periods/:id", requirePermission("laborCompliance.manage"), async (req: Request<{ id: string }>, res: Response) => {
  const existing = await db.query.compliancePeriods.findFirst({ where: and(eq(compliancePeriods.id, req.params.id), eq(compliancePeriods.companyId, req.companyId!)) });
  if (!existing) return res.status(404).json({ error: "الفترة غير موجودة" });
  const parsed = updatePeriodSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(compliancePeriods)
      .set({ ...(parsed.data.label !== undefined ? { label: parsed.data.label } : {}), ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}), updatedAt: new Date() })
      .where(eq(compliancePeriods.id, req.params.id))
      .returning();
    await recordAuditEvent(tx, {
      companyId: req.companyId!,
      actorUserId: req.userId!,
      action: "complianceperiod.updated",
      entityType: "compliance_period",
      entityId: row.id,
      beforeValue: toPeriodResponse(existing),
      afterValue: toPeriodResponse(row),
    });
    return row;
  });
  res.json(toPeriodResponse(updated));
});

// Shared helper: a compliance period id supplied by the client is only
// ever trusted after confirming it belongs to this company.
async function resolvePeriod(companyId: string, compliancePeriodId: string): Promise<boolean> {
  const period = await db.query.compliancePeriods.findFirst({ where: and(eq(compliancePeriods.id, compliancePeriodId), eq(compliancePeriods.companyId, companyId)) });
  return !!period;
}

// --- Workforce snapshots ---
const createSnapshotSchema = z.object({
  compliancePeriodId: z.string().uuid(),
  snapshotDate: dateField,
  totalEmployees: z.number().int().min(0),
  saudiEmployees: z.number().int().min(0),
  nonSaudiEmployees: z.number().int().min(0),
  sourceType: z.enum(SOURCE_TYPES).default("manual"),
  sourceReference: z.string().max(500).optional(),
  notes: z.string().max(2000).optional(),
});

function countsConsistent(total: number, saudi: number, nonSaudi: number): boolean {
  return saudi + nonSaudi === total;
}

workforceComplianceRouter.get("/snapshots", async (req: Request, res: Response) => {
  const rows = await db.query.complianceWorkforceSnapshots.findMany({ where: eq(complianceWorkforceSnapshots.companyId, req.companyId!), orderBy: desc(complianceWorkforceSnapshots.snapshotDate) });
  res.json(rows.map(toSnapshotResponse));
});

workforceComplianceRouter.post("/snapshots", requirePermission("laborCompliance.manage"), async (req: Request, res: Response) => {
  const parsed = createSnapshotSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  if (!countsConsistent(parsed.data.totalEmployees, parsed.data.saudiEmployees, parsed.data.nonSaudiEmployees)) {
    return res.status(400).json({ error: "مجموع عدد السعوديين وغير السعوديين يجب أن يساوي إجمالي عدد الموظفين" });
  }
  if (!(await resolvePeriod(req.companyId!, parsed.data.compliancePeriodId))) return res.status(400).json({ error: "الفترة غير موجودة" });

  const snapshot = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(complianceWorkforceSnapshots)
      .values({
        companyId: req.companyId!,
        compliancePeriodId: parsed.data.compliancePeriodId,
        snapshotDate: parsed.data.snapshotDate,
        totalEmployees: parsed.data.totalEmployees,
        saudiEmployees: parsed.data.saudiEmployees,
        nonSaudiEmployees: parsed.data.nonSaudiEmployees,
        sourceType: parsed.data.sourceType,
        sourceReference: parsed.data.sourceReference ?? null,
        notes: parsed.data.notes ?? null,
        createdBy: req.userId!,
      })
      .returning();
    await recordAuditEvent(tx, { companyId: req.companyId!, actorUserId: req.userId!, action: "complianceworkforcesnapshot.created", entityType: "compliance_workforce_snapshot", entityId: created.id, afterValue: toSnapshotResponse(created) });
    return created;
  });
  res.status(201).json(toSnapshotResponse(snapshot));
});

workforceComplianceRouter.get("/snapshots/:id", async (req: Request<{ id: string }>, res: Response) => {
  const row = await db.query.complianceWorkforceSnapshots.findFirst({ where: and(eq(complianceWorkforceSnapshots.id, req.params.id), eq(complianceWorkforceSnapshots.companyId, req.companyId!)) });
  if (!row) return res.status(404).json({ error: "السجل غير موجود" });
  res.json(toSnapshotResponse(row));
});

const updateSnapshotSchema = z
  .object({
    snapshotDate: dateField.optional(),
    totalEmployees: z.number().int().min(0).optional(),
    saudiEmployees: z.number().int().min(0).optional(),
    nonSaudiEmployees: z.number().int().min(0).optional(),
    sourceType: z.enum(SOURCE_TYPES).optional(),
    sourceReference: z.string().max(500).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .strict();

workforceComplianceRouter.patch("/snapshots/:id", requirePermission("laborCompliance.manage"), async (req: Request<{ id: string }>, res: Response) => {
  const existing = await db.query.complianceWorkforceSnapshots.findFirst({ where: and(eq(complianceWorkforceSnapshots.id, req.params.id), eq(complianceWorkforceSnapshots.companyId, req.companyId!)) });
  if (!existing) return res.status(404).json({ error: "السجل غير موجود" });
  const parsed = updateSnapshotSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const nextTotal = parsed.data.totalEmployees ?? existing.totalEmployees;
  const nextSaudi = parsed.data.saudiEmployees ?? existing.saudiEmployees;
  const nextNonSaudi = parsed.data.nonSaudiEmployees ?? existing.nonSaudiEmployees;
  if (!countsConsistent(nextTotal, nextSaudi, nextNonSaudi)) {
    return res.status(400).json({ error: "مجموع عدد السعوديين وغير السعوديين يجب أن يساوي إجمالي عدد الموظفين" });
  }

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(complianceWorkforceSnapshots)
      .set({
        ...(parsed.data.snapshotDate !== undefined ? { snapshotDate: parsed.data.snapshotDate } : {}),
        totalEmployees: nextTotal,
        saudiEmployees: nextSaudi,
        nonSaudiEmployees: nextNonSaudi,
        ...(parsed.data.sourceType !== undefined ? { sourceType: parsed.data.sourceType } : {}),
        ...(parsed.data.sourceReference !== undefined ? { sourceReference: parsed.data.sourceReference } : {}),
        ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
        updatedAt: new Date(),
      })
      .where(eq(complianceWorkforceSnapshots.id, req.params.id))
      .returning();
    await recordAuditEvent(tx, { companyId: req.companyId!, actorUserId: req.userId!, action: "complianceworkforcesnapshot.updated", entityType: "compliance_workforce_snapshot", entityId: row.id, beforeValue: toSnapshotResponse(existing), afterValue: toSnapshotResponse(row) });
    return row;
  });
  res.json(toSnapshotResponse(updated));
});

workforceComplianceRouter.post("/snapshots/:id/verify", requirePermission("laborCompliance.verify"), async (req: Request<{ id: string }>, res: Response) => {
  const existing = await db.query.complianceWorkforceSnapshots.findFirst({ where: and(eq(complianceWorkforceSnapshots.id, req.params.id), eq(complianceWorkforceSnapshots.companyId, req.companyId!)) });
  if (!existing) return res.status(404).json({ error: "السجل غير موجود" });
  if (!existing.sourceReference) {
    return res.status(400).json({ error: "لا يمكن التحقق بدون مرجع مصدر يوضح سبب اعتبار البيانات موثقة" });
  }

  const updated = await db.transaction(async (tx) => {
    const now = new Date();
    const [row] = await tx.update(complianceWorkforceSnapshots).set({ verificationStatus: "verified", verifiedAt: now, verifiedByUserId: req.userId!, updatedAt: now }).where(eq(complianceWorkforceSnapshots.id, req.params.id)).returning();
    await recordAuditEvent(tx, { companyId: req.companyId!, actorUserId: req.userId!, action: "complianceworkforcesnapshot.verified", entityType: "compliance_workforce_snapshot", entityId: row.id, beforeValue: { verificationStatus: existing.verificationStatus }, afterValue: { verificationStatus: row.verificationStatus } });
    return row;
  });
  res.json(toSnapshotResponse(updated));
});

// --- Evidence (shared implementation for Nitaqat + GOSI records) ---
const MAX_EVIDENCE_SIZE = 10 * 1024 * 1024;
const ALLOWED_EVIDENCE_MIME_TYPES = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);
const evidenceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_EVIDENCE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_EVIDENCE_MIME_TYPES.has(file.mimetype)) return cb(new Error("نوع الملف غير مسموح به"));
    cb(null, true);
  },
});
function handleEvidenceUpload(req: Request, res: Response, next: () => void) {
  evidenceUpload.single("evidence")(req, res, (err: unknown) => {
    if (err) return res.status(400).json({ error: err instanceof Error ? err.message : "تعذّر رفع الملف" });
    next();
  });
}

const NITAQAT_EVIDENCE_ENTITY_TYPE = "nitaqat_compliance_evidence";
const GOSI_EVIDENCE_ENTITY_TYPE = "gosi_compliance_evidence";

async function hasEvidence(companyId: string, entityType: string, entityId: string): Promise<boolean> {
  const evidence = await db.query.files.findFirst({ where: and(eq(files.companyId, companyId), eq(files.entityType, entityType), eq(files.entityId, entityId)) });
  return !!evidence;
}

// --- Nitaqat ---
const createNitaqatSchema = z.object({
  compliancePeriodId: z.string().uuid(),
  classification: z.string().max(200).optional(),
  saudiCount: z.number().int().min(0),
  nonSaudiCount: z.number().int().min(0),
  totalCount: z.number().int().min(0),
  sourceType: z.enum(SOURCE_TYPES).default("manual"),
  externalReference: z.string().max(500).optional(),
  notes: z.string().max(2000).optional(),
});

workforceComplianceRouter.get("/nitaqat", async (req: Request, res: Response) => {
  const rows = await db.query.nitaqatComplianceRecords.findMany({ where: eq(nitaqatComplianceRecords.companyId, req.companyId!), orderBy: desc(nitaqatComplianceRecords.createdAt) });
  res.json(rows.map(toNitaqatResponse));
});

workforceComplianceRouter.post("/nitaqat", requirePermission("laborCompliance.manage"), async (req: Request, res: Response) => {
  const parsed = createNitaqatSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  if (!countsConsistent(parsed.data.totalCount, parsed.data.saudiCount, parsed.data.nonSaudiCount)) {
    return res.status(400).json({ error: "مجموع عدد السعوديين وغير السعوديين يجب أن يساوي إجمالي العدد" });
  }
  if (!(await resolvePeriod(req.companyId!, parsed.data.compliancePeriodId))) return res.status(400).json({ error: "الفترة غير موجودة" });

  const record = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(nitaqatComplianceRecords)
      .values({
        companyId: req.companyId!,
        compliancePeriodId: parsed.data.compliancePeriodId,
        classification: parsed.data.classification ?? null,
        saudiCount: parsed.data.saudiCount,
        nonSaudiCount: parsed.data.nonSaudiCount,
        totalCount: parsed.data.totalCount,
        sourceType: parsed.data.sourceType,
        externalReference: parsed.data.externalReference ?? null,
        notes: parsed.data.notes ?? null,
        createdBy: req.userId!,
      })
      .returning();
    await recordAuditEvent(tx, { companyId: req.companyId!, actorUserId: req.userId!, action: "nitaqatcompliancerecord.created", entityType: "nitaqat_compliance_record", entityId: created.id, afterValue: toNitaqatResponse(created) });
    return created;
  });
  res.status(201).json(toNitaqatResponse(record));
});

workforceComplianceRouter.get("/nitaqat/:id", async (req: Request<{ id: string }>, res: Response) => {
  const row = await db.query.nitaqatComplianceRecords.findFirst({ where: and(eq(nitaqatComplianceRecords.id, req.params.id), eq(nitaqatComplianceRecords.companyId, req.companyId!)) });
  if (!row) return res.status(404).json({ error: "السجل غير موجود" });
  res.json(toNitaqatResponse(row));
});

const updateNitaqatSchema = z
  .object({
    classification: z.string().max(200).nullable().optional(),
    saudiCount: z.number().int().min(0).optional(),
    nonSaudiCount: z.number().int().min(0).optional(),
    totalCount: z.number().int().min(0).optional(),
    sourceType: z.enum(SOURCE_TYPES).optional(),
    externalReference: z.string().max(500).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .strict();

workforceComplianceRouter.patch("/nitaqat/:id", requirePermission("laborCompliance.manage"), async (req: Request<{ id: string }>, res: Response) => {
  const existing = await db.query.nitaqatComplianceRecords.findFirst({ where: and(eq(nitaqatComplianceRecords.id, req.params.id), eq(nitaqatComplianceRecords.companyId, req.companyId!)) });
  if (!existing) return res.status(404).json({ error: "السجل غير موجود" });
  const parsed = updateNitaqatSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const nextTotal = parsed.data.totalCount ?? existing.totalCount;
  const nextSaudi = parsed.data.saudiCount ?? existing.saudiCount;
  const nextNonSaudi = parsed.data.nonSaudiCount ?? existing.nonSaudiCount;
  if (!countsConsistent(nextTotal, nextSaudi, nextNonSaudi)) {
    return res.status(400).json({ error: "مجموع عدد السعوديين وغير السعوديين يجب أن يساوي إجمالي العدد" });
  }

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(nitaqatComplianceRecords)
      .set({
        ...(parsed.data.classification !== undefined ? { classification: parsed.data.classification } : {}),
        saudiCount: nextSaudi,
        nonSaudiCount: nextNonSaudi,
        totalCount: nextTotal,
        ...(parsed.data.sourceType !== undefined ? { sourceType: parsed.data.sourceType } : {}),
        ...(parsed.data.externalReference !== undefined ? { externalReference: parsed.data.externalReference } : {}),
        ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
        updatedAt: new Date(),
      })
      .where(eq(nitaqatComplianceRecords.id, req.params.id))
      .returning();
    await recordAuditEvent(tx, { companyId: req.companyId!, actorUserId: req.userId!, action: "nitaqatcompliancerecord.updated", entityType: "nitaqat_compliance_record", entityId: row.id, beforeValue: toNitaqatResponse(existing), afterValue: toNitaqatResponse(row) });
    return row;
  });
  res.json(toNitaqatResponse(updated));
});

workforceComplianceRouter.post("/nitaqat/:id/verify", requirePermission("laborCompliance.verify"), async (req: Request<{ id: string }>, res: Response) => {
  const existing = await db.query.nitaqatComplianceRecords.findFirst({ where: and(eq(nitaqatComplianceRecords.id, req.params.id), eq(nitaqatComplianceRecords.companyId, req.companyId!)) });
  if (!existing) return res.status(404).json({ error: "السجل غير موجود" });

  const evidencePresent = await hasEvidence(req.companyId!, NITAQAT_EVIDENCE_ENTITY_TYPE, existing.id);
  if (!existing.externalReference && !evidencePresent) {
    return res.status(400).json({ error: "لا يمكن التحقق بدون مرجع خارجي أو دليل داعم" });
  }

  const updated = await db.transaction(async (tx) => {
    const now = new Date();
    const [row] = await tx.update(nitaqatComplianceRecords).set({ verificationStatus: "verified", verifiedAt: now, verifiedByUserId: req.userId!, updatedAt: now }).where(eq(nitaqatComplianceRecords.id, req.params.id)).returning();
    await recordAuditEvent(tx, { companyId: req.companyId!, actorUserId: req.userId!, action: "nitaqatcompliancerecord.verified", entityType: "nitaqat_compliance_record", entityId: row.id, beforeValue: { verificationStatus: existing.verificationStatus }, afterValue: { verificationStatus: row.verificationStatus } });
    return row;
  });
  res.json(toNitaqatResponse(updated));
});

workforceComplianceRouter.get("/nitaqat/:id/evidence", async (req: Request<{ id: string }>, res: Response) => {
  const record = await db.query.nitaqatComplianceRecords.findFirst({ where: and(eq(nitaqatComplianceRecords.id, req.params.id), eq(nitaqatComplianceRecords.companyId, req.companyId!)) });
  if (!record) return res.status(404).json({ error: "السجل غير موجود" });
  const rows = await db.query.files.findMany({ where: and(eq(files.companyId, req.companyId!), eq(files.entityType, NITAQAT_EVIDENCE_ENTITY_TYPE), eq(files.entityId, record.id)), orderBy: (f, { desc: d }) => [d(f.uploadedAt)] });
  res.json(rows.map(toEvidenceResponse));
});

workforceComplianceRouter.post("/nitaqat/:id/evidence", requirePermission("laborCompliance.manage"), handleEvidenceUpload, async (req: Request<{ id: string }>, res: Response) => {
  const record = await db.query.nitaqatComplianceRecords.findFirst({ where: and(eq(nitaqatComplianceRecords.id, req.params.id), eq(nitaqatComplianceRecords.companyId, req.companyId!)) });
  if (!record) return res.status(404).json({ error: "السجل غير موجود" });
  if (!req.file) return res.status(400).json({ error: "لم يتم إرفاق ملف" });

  const stored = await uploadFile({ companyId: req.companyId!, uploadedBy: req.userId!, entityType: NITAQAT_EVIDENCE_ENTITY_TYPE, entityId: record.id, buffer: req.file.buffer, fileName: req.file.originalname, mimeType: req.file.mimetype, namespace: "compliance-evidence" });
  await recordAuditEvent(db, { companyId: req.companyId!, actorUserId: req.userId!, action: "nitaqatcompliancerecord.evidenceadded", entityType: "nitaqat_compliance_record", entityId: record.id, metadata: { fileId: stored.id, fileName: stored.fileName } });
  res.status(201).json(toEvidenceResponse(stored));
});

workforceComplianceRouter.get("/nitaqat/:id/evidence/:fileId", async (req: Request<{ id: string; fileId: string }>, res: Response) => {
  const record = await db.query.nitaqatComplianceRecords.findFirst({ where: and(eq(nitaqatComplianceRecords.id, req.params.id), eq(nitaqatComplianceRecords.companyId, req.companyId!)) });
  if (!record) return res.status(404).json({ error: "السجل غير موجود" });
  const file = await getFile(req.companyId!, req.params.fileId);
  if (!file || file.entityType !== NITAQAT_EVIDENCE_ENTITY_TYPE || file.entityId !== record.id) return res.status(404).json({ error: "الملف غير موجود" });
  const buffer = await readFileBuffer(file.storageKey);
  if (!buffer) return res.status(404).json({ error: "الملف غير موجود" });
  res.setHeader("Content-Type", file.mimeType);
  res.setHeader("Content-Disposition", "attachment");
  res.send(buffer);
});

// --- GOSI ---
const createGosiSchema = z.object({
  compliancePeriodId: z.string().uuid(),
  registeredEmployeeCount: z.number().int().min(0).optional(),
  contributionStatus: z.enum(GOSI_STATUSES).default("not_recorded"),
  submissionStatus: z.enum(GOSI_STATUSES).default("not_recorded"),
  paymentStatus: z.enum(GOSI_STATUSES).default("not_recorded"),
  sourceType: z.enum(SOURCE_TYPES).default("manual"),
  externalReference: z.string().max(500).optional(),
  notes: z.string().max(2000).optional(),
});

workforceComplianceRouter.get("/gosi", async (req: Request, res: Response) => {
  const rows = await db.query.gosiComplianceRecords.findMany({ where: eq(gosiComplianceRecords.companyId, req.companyId!), orderBy: desc(gosiComplianceRecords.createdAt) });
  res.json(rows.map(toGosiResponse));
});

workforceComplianceRouter.post("/gosi", requirePermission("laborCompliance.manage"), async (req: Request, res: Response) => {
  const parsed = createGosiSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  if (!(await resolvePeriod(req.companyId!, parsed.data.compliancePeriodId))) return res.status(400).json({ error: "الفترة غير موجودة" });

  const record = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(gosiComplianceRecords)
      .values({
        companyId: req.companyId!,
        compliancePeriodId: parsed.data.compliancePeriodId,
        registeredEmployeeCount: parsed.data.registeredEmployeeCount ?? null,
        contributionStatus: parsed.data.contributionStatus,
        submissionStatus: parsed.data.submissionStatus,
        paymentStatus: parsed.data.paymentStatus,
        sourceType: parsed.data.sourceType,
        externalReference: parsed.data.externalReference ?? null,
        notes: parsed.data.notes ?? null,
        createdBy: req.userId!,
      })
      .returning();
    await recordAuditEvent(tx, { companyId: req.companyId!, actorUserId: req.userId!, action: "gosicompliancerecord.created", entityType: "gosi_compliance_record", entityId: created.id, afterValue: toGosiResponse(created) });
    return created;
  });
  res.status(201).json(toGosiResponse(record));
});

workforceComplianceRouter.get("/gosi/:id", async (req: Request<{ id: string }>, res: Response) => {
  const row = await db.query.gosiComplianceRecords.findFirst({ where: and(eq(gosiComplianceRecords.id, req.params.id), eq(gosiComplianceRecords.companyId, req.companyId!)) });
  if (!row) return res.status(404).json({ error: "السجل غير موجود" });
  res.json(toGosiResponse(row));
});

const updateGosiSchema = z
  .object({
    registeredEmployeeCount: z.number().int().min(0).nullable().optional(),
    contributionStatus: z.enum(GOSI_STATUSES).optional(),
    submissionStatus: z.enum(GOSI_STATUSES).optional(),
    paymentStatus: z.enum(GOSI_STATUSES).optional(),
    sourceType: z.enum(SOURCE_TYPES).optional(),
    externalReference: z.string().max(500).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .strict();

workforceComplianceRouter.patch("/gosi/:id", requirePermission("laborCompliance.manage"), async (req: Request<{ id: string }>, res: Response) => {
  const existing = await db.query.gosiComplianceRecords.findFirst({ where: and(eq(gosiComplianceRecords.id, req.params.id), eq(gosiComplianceRecords.companyId, req.companyId!)) });
  if (!existing) return res.status(404).json({ error: "السجل غير موجود" });
  const parsed = updateGosiSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(gosiComplianceRecords)
      .set({
        ...(parsed.data.registeredEmployeeCount !== undefined ? { registeredEmployeeCount: parsed.data.registeredEmployeeCount } : {}),
        ...(parsed.data.contributionStatus !== undefined ? { contributionStatus: parsed.data.contributionStatus } : {}),
        ...(parsed.data.submissionStatus !== undefined ? { submissionStatus: parsed.data.submissionStatus } : {}),
        ...(parsed.data.paymentStatus !== undefined ? { paymentStatus: parsed.data.paymentStatus } : {}),
        ...(parsed.data.sourceType !== undefined ? { sourceType: parsed.data.sourceType } : {}),
        ...(parsed.data.externalReference !== undefined ? { externalReference: parsed.data.externalReference } : {}),
        ...(parsed.data.notes !== undefined ? { notes: parsed.data.notes } : {}),
        updatedAt: new Date(),
      })
      .where(eq(gosiComplianceRecords.id, req.params.id))
      .returning();
    await recordAuditEvent(tx, { companyId: req.companyId!, actorUserId: req.userId!, action: "gosicompliancerecord.updated", entityType: "gosi_compliance_record", entityId: row.id, beforeValue: toGosiResponse(existing), afterValue: toGosiResponse(row) });
    return row;
  });
  res.json(toGosiResponse(updated));
});

workforceComplianceRouter.post("/gosi/:id/verify", requirePermission("laborCompliance.verify"), async (req: Request<{ id: string }>, res: Response) => {
  const existing = await db.query.gosiComplianceRecords.findFirst({ where: and(eq(gosiComplianceRecords.id, req.params.id), eq(gosiComplianceRecords.companyId, req.companyId!)) });
  if (!existing) return res.status(404).json({ error: "السجل غير موجود" });

  const evidencePresent = await hasEvidence(req.companyId!, GOSI_EVIDENCE_ENTITY_TYPE, existing.id);
  if (!existing.externalReference && !evidencePresent) {
    return res.status(400).json({ error: "لا يمكن التحقق بدون مرجع خارجي أو دليل داعم" });
  }

  const updated = await db.transaction(async (tx) => {
    const now = new Date();
    const [row] = await tx.update(gosiComplianceRecords).set({ verificationStatus: "verified", verifiedAt: now, verifiedByUserId: req.userId!, updatedAt: now }).where(eq(gosiComplianceRecords.id, req.params.id)).returning();
    await recordAuditEvent(tx, { companyId: req.companyId!, actorUserId: req.userId!, action: "gosicompliancerecord.verified", entityType: "gosi_compliance_record", entityId: row.id, beforeValue: { verificationStatus: existing.verificationStatus }, afterValue: { verificationStatus: row.verificationStatus } });
    return row;
  });
  res.json(toGosiResponse(updated));
});

workforceComplianceRouter.get("/gosi/:id/evidence", async (req: Request<{ id: string }>, res: Response) => {
  const record = await db.query.gosiComplianceRecords.findFirst({ where: and(eq(gosiComplianceRecords.id, req.params.id), eq(gosiComplianceRecords.companyId, req.companyId!)) });
  if (!record) return res.status(404).json({ error: "السجل غير موجود" });
  const rows = await db.query.files.findMany({ where: and(eq(files.companyId, req.companyId!), eq(files.entityType, GOSI_EVIDENCE_ENTITY_TYPE), eq(files.entityId, record.id)), orderBy: (f, { desc: d }) => [d(f.uploadedAt)] });
  res.json(rows.map(toEvidenceResponse));
});

workforceComplianceRouter.post("/gosi/:id/evidence", requirePermission("laborCompliance.manage"), handleEvidenceUpload, async (req: Request<{ id: string }>, res: Response) => {
  const record = await db.query.gosiComplianceRecords.findFirst({ where: and(eq(gosiComplianceRecords.id, req.params.id), eq(gosiComplianceRecords.companyId, req.companyId!)) });
  if (!record) return res.status(404).json({ error: "السجل غير موجود" });
  if (!req.file) return res.status(400).json({ error: "لم يتم إرفاق ملف" });

  const stored = await uploadFile({ companyId: req.companyId!, uploadedBy: req.userId!, entityType: GOSI_EVIDENCE_ENTITY_TYPE, entityId: record.id, buffer: req.file.buffer, fileName: req.file.originalname, mimeType: req.file.mimetype, namespace: "compliance-evidence" });
  await recordAuditEvent(db, { companyId: req.companyId!, actorUserId: req.userId!, action: "gosicompliancerecord.evidenceadded", entityType: "gosi_compliance_record", entityId: record.id, metadata: { fileId: stored.id, fileName: stored.fileName } });
  res.status(201).json(toEvidenceResponse(stored));
});

workforceComplianceRouter.get("/gosi/:id/evidence/:fileId", async (req: Request<{ id: string; fileId: string }>, res: Response) => {
  const record = await db.query.gosiComplianceRecords.findFirst({ where: and(eq(gosiComplianceRecords.id, req.params.id), eq(gosiComplianceRecords.companyId, req.companyId!)) });
  if (!record) return res.status(404).json({ error: "السجل غير موجود" });
  const file = await getFile(req.companyId!, req.params.fileId);
  if (!file || file.entityType !== GOSI_EVIDENCE_ENTITY_TYPE || file.entityId !== record.id) return res.status(404).json({ error: "الملف غير موجود" });
  const buffer = await readFileBuffer(file.storageKey);
  if (!buffer) return res.status(404).json({ error: "الملف غير موجود" });
  res.setHeader("Content-Type", file.mimeType);
  res.setHeader("Content-Disposition", "attachment");
  res.send(buffer);
});

// --- Exceptions ---
const createExceptionSchema = z.object({
  compliancePeriodId: z.string().uuid().nullable().optional(),
  category: z.string().max(200).optional(),
  description: z.string().min(2, "الوصف قصير جداً").max(2000, "الوصف طويل جداً"),
  severity: z.enum(EXCEPTION_SEVERITIES).default("medium"),
  dueDate: dateField.nullable().optional(),
});

workforceComplianceRouter.get("/exceptions", async (req: Request, res: Response) => {
  const conditions = [eq(complianceExceptions.companyId, req.companyId!)];
  const statusQuery = req.query.status;
  if (typeof statusQuery === "string" && ["open", "in_progress", "resolved", "closed"].includes(statusQuery)) {
    conditions.push(eq(complianceExceptions.status, statusQuery as "open" | "in_progress" | "resolved" | "closed"));
  }
  const severityQuery = req.query.severity;
  if (typeof severityQuery === "string" && (EXCEPTION_SEVERITIES as readonly string[]).includes(severityQuery)) {
    conditions.push(eq(complianceExceptions.severity, severityQuery as (typeof EXCEPTION_SEVERITIES)[number]));
  }
  const rows = await db.query.complianceExceptions.findMany({ where: and(...conditions), orderBy: desc(complianceExceptions.createdAt) });
  res.json(rows.map(toExceptionResponse));
});

workforceComplianceRouter.post("/exceptions", requirePermission("laborCompliance.manage"), async (req: Request, res: Response) => {
  const parsed = createExceptionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  if (parsed.data.compliancePeriodId && !(await resolvePeriod(req.companyId!, parsed.data.compliancePeriodId))) {
    return res.status(400).json({ error: "الفترة غير موجودة" });
  }

  const exception = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(complianceExceptions)
      .values({
        companyId: req.companyId!,
        compliancePeriodId: parsed.data.compliancePeriodId ?? null,
        category: parsed.data.category ?? null,
        description: parsed.data.description,
        severity: parsed.data.severity,
        dueDate: parsed.data.dueDate ?? null,
        createdBy: req.userId!,
      })
      .returning();
    await recordAuditEvent(tx, { companyId: req.companyId!, actorUserId: req.userId!, action: "complianceexception.created", entityType: "compliance_exception", entityId: created.id, afterValue: toExceptionResponse(created) });
    return created;
  });
  res.status(201).json(toExceptionResponse(exception));
});

workforceComplianceRouter.get("/exceptions/:id", async (req: Request<{ id: string }>, res: Response) => {
  const row = await db.query.complianceExceptions.findFirst({ where: and(eq(complianceExceptions.id, req.params.id), eq(complianceExceptions.companyId, req.companyId!)) });
  if (!row) return res.status(404).json({ error: "الاستثناء غير موجود" });
  res.json(toExceptionResponse(row));
});

const updateExceptionSchema = z
  .object({
    category: z.string().max(200).nullable().optional(),
    description: z.string().min(2).max(2000).optional(),
    severity: z.enum(EXCEPTION_SEVERITIES).optional(),
    dueDate: dateField.nullable().optional(),
    status: z.enum(["open", "in_progress"]).optional(),
  })
  .strict();

workforceComplianceRouter.patch("/exceptions/:id", requirePermission("laborCompliance.manage"), async (req: Request<{ id: string }>, res: Response) => {
  const existing = await db.query.complianceExceptions.findFirst({ where: and(eq(complianceExceptions.id, req.params.id), eq(complianceExceptions.companyId, req.companyId!)) });
  if (!existing) return res.status(404).json({ error: "الاستثناء غير موجود" });
  const parsed = updateExceptionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  if (parsed.data.status !== undefined && (existing.status === "resolved" || existing.status === "closed")) {
    return res.status(400).json({ error: "لا يمكن تغيير حالة استثناء تم حله أو إغلاقه من هذا المسار" });
  }

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(complianceExceptions)
      .set({
        ...(parsed.data.category !== undefined ? { category: parsed.data.category } : {}),
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
        ...(parsed.data.severity !== undefined ? { severity: parsed.data.severity } : {}),
        ...(parsed.data.dueDate !== undefined ? { dueDate: parsed.data.dueDate } : {}),
        ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
        updatedAt: new Date(),
      })
      .where(eq(complianceExceptions.id, req.params.id))
      .returning();
    await recordAuditEvent(tx, { companyId: req.companyId!, actorUserId: req.userId!, action: "complianceexception.updated", entityType: "compliance_exception", entityId: row.id, beforeValue: toExceptionResponse(existing), afterValue: toExceptionResponse(row) });
    return row;
  });
  res.json(toExceptionResponse(updated));
});

workforceComplianceRouter.post("/exceptions/:id/resolve", requirePermission("laborCompliance.manage"), async (req: Request<{ id: string }>, res: Response) => {
  const existing = await db.query.complianceExceptions.findFirst({ where: and(eq(complianceExceptions.id, req.params.id), eq(complianceExceptions.companyId, req.companyId!)) });
  if (!existing) return res.status(404).json({ error: "الاستثناء غير موجود" });
  if (existing.status !== "open" && existing.status !== "in_progress") {
    return res.status(400).json({ error: "لا يمكن حل استثناء بهذه الحالة" });
  }

  const updated = await db.transaction(async (tx) => {
    const now = new Date();
    const [row] = await tx.update(complianceExceptions).set({ status: "resolved", resolvedAt: now, resolvedByUserId: req.userId!, updatedAt: now }).where(eq(complianceExceptions.id, req.params.id)).returning();
    await recordAuditEvent(tx, { companyId: req.companyId!, actorUserId: req.userId!, action: "complianceexception.resolved", entityType: "compliance_exception", entityId: row.id, beforeValue: { status: existing.status }, afterValue: { status: row.status } });
    return row;
  });
  res.json(toExceptionResponse(updated));
});

workforceComplianceRouter.post("/exceptions/:id/close", requirePermission("laborCompliance.manage"), async (req: Request<{ id: string }>, res: Response) => {
  const existing = await db.query.complianceExceptions.findFirst({ where: and(eq(complianceExceptions.id, req.params.id), eq(complianceExceptions.companyId, req.companyId!)) });
  if (!existing) return res.status(404).json({ error: "الاستثناء غير موجود" });
  if (existing.status !== "resolved") {
    return res.status(400).json({ error: "لا يمكن إغلاق استثناء لم يتم حله بعد" });
  }

  const updated = await db.transaction(async (tx) => {
    const now = new Date();
    const [row] = await tx.update(complianceExceptions).set({ status: "closed", closedAt: now, closedByUserId: req.userId!, updatedAt: now }).where(eq(complianceExceptions.id, req.params.id)).returning();
    await recordAuditEvent(tx, { companyId: req.companyId!, actorUserId: req.userId!, action: "complianceexception.closed", entityType: "compliance_exception", entityId: row.id, beforeValue: { status: existing.status }, afterValue: { status: row.status } });
    return row;
  });
  res.json(toExceptionResponse(updated));
});
