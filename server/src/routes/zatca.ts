import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { db } from "../db/client.js";
import type { zatcaSubmissionStateEnum } from "../db/schema.js";
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
  claimSubmissionForSubmit,
  findOwnedInvoiceWithItems,
  computeOnboardingStatus,
  claimNextIcv,
  EgsUnitNotFoundError,
  generateCsrForEgsUnit,
  confirmCsidForEgsUnit,
  requestComplianceCsidForEgsUnit,
  submitComplianceInvoiceForEgsUnit,
  requestProductionCsidOnboardingForEgsUnit,
  renewProductionCsidForEgsUnit,
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

const requestComplianceCsidSchema = z.object({
  // Never persisted or logged past this request — same convention as
  // generateCsrSchema's otp above.
  otp: z.string().min(1),
  // The CSR previously returned by POST .../csr's csrDerBase64 field —
  // this route does not generate or store a CSR itself (see
  // domain/complianceCsid.ts's file comment).
  csrBase64: z.string().min(1),
});

// POST /api/zatca/egs-units/:id/compliance-csid (Slice L) — requests a
// real Compliance CSID from ZATCA for this EGS unit's current CSR
// Instance (see domain/complianceCsid.ts) and persists the result as a
// durable Compliance Lifecycle row. Deliberately does NOT touch this EGS
// unit's csidStatus or active credential — see that module's own file
// comment for why that boundary is a deliberate, narrow choice for this
// slice, not an oversight.
zatcaRouter.post("/egs-units/:id/compliance-csid", requireSubmit, async (req: Request<{ id: string }>, res: Response) => {
  const parsed = requestComplianceCsidSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

  try {
    const lifecycle = await requestComplianceCsidForEgsUnit({
      companyId: req.companyId!,
      egsUnitId: req.params.id,
      otp: parsed.data.otp,
      csrBase64: parsed.data.csrBase64,
    });

    await recordAuditEvent(db, {
      companyId: req.companyId!,
      actorUserId: req.userId!,
      action: "zatca.complianceCsid.requested",
      entityType: "zatca_egs_unit",
      entityId: req.params.id,
      // The OTP, credentials, and CSR are never included — only the
      // durable lifecycle identity and ZATCA's own (non-secret)
      // disposition text.
      afterValue: { complianceLifecycleId: lifecycle.id, requestId: lifecycle.requestId, dispositionMessage: lifecycle.dispositionMessage },
    });

    // The wire response deliberately never includes secretRef or the
    // database lifecycle id (see domain/complianceCsid.ts's file comment
    // and the Slice L spec's API contract section) — only the two fields
    // ZATCA itself returned that are safe to show the caller.
    res.status(201).json({ requestId: lifecycle.requestId, dispositionMessage: lifecycle.dispositionMessage });
  } catch (err) {
    if (err instanceof EgsUnitNotFoundError) return res.status(404).json({ error: "وحدة الفوترة الإلكترونية غير موجودة" });
    if (err instanceof ZatcaError) {
      return res.status(httpStatusForZatcaError(err)).json({ error: err.message, category: err.category });
    }
    throw err;
  }
});

const submitComplianceInvoiceSchema = z.object({
  documentType: z.enum(["388", "381", "383"]),
  // Which ZATCA compliance-test family this attempt targets — required,
  // caller-declared (never inferred from documentType or the CSR here;
  // see domain/complianceInvoice.ts's validateInvoiceFamilyAgainstCsr for
  // the MIDAD-side compatibility check against the resolved CSR).
  invoiceFamily: z.enum(["standard", "simplified"]),
  // The compliance test document itself — this route does not build,
  // sign, or store one; the caller supplies the exact same values ZATCA's
  // Compliance Invoice endpoint expects (see
  // domain/complianceInvoice.ts's file comment for why: zero dependency
  // on real MIDAD invoices or the XAdES signer).
  invoiceXmlBase64: z.string().min(1),
  invoiceHashBase64: z.string().min(1),
  uuid: z.string().uuid(),
});

