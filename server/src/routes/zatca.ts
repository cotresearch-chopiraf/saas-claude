import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { db } from "../db/client.js";
import { requirePermission } from "../lib/permissions.js";
import { recordAuditEvent } from "../lib/audit.js";
import { logger } from "../lib/logger.js";
import {
  createEgsUnit,
  getEgsUnit,
  listEgsUnits,
  setEgsUnitSecretRef,
  touchEgsUnitLastCommunication,
  updateEgsUnitStatus,
  getZatcaTenantIdentity,
  upsertZatcaTenantIdentity,
  getSubmission,
  listSubmissionsForEgsUnit,
} from "../lib/zatca/domain/index.js";
import { getZatcaSecretStore } from "../lib/zatca/secretStore/index.js";
import { getZatcaProvider } from "../lib/zatca/provider/index.js";
import { ZatcaError, httpStatusForZatcaError } from "../lib/zatca/errors.js";

// MIDAD ZATCA tenant configuration + connection API (Slice 3). Every route
// runs behind requireAuth (mounted in app.ts) — req.companyId is always
// the server-verified tenant from the JWT, never a client-supplied value,
// and every domain-layer call below is scoped by it. Mutations require
// zatca.configure (setup) or zatca.submit (the one route that actually
// contacts ZATCA); GET routes are open to any authenticated member,
// matching every other domain in this codebase's permission matrix.
export const zatcaRouter = Router();

const requireConfigure = requirePermission("zatca.configure");
const requireSubmit = requirePermission("zatca.submit");

interface EgsUnitRow {
  id: string;
  name: string;
  environment: string;
  status: string;
  csidStatus: string;
  certificateExpiresAt: Date | null;
  lastCommunicationAt: Date | null;
  secretRef: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// secretRef itself never leaves this process — only whether one is set.
function sanitizeEgsUnit(unit: EgsUnitRow) {
  return {
    id: unit.id,
    name: unit.name,
    environment: unit.environment,
    status: unit.status,
    csidStatus: unit.csidStatus,
    certificateExpiresAt: unit.certificateExpiresAt,
    lastCommunicationAt: unit.lastCommunicationAt,
    hasCredential: unit.secretRef !== null,
    createdAt: unit.createdAt,
    updatedAt: unit.updatedAt,
  };
}

// GET /api/zatca/config — tenant identity + every EGS unit and its real
// (never fabricated) status.
zatcaRouter.get("/config", async (req: Request, res: Response) => {
  const [identity, units] = await Promise.all([getZatcaTenantIdentity(req.companyId!), listEgsUnits(req.companyId!)]);
  res.json({ identity, egsUnits: units.map(sanitizeEgsUnit) });
});

const identitySchema = z.object({
  vatNumber: z.string().trim().min(1).max(50).optional(),
  commercialRegistration: z.string().trim().min(1).max(50).optional(),
});

// PATCH /api/zatca/config — VAT number / commercial registration.
zatcaRouter.patch("/config", requireConfigure, async (req: Request, res: Response) => {
  const parsed = identitySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });
  if (Object.keys(parsed.data).length === 0) {
    return res.json({ identity: await getZatcaTenantIdentity(req.companyId!) });
  }

  const before = await getZatcaTenantIdentity(req.companyId!);
  const identity = await upsertZatcaTenantIdentity(req.companyId!, parsed.data);
  await recordAuditEvent(db, {
    companyId: req.companyId!,
    actorUserId: req.userId!,
    action: "zatca.identity.updated",
    entityType: "zatca_tenant_identity",
    entityId: req.companyId!,
    beforeValue: before,
    afterValue: identity,
  });
  res.json({ identity });
});

const createEgsUnitSchema = z.object({
  name: z.string().trim().min(1).max(200),
  environment: z.enum(["simulation", "production"]),
});

// POST /api/zatca/egs-units
zatcaRouter.post("/egs-units", requireConfigure, async (req: Request, res: Response) => {
  const parsed = createEgsUnitSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const unit = await createEgsUnit(req.companyId!, parsed.data);
  await recordAuditEvent(db, {
    companyId: req.companyId!,
    actorUserId: req.userId!,
    action: "zatca.egsUnit.created",
    entityType: "zatca_egs_unit",
    entityId: unit.id,
    afterValue: { name: unit.name, environment: unit.environment },
  });
  res.status(201).json(sanitizeEgsUnit(unit));
});

