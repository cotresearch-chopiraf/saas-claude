import { randomUUID } from "node:crypto";
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
  listSubmissionsForCompany,
  findSubmissionForInvoice,
  createSubmission,
  recordSubmissionOutcome,
  findOwnedInvoiceWithItems,
  computeOnboardingStatus,
  claimNextIcv,
  EgsUnitNotFoundError,
  generateCsrForEgsUnit,
  confirmCsidForEgsUnit,
} from "../lib/zatca/domain/index.js";
import { lockAndReadPihPointer, updatePihPointer } from "../lib/zatca/domain/pih.js";
import { getZatcaSecretStore } from "../lib/zatca/secretStore/index.js";
import { getZatcaProvider } from "../lib/zatca/provider/index.js";
import { getZatcaSigner } from "../lib/zatca/signer/index.js";
import { verifyZatcaSignature } from "../lib/zatca/signer/verify.js";
import { ZatcaError, httpStatusForZatcaError } from "../lib/zatca/errors.js";
import { buildCanonicalDocumentFromInvoice } from "../lib/zatca/documentBuilder.js";
import { buildZatcaInvoiceXml } from "../lib/zatca/xmlBuilder.js";
import { computeCanonicalInvoiceHash } from "../lib/zatca/canonicalHash.js";
import { validateZatcaDocument } from "../lib/zatca/validation.js";

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

// Slice 5 — detects a Postgres unique-violation (23505) on
// zatca_submissions_egs_unit_invoice_unique specifically, never any other
// constraint violation. A raw `pg` DatabaseError propagates through
// drizzle unchanged, carrying `code`/`constraint` — this is standard
// node-postgres error shape, not a ZATCA-specific assumption.
function isDuplicateSubmissionRaceError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; constraint?: unknown };
  return e.code === "23505" && e.constraint === "zatca_submissions_egs_unit_invoice_unique";
}

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