// POST /api/zatca/egs-units/:id/compliance-invoices (Slice M) — submits
// one real Compliance Invoice test call to ZATCA for this EGS unit's
// current CSR Instance's Compliance Lifecycle (see
// domain/complianceInvoice.ts) and persists the result as one historical
// Compliance Attempt row. Deliberately does NOT touch this Compliance
// Lifecycle's status, this EGS unit's csidStatus, or imply any aggregate
// compliance-completion fact — see that module's own file comment.
zatcaRouter.post(
  "/egs-units/:id/compliance-invoices",
  requireSubmit,
  async (req: Request<{ id: string }>, res: Response) => {
    const parsed = submitComplianceInvoiceSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

    try {
      const { attempt, result } = await submitComplianceInvoiceForEgsUnit({
        companyId: req.companyId!,
        egsUnitId: req.params.id,
        documentType: parsed.data.documentType,
        invoiceFamily: parsed.data.invoiceFamily,
        invoiceXmlBase64: parsed.data.invoiceXmlBase64,
        invoiceHashBase64: parsed.data.invoiceHashBase64,
        uuid: parsed.data.uuid,
      });

      await recordAuditEvent(db, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "zatca.complianceInvoice.attempted",
        entityType: "zatca_egs_unit",
        entityId: req.params.id,
        // The document XML/hash and the credential are never included —
        // only the durable attempt identity and ZATCA's own (non-secret)
        // outcome fields.
        afterValue: {
          complianceAttemptId: attempt.id,
          documentType: attempt.documentType,
          invoiceFamily: attempt.invoiceFamily,
          correlationId: attempt.correlationId,
          normalizedOutcome: attempt.normalizedOutcome,
        },
      });

      // The existing normalized Compliance Invoice result, minus the
      // Clearance-only clearedInvoiceXmlBase64 field (always undefined for
      // this call) — the wire response deliberately never includes
      // secretRef or a database attempt/lifecycle id (see this route's own
      // comment and domain/complianceCsid.ts's established precedent).
      res.status(201).json({
        status: result.status,
        correlationId: result.correlationId,
        rawStatus: result.rawStatus,
        warnings: result.warnings,
        clearanceStatus: result.clearanceStatus,
        qrSellertStatus: result.qrSellertStatus,
        qrBuyertStatus: result.qrBuyertStatus,
        respondedAt: result.respondedAt,
      });
    } catch (err) {
      if (err instanceof EgsUnitNotFoundError) return res.status(404).json({ error: "وحدة الفوترة الإلكترونية غير موجودة" });
      if (err instanceof ZatcaError) {
        return res.status(httpStatusForZatcaError(err)).json({ error: err.message, category: err.category });
      }
      throw err;
    }
  },
);

// POST /api/zatca/egs-units/:id/production-csid (Slice W) — requests a
// real Production CSID from ZATCA for this EGS unit's current CSR
// Instance's Compliance CSID (see domain/productionCsid.ts) and persists
// the result as one historical provider-operation row. Purely an
// INTERNAL EXECUTION HISTORY record — deliberately does NOT touch this
// EGS unit's csidStatus and does NOT imply "onboarding complete." No
// request body: every input this operation needs is already resolved
// server-side from the EGS unit's own current CSR/Compliance chain.
zatcaRouter.post("/egs-units/:id/production-csid", requireSubmit, async (req: Request<{ id: string }>, res: Response) => {
  try {
    const { operation, result } = await requestProductionCsidOnboardingForEgsUnit({
      companyId: req.companyId!,
      egsUnitId: req.params.id,
    });

    await recordAuditEvent(db, {
      companyId: req.companyId!,
      actorUserId: req.userId!,
      action: "zatca.productionCsid.onboardingRequested",
      entityType: "zatca_egs_unit",
      entityId: req.params.id,
      // The credential is never included — only the durable operation
      // identity and ZATCA's own (non-secret) disposition text.
      afterValue: { providerOperationId: operation.id, requestId: operation.providerRequestId, dispositionMessage: operation.dispositionMessage },
    });

    // Wire response deliberately never includes secretRef or a database
    // operation id — same established precedent as compliance-csid/
    // compliance-invoices.
    res.status(201).json({ requestId: result.requestId, dispositionMessage: result.dispositionMessage });
  } catch (err) {
    if (err instanceof EgsUnitNotFoundError) return res.status(404).json({ error: "وحدة الفوترة الإلكترونية غير موجودة" });
    if (err instanceof ZatcaError) {
      return res.status(httpStatusForZatcaError(err)).json({ error: err.message, category: err.category });
    }
    throw err;
  }
});