// GET /api/zatca/egs-units/:id
zatcaRouter.get("/egs-units/:id", async (req: Request<{ id: string }>, res: Response) => {
  const unit = await getEgsUnit(req.companyId!, req.params.id);
  if (!unit) return res.status(404).json({ error: "وحدة الفوترة الإلكترونية غير موجودة" });
  res.json(sanitizeEgsUnit(unit));
});

const deactivateSchema = z.object({ status: z.literal("deactivated") });

// PATCH /api/zatca/egs-units/:id — deliberately the ONLY status transition
// a tenant can request directly. "active" is only ever set by
// /verify-connection below, based on a real provider response — never by
// a raw client-supplied value, so MIDAD can never be made to claim a
// connection is active without having actually observed one.
zatcaRouter.patch("/egs-units/:id", requireConfigure, async (req: Request<{ id: string }>, res: Response) => {
  const parsed = deactivateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const existing = await getEgsUnit(req.companyId!, req.params.id);
  if (!existing) return res.status(404).json({ error: "وحدة الفوترة الإلكترونية غير موجودة" });

  const updated = await updateEgsUnitStatus(req.companyId!, req.params.id, "deactivated");
  await recordAuditEvent(db, {
    companyId: req.companyId!,
    actorUserId: req.userId!,
    action: "zatca.egsUnit.deactivated",
    entityType: "zatca_egs_unit",
    entityId: req.params.id,
    beforeValue: { status: existing.status },
    afterValue: { status: updated?.status },
  });
  res.json(sanitizeEgsUnit(updated!));
});

const credentialSchema = z.object({
  binarySecurityToken: z.string().min(1),
  secret: z.string().min(1),
});

// POST /api/zatca/egs-units/:id/credential — the "connect credentials"
// step. The request body is the only place this credential material ever
// appears in plaintext outside ZatcaSecretStore itself: never logged,
// never echoed back, never placed in the audit event's before/after
// values (only the boolean fact that a credential now exists is).
zatcaRouter.post("/egs-units/:id/credential", requireConfigure, async (req: Request<{ id: string }>, res: Response) => {
  const parsed = credentialSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  const existing = await getEgsUnit(req.companyId!, req.params.id);
  if (!existing) return res.status(404).json({ error: "وحدة الفوترة الإلكترونية غير موجودة" });

  const secretRef = await getZatcaSecretStore().put(req.companyId!, req.params.id, parsed.data);
  const withSecret = await setEgsUnitSecretRef(req.companyId!, req.params.id, secretRef);
  // A credential now exists but has not been verified yet — advance out of
  // not_onboarded without claiming it works.
  const finalUnit =
    existing.status === "not_onboarded"
      ? ((await updateEgsUnitStatus(req.companyId!, req.params.id, "onboarding")) ?? withSecret!)
      : withSecret!;

  await recordAuditEvent(db, {
    companyId: req.companyId!,
    actorUserId: req.userId!,
    action: "zatca.egsUnit.credentialConfigured",
    entityType: "zatca_egs_unit",
    entityId: req.params.id,
    afterValue: { hasCredential: true },
  });
  res.json(sanitizeEgsUnit(finalUnit));
});

// DELETE /api/zatca/egs-units/:id/credential
zatcaRouter.delete("/egs-units/:id/credential", requireConfigure, async (req: Request<{ id: string }>, res: Response) => {
  const existing = await getEgsUnit(req.companyId!, req.params.id);
  if (!existing) return res.status(404).json({ error: "وحدة الفوترة الإلكترونية غير موجودة" });
  if (existing.secretRef) await getZatcaSecretStore().delete(req.companyId!, existing.secretRef);
  const updated = await setEgsUnitSecretRef(req.companyId!, req.params.id, null);

  await recordAuditEvent(db, {
    companyId: req.companyId!,
    actorUserId: req.userId!,
    action: "zatca.egsUnit.credentialCleared",
    entityType: "zatca_egs_unit",
    entityId: req.params.id,
    afterValue: { hasCredential: false },
  });
  res.json(sanitizeEgsUnit(updated!));
});