// GET /api/zatca/onboarding-status (Slice 4) — a computed VIEW, never a
// second persisted state machine (see domain/onboarding.ts's file
// comment). Distinguishes configuration/simulation/production explicitly
// rather than collapsing into one boolean — never returns a status
// implying "ZATCA compliant".
zatcaRouter.get("/onboarding-status", async (req: Request, res: Response) => {
  const [identity, units] = await Promise.all([getZatcaTenantIdentity(req.companyId!), listEgsUnits(req.companyId!)]);
  const summary = computeOnboardingStatus(
    identity,
    units.map((u) => ({
      environment: u.environment,
      status: u.status,
      hasCredential: u.secretRef !== null,
    })),
  );
  res.json(summary);
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

const csrFieldsSchema = z.object({
  commonName: z.string().trim().min(1),
  egsSerialNumber: z.string().trim().min(1),
  organizationIdentifier: z.string().trim().min(1),
  organizationUnitName: z.string().trim().min(1),
  organizationName: z.string().trim().min(1),
  countryCode: z.string().trim().min(1),
  invoiceType: z.string().trim().min(1),
  location: z.string().trim().min(1),
  industry: z.string().trim().min(1),
});

const generateCsrSchema = z.object({
  // Never persisted or logged past this request — see domain/csr.ts's
  // file comment.
  otp: z.string().min(1),
  fields: csrFieldsSchema,
  customAttributeOids: z
    .object({
      egsSerialNumber: z.string().trim().min(1).optional(),
      invoiceType: z.string().trim().min(1).optional(),
      location: z.string().trim().min(1).optional(),
      industry: z.string().trim().min(1).optional(),
    })
    .default({}),
});

// POST /api/zatca/egs-units/:id/csr (Slice 5 continuation) — generates a
// real ECDSA key pair + real signed PKCS#10 CSR for this EGS unit and
// stashes the private key in ZatcaSecretStore pending CSID confirmation
// (see domain/csr.ts). Never submits anything to ZATCA — see that file's
// own comment for exactly why that half remains unimplemented. Returns
// the CSR itself (never the private key) so the tenant/operator can carry
// it through whatever real ZATCA onboarding channel they have available.
zatcaRouter.post("/egs-units/:id/csr", requireSubmit, async (req: Request<{ id: string }>, res: Response) => {
  const parsed = generateCsrSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  try {
    const result = await generateCsrForEgsUnit({
      companyId: req.companyId!,
      egsUnitId: req.params.id,
      otp: parsed.data.otp,
      fields: parsed.data.fields,
      customAttributeOids: parsed.data.customAttributeOids,
    });

    await recordAuditEvent(db, {
      companyId: req.companyId!,
      actorUserId: req.userId!,
      action: "zatca.csr.generated",
      entityType: "zatca_egs_unit",
      entityId: req.params.id,
      // The OTP and private key are never included — only the fact that
      // a CSR was generated, the (public) common name used, and (Slice J)
      // the durable CSR Instance row this generation created.
      afterValue: { commonName: parsed.data.fields.commonName, csrInstanceId: result.csrInstanceId },
    });

    // Slice J — the API response is built explicitly from csrPem/
    // csrDerBase64 only, never `result` as a whole, so the new internal
    // csrInstanceId field never reaches this wire response — the existing
    // CSR API contract is unchanged for every consumer.
    res.status(201).json({ csrPem: result.csrPem, csrDerBase64: result.csrDerBase64 });
  } catch (err) {
    if (err instanceof EgsUnitNotFoundError) return res.status(404).json({ error: "وحدة الفوترة الإلكترونية غير موجودة" });
    if (err instanceof ZatcaError) {
      return res.status(httpStatusForZatcaError(err)).json({ error: err.message, category: err.category });
    }
    throw err;
  }
});

const confirmCsidSchema = z.object({
  binarySecurityToken: z.string().min(1),
  secret: z.string().min(1),
  stage: z.enum(["compliance", "production"]),
});

// POST /api/zatca/egs-units/:id/csid (Slice 5 continuation) — records a
// real certificate + secret the tenant obtained from ZATCA (through
// whatever channel actually worked for them — see domain/csr.ts's file
// comment on why MIDAD cannot make this network call itself yet), after
// verifying the certificate's public key actually matches the key pair
// generated for this EGS unit's CSR. Never accepts a mismatched cert/key
// pair, never fabricates csidStatus.
zatcaRouter.post("/egs-units/:id/csid", requireSubmit, async (req: Request<{ id: string }>, res: Response) => {
  const parsed = confirmCsidSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  try {
    const updated = await confirmCsidForEgsUnit({
      companyId: req.companyId!,
      egsUnitId: req.params.id,
      binarySecurityToken: parsed.data.binarySecurityToken,
      secret: parsed.data.secret,
      stage: parsed.data.stage,
    });

    await recordAuditEvent(db, {
      companyId: req.companyId!,
      actorUserId: req.userId!,
      action: "zatca.csid.confirmed",
      entityType: "zatca_egs_unit",
      entityId: req.params.id,
      afterValue: { stage: parsed.data.stage, csidStatus: updated?.csidStatus },
    });

    res.json(sanitizeEgsUnit(updated!));
  } catch (err) {
    if (err instanceof EgsUnitNotFoundError) return res.status(404).json({ error: "وحدة الفوترة الإلكترونية غير موجودة" });
    if (err instanceof ZatcaError) {
      return res.status(httpStatusForZatcaError(err)).json({ error: err.message, category: err.category });
    }
    throw err;
  }
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

// GET /api/zatca/submissions — company-wide history (the tenant UI's
// History tab), across every EGS unit.
zatcaRouter.get("/submissions", async (req: Request, res: Response) => {
  res.json(await listSubmissionsForCompany(req.companyId!));
});

// GET /api/zatca/submissions/:id — read-only.
zatcaRouter.get("/submissions/:id", async (req: Request<{ id: string }>, res: Response) => {
  const submission = await getSubmission(req.companyId!, req.params.id);
  if (!submission) return res.status(404).json({ error: "غير موجود" });
  res.json(submission);
});

// POST /api/zatca/egs-units/:id/invoices/:invoiceId/prepare (Slice 4) —
// builds the real UBL XML for a real MIDAD invoice using the existing
// Slice 1 engine (buildZatcaInvoiceXml/validation.ts, reused unmodified)
// plus Slice 5 continuation's canonicalized invoice hash
// (computeCanonicalInvoiceHash — see canonicalHash.ts) and the existing
// Slice 2 ICV/PIH primitives, all
// inside one transaction so a partial failure can never leave an ICV
// claimed without a matching persisted submission (which would otherwise
// silently create a gap in the counter's real-world meaning). Never
// signs, never contacts ZATCA — see /submit below for that boundary.
//
// IDEMPOTENT per (companyId, egsUnitId, invoiceId): a repeated prepare
// call for the same tuple returns the submission that already exists
// instead of claiming a second ICV/PIH slot or creating a duplicate row.
zatcaRouter.post(
  "/egs-units/:id/invoices/:invoiceId/prepare",
  requireSubmit,
  async (req: Request<{ id: string; invoiceId: string }>, res: Response) => {
    const unit = await getEgsUnit(req.companyId!, req.params.id);
    if (!unit) return res.status(404).json({ error: "وحدة الفوترة الإلكترونية غير موجودة" });

    const invoiceData = await findOwnedInvoiceWithItems(req.companyId!, req.params.invoiceId);
    if (!invoiceData) return res.status(404).json({ error: "الفاتورة غير موجودة" });

    const existing = await findSubmissionForInvoice(req.companyId!, unit.id, req.params.invoiceId);
    if (existing) {
      return res.json({ submission: existing, alreadyExists: true });
    }

    const identity = await getZatcaTenantIdentity(req.companyId!);
    if (!identity.legalName || !identity.vatNumber || !identity.commercialRegistration) {
      return res.status(400).json({
        error: "أكملي بيانات الهوية الضريبية (الرقم الضريبي والسجل التجاري) قبل تحضير مستند ZATCA",
        category: "configuration",
      });
    }

    const zatcaUuid = randomUUID();
    const issueTime = new Date().toISOString().slice(11, 19);
    const supplier = {
      legalName: identity.legalName,
      address: identity.address,
      vatNumber: identity.vatNumber,
      commercialRegistration: identity.commercialRegistration,
    };

    let result;
    try {
      result = await db.transaction(async (tx) => {
        const previousHash = await lockAndReadPihPointer(tx, req.companyId!, unit.id);
        const icv = await claimNextIcv(req.companyId!, unit.id, tx);

        const doc = buildCanonicalDocumentFromInvoice({
          invoice: invoiceData.invoice,
          items: invoiceData.items,
          supplier,
          zatcaUuid,
          invoiceCounterValue: icv,
          previousInvoiceHash: previousHash,
          issueTime,
        });
        const xml = buildZatcaInvoiceXml(doc);
        const documentHash = computeCanonicalInvoiceHash(xml);
        await updatePihPointer(tx, req.companyId!, unit.id, documentHash);

        const submission = await createSubmission(
          req.companyId!,
          {
            egsUnitId: unit.id,
            invoiceId: invoiceData.invoice.id,
            documentTypeCode: doc.documentTypeCode,
            subtype: doc.subtype,
            zatcaUuid: doc.uuid,
            icv,
            pih: previousHash,
            documentHash,
            environment: unit.environment,
            state: "ready_for_submission",
          },
          tx,
        );
        return { submission, xml, doc };
      });
    } catch (err) {
      if (err instanceof EgsUnitNotFoundError) return res.status(404).json({ error: "وحدة الفوترة الإلكترونية غير موجودة" });
      if (isDuplicateSubmissionRaceError(err)) {
        // Slice 5 — a genuinely concurrent request won the race and
        // already inserted the submission for this exact (company, EGS
        // unit, invoice) tuple; this request's own ICV claim and PIH
        // advance were rolled back along with the whole failed
        // transaction (see schema.ts's zatca_submissions_egs_unit_invoice_unique
        // comment), so nothing was wasted. Return the winner's row, same
        // as the pre-check idempotent-return path above.
        const existing = await findSubmissionForInvoice(req.companyId!, req.params.id, req.params.invoiceId);
        if (existing) return res.json({ submission: existing, alreadyExists: true });
      }
      throw err;
    }

    // Safe structural + arithmetic validation only — sdkVerified is always
    // false (see validation.ts); never represented as ZATCA-approved.
    const validation = validateZatcaDocument(result.xml, result.doc);

    await recordAuditEvent(db, {
      companyId: req.companyId!,
      actorUserId: req.userId!,
      action: "zatca.submission.prepared",
      entityType: "zatca_submission",
      entityId: result.submission.id,
      afterValue: {
        egsUnitId: unit.id,
        invoiceId: invoiceData.invoice.id,
        icv: result.submission.icv,
        documentHash: result.submission.documentHash,
      },
    });

    res.status(201).json({ submission: result.submission, validation, alreadyExists: false });
  },
);

// Submission states meaning "already in flight or already has a real
// ZATCA outcome" — /submit is idempotent and refuses to re-attempt any of
// these, so a duplicate click can never create a second real submission.
const SUBMISSION_INFLIGHT_OR_DONE_STATES = new Set(["submitting", "submitted", "cleared", "reported", "compliance_pending"]);

// POST /api/zatca/submissions/:id/submit (Slice 4; real signer wired in
// Slice 5 continuation) — the real Simulation submission attempt.
// Regenerates the exact same XML that was hashed at /prepare time (see
// documentBuilder.ts's issueTime comment) and refuses to proceed if it no
// longer matches the persisted documentHash (the underlying invoice or
// identity changed since prepare). Then requires a real signature via
// lib/zatca/signer/ (XadesZatcaSigner — real XAdES signing, but still
// fails honestly with a configuration error today because no EGS unit's
// credential carries a private key yet: that only exists once CSR/CSID
// onboarding, task #51, issues one) before any provider call: this route
// never sends unsigned XML to ZATCA and never fabricates a submitted
// state. The outcome (success or failure) is always persisted exactly as
// derived from a real error/response, never guessed. The provider call
// itself (clearInvoice for "standard"/B2B, reportInvoice for
// "simplified"/B2C — see lib/zatca/provider/) is intentionally still not
// wired in here: local signature verification (task #49) must run and
// pass BEFORE any signed document is ever sent to ZATCA, and that
// verification step does not exist yet — wiring the provider call ahead
// of it would risk submitting an unverified signature.
zatcaRouter.post("/submissions/:id/submit", requireSubmit, async (req: Request<{ id: string }>, res: Response) => {
  const submission = await getSubmission(req.companyId!, req.params.id);
  if (!submission) return res.status(404).json({ error: "غير موجود" });

  if (SUBMISSION_INFLIGHT_OR_DONE_STATES.has(submission.state)) {
    return res.json({ submission, alreadyAttempted: true });
  }

  const unit = await getEgsUnit(req.companyId!, submission.egsUnitId);
  if (!unit) return res.status(404).json({ error: "وحدة الفوترة الإلكترونية غير موجودة" });
  if (!unit.secretRef) {
    return res.status(400).json({ error: "لم يتم إعداد بيانات الاعتماد لهذه الوحدة", category: "configuration" });
  }
  const credential = await getZatcaSecretStore().resolve(req.companyId!, unit.secretRef);
  if (!credential) {
    return res.status(400).json({ error: "تعذّر استرجاع بيانات الاعتماد المخزّنة", category: "configuration" });
  }
  if (!submission.invoiceId) {
    return res.status(400).json({ error: "هذا النوع من المستندات غير مدعوم بعد", category: "configuration" });
  }

  const invoiceData = await findOwnedInvoiceWithItems(req.companyId!, submission.invoiceId);
  const identity = await getZatcaTenantIdentity(req.companyId!);
  if (!invoiceData || !identity.legalName || !identity.vatNumber || !identity.commercialRegistration) {
    return res.status(400).json({
      error: "تعذّر إعادة توليد المستند — تأكدي من عدم حذف الفاتورة أو بيانات الهوية الضريبية",
      category: "configuration",
    });
  }

  const doc = buildCanonicalDocumentFromInvoice({
    invoice: invoiceData.invoice,
    items: invoiceData.items,
    supplier: {
      legalName: identity.legalName,
      address: identity.address,
      vatNumber: identity.vatNumber,
      commercialRegistration: identity.commercialRegistration,
    },
    zatcaUuid: submission.zatcaUuid,
    invoiceCounterValue: submission.icv,
    previousInvoiceHash: submission.pih,
    issueTime: submission.createdAt.toISOString().slice(11, 19),
  });
  const xml = buildZatcaInvoiceXml(doc);
  const documentHash = computeCanonicalInvoiceHash(xml);
  if (documentHash !== submission.documentHash) {
    const mismatched = await recordSubmissionOutcome(req.companyId!, submission.id, {
      state: "compliance_failed",
      zatcaErrorMessage: "تغيّرت بيانات الفاتورة أو الهوية الضريبية منذ تحضير هذا المستند — أعيدي التحضير قبل الإرسال",
    });
    return res.status(409).json({ error: "المستند لم يعد مطابقاً لما تم تحضيره", submission: mismatched });
  }

  await recordSubmissionOutcome(req.companyId!, submission.id, { state: "submitting", submittedAt: new Date() });

  try {
    // Fails today for every EGS unit that exists in this codebase (no
    // credential carries a private key until CSR/CSID onboarding — task
    // #51 — issues one) — see xadesZatcaSigner.ts.
    const signResult = await getZatcaSigner().sign({ canonicalXml: xml, credential });

    // Slice 5 continuation, task #49 — local (offline) verification MUST
    // pass before any signed document is allowed near a provider call.
    // Entirely self-contained (never touches the private key or
    // credential again) — see verify.ts's file comment.
    const verification = await verifyZatcaSignature(signResult.signedXml);
    if (!verification.valid) {
      throw new ZatcaError(
        "internal",
        `فشل التحقق المحلي من التوقيع قبل الإرسال — لن يتم الإرسال إلى ZATCA (السبب الفني: ${verification.reason ?? "unknown"})`,
      );
    }

    // Local verification passed — this is real, cryptographically valid
    // signing, further than this codebase has ever gotten. The provider
    // call itself (clearInvoice/reportInvoice) is intentionally still not
    // wired in: no EGS unit's credential in this codebase carries a
    // private key today (that requires real CSID onboarding — task #51,
    // not yet built), so this code path is not exercised by any test
    // that runs against this repository's actual routes/domain layer —
    // only by xadesZatcaSigner.ts/verify.ts's own unit tests, which
    // supply a locally-generated test credential directly. Wiring the
    // provider call here ahead of task #51 would be dead code no
    // integration test could actually exercise honestly.
    throw new ZatcaError(
      "internal",
      "التوقيع صالح محلياً لكن الاتصال الفعلي بـ ZATCA غير مُفعّل بعد (يتطلب إصدار شهادة CSID حقيقية)",
    );
  } catch (err) {
    if (err instanceof ZatcaError) {
      const failed = await recordSubmissionOutcome(req.companyId!, submission.id, {
        state: "compliance_failed",
        zatcaErrorCode: err.category,
        zatcaErrorMessage: err.message,
        respondedAt: new Date(),
        incrementRetryCount: true,
      });
      await recordAuditEvent(db, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "zatca.submission.failed",
        entityType: "zatca_submission",
        entityId: submission.id,
        afterValue: { category: err.category, message: err.message },
      });
      logger.warn("zatca_submission_failed", { companyId: req.companyId, submissionId: submission.id, category: err.category });
      return res.status(httpStatusForZatcaError(err)).json({ error: err.message, category: err.category, submission: failed });
    }
    throw err;
  }
});