const renewProductionCsidSchema = z.object({
  // The renewal CSR — this route does not generate, sign, or store one;
  // the caller supplies the exact same values ZATCA's Production CSID
  // Renewal endpoint expects (see domain/productionCsid.ts's file comment
  // for why this stays opaque to MIDAD's own CSR Instance chain).
  csrBase64: z.string().min(1),
  otp: z.string().min(1),
});

// POST /api/zatca/egs-units/:id/production-csid/renew (Slice W) — calls
// ZATCA's Production CSID Renewal endpoint and persists the result as one
// historical provider-operation row. Never claims "renewal complete" —
// both the verified "issued" and "not_compliant" outcomes are recorded as
// real received responses and returned to the caller verbatim (ZATCA's
// own vocabulary, not a MIDAD interpretation of it).
zatcaRouter.post(
  "/egs-units/:id/production-csid/renew",
  requireSubmit,
  async (req: Request<{ id: string }>, res: Response) => {
    const parsed = renewProductionCsidSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0].message });

    try {
      const { operation, result } = await renewProductionCsidForEgsUnit({
        companyId: req.companyId!,
        egsUnitId: req.params.id,
        csrBase64: parsed.data.csrBase64,
        otp: parsed.data.otp,
      });

      await recordAuditEvent(db, {
        companyId: req.companyId!,
        actorUserId: req.userId!,
        action: "zatca.productionCsid.renewalRequested",
        entityType: "zatca_egs_unit",
        entityId: req.params.id,
        afterValue: {
          providerOperationId: operation.id,
          requestId: operation.providerRequestId,
          dispositionMessage: operation.dispositionMessage,
          outcome: operation.providerOutcome,
        },
      });

      res.status(201).json({ requestId: result.requestId, dispositionMessage: result.dispositionMessage, outcome: result.outcome });
    } catch (err) {
      if (err instanceof EgsUnitNotFoundError) return res.status(404).json({ error: "وحدة الفوترة الإلكترونية غير موجودة" });
      if (err instanceof ZatcaError) {
        return res.status(httpStatusForZatcaError(err)).json({ error: err.message, category: err.category });
      }
      throw err;
    }
  },
);

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

// Submission states meaning "already in flight, already has a real ZATCA
// outcome, or ZATCA already made a final business decision on this exact
// document" — /submit is idempotent and refuses to re-attempt any of
// these, so a duplicate click (or a genuinely concurrent request — see the
// atomic claim below) can never create a second real submission. "rejected"
// joins this set in Slice AB: a NOT_CLEARED/NOT_REPORTED outcome is a
// deterministic business rejection of this exact document (same UUID/ICV/
// hash every retry would produce), and this codebase's own retry-policy
// rule is never to blindly retry one of those — see errors.ts's
// ZatcaValidationError comment. "compliance_failed" and "retry_required"
// deliberately stay OUT of this set: both remain legitimately resubmittable
// (a configuration fix, a transient network/provider failure that clears
// up), exactly as this route's existing retry behavior already worked
// before this slice.
const SUBMISSION_TERMINAL_OR_INFLIGHT_STATES: (typeof zatcaSubmissionStateEnum.enumValues)[number][] = [
  "submitting",
  "submitted",
  "cleared",
  "reported",
  "rejected",
  "compliance_pending",
];