// POST /api/zatca/egs-units/:id/verify-connection — the one route in this
// slice that actually contacts ZATCA (gated by zatca.submit, not
// zatca.configure). Never fabricates a result: no credential -> a real
// NOT_CONNECTED answer without any HTTP call; a credential -> a real
// provider call, whose outcome is persisted and audited exactly as
// received. See lib/zatca/provider/fatooraProvider.ts's checkConnection
// doc comment for precisely what a "connected" result does and does not
// prove.
zatcaRouter.post("/egs-units/:id/verify-connection", requireSubmit, async (req: Request<{ id: string }>, res: Response) => {
  const unit = await getEgsUnit(req.companyId!, req.params.id);
  if (!unit) return res.status(404).json({ error: "وحدة الفوترة الإلكترونية غير موجودة" });

  if (!unit.secretRef) {
    await recordAuditEvent(db, {
      companyId: req.companyId!,
      actorUserId: req.userId!,
      action: "zatca.connectionCheck.attempted",
      entityType: "zatca_egs_unit",
      entityId: unit.id,
      afterValue: { connected: false, reason: "not_connected" },
    });
    return res.json({
      connected: false,
      reason: "not_connected",
      detail: "لم يتم إعداد بيانات الاعتماد بعد",
      egsUnit: sanitizeEgsUnit(unit),
    });
  }

  const credential = await getZatcaSecretStore().resolve(req.companyId!, unit.secretRef);
  if (!credential) {
    await recordAuditEvent(db, {
      companyId: req.companyId!,
      actorUserId: req.userId!,
      action: "zatca.connectionCheck.attempted",
      entityType: "zatca_egs_unit",
      entityId: unit.id,
      afterValue: { connected: false, reason: "credential_unresolvable" },
    });
    return res.json({
      connected: false,
      reason: "not_connected",
      detail: "تعذّر استرجاع بيانات الاعتماد المخزّنة",
      egsUnit: sanitizeEgsUnit(unit),
    });
  }

  try {
    const provider = getZatcaProvider(unit.environment as "simulation" | "production");
    const result = await provider.checkConnection(credential);

    let updatedUnit: EgsUnitRow = unit;
    if (result.connected) {
      updatedUnit = (await updateEgsUnitStatus(req.companyId!, unit.id, "active", { lastCommunicationAt: result.checkedAt })) ?? unit;
    } else {
      await touchEgsUnitLastCommunication(req.companyId!, unit.id, result.checkedAt);
      updatedUnit = { ...unit, lastCommunicationAt: result.checkedAt };
    }

    await recordAuditEvent(db, {
      companyId: req.companyId!,
      actorUserId: req.userId!,
      action: "zatca.connectionCheck.attempted",
      entityType: "zatca_egs_unit",
      entityId: unit.id,
      afterValue: { connected: result.connected, correlationId: result.correlationId, detail: result.detail },
    });

    res.json({
      connected: result.connected,
      reason: result.connected ? "connected" : "credential_rejected",
      detail: result.detail,
      correlationId: result.correlationId,
      checkedAt: result.checkedAt,
      egsUnit: sanitizeEgsUnit(updatedUnit),
    });
  } catch (err) {
    if (err instanceof ZatcaError) {
      // "configuration" means MIDAD never even attempted a network call
      // (loadFatooraEndpointConfig fails before any fetch) — every other
      // category represents a real attempted-or-completed round trip, so
      // only those advance lastCommunicationAt.
      if (err.category !== "configuration") {
        await touchEgsUnitLastCommunication(req.companyId!, unit.id, new Date());
      }
      await recordAuditEvent(db, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "zatca.connectionCheck.error",
        entityType: "zatca_egs_unit",
        entityId: unit.id,
        afterValue: { category: err.category, message: err.message },
      });
      logger.warn("zatca_connection_check_failed", { companyId: req.companyId, egsUnitId: unit.id, category: err.category });
      return res.status(httpStatusForZatcaError(err)).json({ error: err.message, category: err.category });
    }
    throw err;
  }
});

// GET /api/zatca/egs-units/:id/submissions — read-only.
zatcaRouter.get("/egs-units/:id/submissions", async (req: Request<{ id: string }>, res: Response) => {
  const unit = await getEgsUnit(req.companyId!, req.params.id);
  if (!unit) return res.status(404).json({ error: "وحدة الفوترة الإلكترونية غير موجودة" });
  res.json(await listSubmissionsForEgsUnit(req.companyId!, unit.id));
});

// GET /api/zatca/submissions/:id — read-only.
zatcaRouter.get("/submissions/:id", async (req: Request<{ id: string }>, res: Response) => {
  const submission = await getSubmission(req.companyId!, req.params.id);
  if (!submission) return res.status(404).json({ error: "غير موجود" });
  res.json(submission);
});