// POST /api/zatca/submissions/:id/submit (Slice 4; real signer wired in
// Slice 5 continuation; real ZATCA provider call wired in Slice AB) — the
// real submission attempt, Simulation or Production depending on this
// EGS unit's own environment. Regenerates the exact same XML that was
// hashed at /prepare time (see documentBuilder.ts's issueTime comment) and
// refuses to proceed if it no longer matches the persisted documentHash
// (the underlying invoice or identity changed since prepare). Requires a
// real signature via lib/zatca/signer/ (XadesZatcaSigner) and a real local
// (offline) signature verification pass — task #49 — BEFORE any signed
// document is ever sent to ZATCA: this route never sends unsigned or
// locally-unverified XML to ZATCA. Only then does it call the real
// provider: clearInvoice for "standard" (B2B) documents, reportInvoice for
// "simplified" (B2C) — the routing rule already established by
// documentBuilder.ts's own subtype derivation, not invented here. The
// outcome (cleared/reported/rejected on a real response, retry_required/
// compliance_failed on a real error) is always persisted exactly as
// derived, never guessed, and this route's own response never claims more
// than the provider's response itself states — see Scope 24's own
// no-compliance-inference rule: "cleared"/"reported" here means exactly
// what ZATCA's own clearanceStatus/reportingStatus field said, nothing
// about ZATCA-wide compliance completion.
zatcaRouter.post("/submissions/:id/submit", requireSubmit, async (req: Request<{ id: string }>, res: Response) => {
  const submission = await getSubmission(req.companyId!, req.params.id);
  if (!submission) return res.status(404).json({ error: "غير موجود" });

  if (SUBMISSION_TERMINAL_OR_INFLIGHT_STATES.includes(submission.state)) {
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

  // Slice AB Scope F — the atomic claim: only THIS request's UPDATE, if it
  // actually matches a non-terminal/non-in-flight row, may proceed to sign
  // and call the real ZATCA provider. A genuinely concurrent second /submit
  // request for the same submission finds 0 rows here (the first request's
  // UPDATE already moved the state to "submitting" and committed), so it
  // can never also sign and call the provider — closing the exact
  // check-then-act race the old unconditional write above had. See
  // domain/submissions.ts's claimSubmissionForSubmit for why this is a
  // conditional UPDATE, never a SELECT-then-UPDATE.
  const claimed = await claimSubmissionForSubmit(req.companyId!, submission.id, SUBMISSION_TERMINAL_OR_INFLIGHT_STATES);
  if (!claimed) {
    const current = await getSubmission(req.companyId!, submission.id);
    return res.json({ submission: current ?? submission, alreadyAttempted: true });
  }

  try {
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

    // Local verification passed — real signing, real ZATCA provider call.
    // Slice AB — the routing rule (standard/B2B -> clearance, simplified/
    // B2C -> reporting) is documentBuilder.ts's own established subtype
    // derivation, not decided here; this route only reads submission.subtype,
    // which was frozen at /prepare time from that same derivation.
    const provider = getZatcaProvider(unit.environment as "simulation" | "production");
    const submissionInput = { invoiceXmlBase64: Buffer.from(signResult.signedXml, "utf8").toString("base64"), invoiceHashBase64: documentHash, uuid: submission.zatcaUuid };
    const result =
      submission.subtype === "standard"
        ? await provider.clearInvoice(credential, submissionInput)
        : await provider.reportInvoice(credential, submissionInput);

    // Never claims more than ZATCA's own response says: result.status is
    // exactly "cleared" | "reported" | "rejected" here (clearInvoice/
    // reportInvoice never return "compliance_pending" — see
    // fatooraProvider.ts's normalizers), and this is a real ZATCA business
    // outcome, not a MIDAD interpretation of one — see Scope 24's own
    // no-compliance-inference rule referenced in this route's file comment.
    const responded = await recordSubmissionOutcome(req.companyId!, submission.id, {
      state: result.status,
      zatcaStatus: result.rawStatus ?? null,
      correlationId: result.correlationId ?? null,
      warnings: result.warnings ?? null,
      clearedDocumentXmlBase64: result.clearedInvoiceXmlBase64 ?? null,
      respondedAt: result.respondedAt,
    });
    await recordAuditEvent(db, {
      companyId: req.companyId!,
      actorUserId: req.userId!,
      action: "zatca.submission.responseReceived",
      entityType: "zatca_submission",
      entityId: submission.id,
      afterValue: { state: result.status, rawStatus: result.rawStatus ?? null, correlationId: result.correlationId ?? null },
    });
    logger.info("zatca_submission_response_received", { companyId: req.companyId, submissionId: submission.id, state: result.status });
    return res.json({ submission: responded, alreadyAttempted: false });
  } catch (err) {
    if (err instanceof ZatcaError) {
      // Slice AB — err.retryable (see errors.ts) decides the persisted
      // state: a transient failure (network/timeout/rate-limited/an
      // unreadable ZATCA response) lands on "retry_required" so the
      // existing retry affordance (this same route, called again) is the
      // correct next step; a non-retryable failure (bad credential, this
      // tenant's own configuration, a malformed request) lands on
      // "compliance_failed", unchanged from this route's prior behavior.
      const failed = await recordSubmissionOutcome(req.companyId!, submission.id, {
        state: err.retryable ? "retry_required" : "compliance_failed",
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
        afterValue: { category: err.category, message: err.message, retryable: err.retryable },
      });
      logger.warn("zatca_submission_failed", { companyId: req.companyId, submissionId: submission.id, category: err.category });
      return res.status(httpStatusForZatcaError(err)).json({ error: err.message, category: err.category, submission: failed });
    }
    throw err;
  }
});
