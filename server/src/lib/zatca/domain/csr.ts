// CSR generation + CSID confirmation — Slice 5 continuation, task #51.
//
// SCOPE, STATED HONESTLY: this module implements the two halves of CSID
// onboarding that MIDAD can actually perform and verify by itself:
//   1. generateCsrForEgsUnit — a real ECDSA key pair + real signed PKCS#10
//      CSR (csr/keyPair.ts, csr/csrBuilder.ts), with the private key
//      immediately stashed in ZatcaSecretStore (never returned, never
//      logged) pending CSID confirmation.
//   2. confirmCsidForEgsUnit — accepts a certificate + secret the tenant
//      obtained from ZATCA (by whatever channel actually worked for
//      them — this environment cannot make that network call itself, see
//      below), verifies the certificate's public key actually matches the
//      key pair generated in step 1 (never accepts a mismatched
//      cert/key pair silently), and only then stores it as the EGS
//      unit's active credential.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO: submit the CSR to ZATCA over
// the network. The FATOORA endpoints for this (per the user-supplied
// baseline: .../core/compliance for the Compliance CSID exchange,
// .../core/production/csids for the Production CSID exchange) have no
// verified request/response JSON contract — only their URLs were
// supplied, and inventing header/body/response-shape details would be
// exactly the kind of guess the task instruction forbids (see
// docs/zatca/SLICE5_OFFICIAL_SPEC_VERIFICATION.md). Wiring a real
// ZatcaProvider method for this remains SPEC_TEXT_REQUIRED. Until then,
// confirmCsidForEgsUnit exists so a tenant who obtained a real credential
// through some other verified channel (their own FATOORA portal access,
// a separately-verified integration) can still get MIDAD's local state
// (csidStatus, certificateExpiresAt, the stored credential) to reflect
// reality — never fabricated, always derived from the real certificate
// they provide.
//
// OTP: accepted as a required, transient function parameter — proven
// non-empty, then discarded. Never persisted to any column, never logged,
// never included in any error message or audit event. MIDAD cannot
// validate an OTP against ZATCA itself (no network access to the FATOORA
// portal's OTP verification), so this is a presence check only, not
// cryptographic proof the OTP is genuine — the real proof-of-possession
// happens implicitly when (if) the tenant's own CSR submission to ZATCA
// (using this generated CSR, however they perform it) succeeds.
//
// ZATCA NETWORK INTEGRATION CONTINUATION — two additional safeguards, both
// genuinely implementable and testable without any unverified network
// contract, per docs/zatca/ZATCA_NETWORK_INTEGRATION_SPEC.md:
//   - State-machine ordering: confirmCsidForEgsUnit refuses "CSR ->
//     Production CSID" as a shortcut — production requires this EGS
//     unit's csidStatus to already be compliance_issued. Also refuses a
//     redundant second confirmation at either stage. This mirrors the
//     official onboarding sequence's own requirement, not an invented
//     MIDAD rule.
//   - VAT Registration Number consistency: generateCsrForEgsUnit requires
//     the CSR's organizationIdentifier to exactly match the company's
//     currently-registered VAT number (getZatcaTenantIdentity). Since
//     every invoice MIDAD ever builds for this company draws from that
//     same identity, this one check at CSR-generation time is sufficient
//     to guarantee CSR/invoice/QR VAT consistency for everything
//     downstream.

import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { db } from "../../../db/client.js";
import { getEgsUnit, updateEgsUnitCsidStatus, setEgsUnitSecretRef, EgsUnitNotFoundError } from "./egsUnits.js";
import {
  createCsrInstance,
  findCurrentCsrInstance,
  findCsrInstanceBySecretRef,
  markCsrInstanceSuperseded,
} from "./csrInstances.js";
import { getZatcaTenantIdentity } from "./config.js";
import { getZatcaSecretStore } from "../secretStore/index.js";
import { generateEcdsaKeyPair } from "../csr/keyPair.js";
import { buildZatcaCsr, type ZatcaCsrFields, type ZatcaCsrCustomAttributeOids } from "../csr/csrBuilder.js";
import { ZatcaConfigurationError, ZatcaValidationError } from "../errors.js";
import type { zatcaCsidStatusEnum } from "../../../db/schema.js";

export interface GenerateCsrInput {
  companyId: string;
  egsUnitId: string;
  otp: string;
  fields: ZatcaCsrFields;
  customAttributeOids: Partial<ZatcaCsrCustomAttributeOids>;
}

export interface GenerateCsrResult {
  csrPem: string;
  csrDerBase64: string;
  // Slice J — the durable zatca_csr_instances row id for this generation
  // event. Purely additive to this internal result type: routes/zatca.ts
  // reads it only to enrich its existing audit event, and builds the
  // actual HTTP response from csrPem/csrDerBase64 alone — the API
  // contract this function's callers see over the wire is unchanged.
  csrInstanceId: string;
}

export async function generateCsrForEgsUnit(input: GenerateCsrInput): Promise<GenerateCsrResult> {
  const unit = await getEgsUnit(input.companyId, input.egsUnitId);
  if (!unit) throw new EgsUnitNotFoundError(input.egsUnitId);

  if (!input.otp || !input.otp.trim()) {
    throw new ZatcaValidationError("رمز التحقق (OTP) مطلوب لبدء إصدار الشهادة — احصلي عليه من بوابة فاتورة أولاً");
  }
  // The OTP is never referenced again below — this function does not
  // store it, log it, or pass it to anything. Its only remaining purpose
  // in this scope is the presence check above.

  // VAT Registration Number consistency (ZATCA Network Integration
  // continuation) — the official Developer Portal manual (per the
  // user-supplied baseline; unverified against the primary PDF, which
  // remains EGRESS_BLOCKED — see docs/zatca/ZATCA_NETWORK_INTEGRATION_SPEC.md)
  // states the VAT number used for CSID issuance must match the VAT
  // number used in every subsequent invoice/QR call. MIDAD has one VAT
  // number per company (not per EGS unit), and every invoice already
  // draws from that same company identity (documentBuilder.ts), so
  // enforcing the match here — at CSR generation time — is sufficient to
  // guarantee it for everything downstream, without inventing any new
  // per-EGS-unit VAT concept the schema doesn't have.
  const identity = await getZatcaTenantIdentity(input.companyId);
  if (!identity.vatNumber) {
    throw new ZatcaConfigurationError(
      "لم يتم تسجيل الرقم الضريبي (VAT) لهذه الشركة بعد — أكملي بيانات الهوية الضريبية قبل إنشاء طلب CSR",
    );
  }
  if (input.fields.organizationIdentifier !== identity.vatNumber) {
    throw new ZatcaValidationError(
      "الرقم الضريبي في حقل CSR (organizationIdentifier) لا يطابق الرقم الضريبي المسجّل لهذه الشركة — يجب أن يتطابقا " +
        "تماماً، لأن نفس الرقم يُستخدم لاحقاً في كل فاتورة ورمز QR لهذه الوحدة",
    );
  }

  const keys = await generateEcdsaKeyPair();
  const { csrPem, csrDerBase64 } = await buildZatcaCsr({
    fields: input.fields,
    keys,
    customAttributeOids: input.customAttributeOids,
  });

  const secretRef = await getZatcaSecretStore().put(input.companyId, input.egsUnitId, {
    binarySecurityToken: "",
    secret: "",
    privateKeyPem: keys.privateKeyPem,
    publicKeyPem: keys.publicKeyPem,
    curve: keys.curve,
  });

  // Slice J — deliberately NO LONGER deletes the previous secretRef here.
  // Before this slice, a regenerated CSR's key pair silently destroyed the
  // prior one's — this is exactly the eager-deletion behavior the CSR
  // Instance history below exists to stop happening. ZatcaSecretStore
  // itself never required this (put() already returns a new, independent
  // reference every time — see its own file comment); the delete() call
  // was this function's own prior policy choice, now removed. The
  // now-superseded CSR Instance's secretRef (below) stays independently
  // resolvable indefinitely — cleanup of truly orphaned secrets, if ever
  // needed, is a separate future policy decision, not this slice's.

  // The DB writes below (the new CSR Instance row, marking any prior
  // instance superseded, and the two EGS-level projection updates) share
  // one transaction so they either all land or none do. ZatcaSecretStore's
  // put() above is NOT part of this transaction — it is a separate store,
  // not this database — so a transaction failure after put() succeeded
  // leaves one orphaned-but-harmless secret in the store (never referenced
  // by any row, never a correctness or security issue, just unclaimed
  // storage) rather than a torn write across two different systems. This
  // residual failure mode is accepted rather than building a distributed
  // transaction to avoid it.
  const csrInstance = await db.transaction(async (tx) => {
    const priorInstance = await findCurrentCsrInstance(input.companyId, input.egsUnitId, tx);

    const created = await createCsrInstance(
      input.companyId,
      { egsUnitId: input.egsUnitId, invoiceType: input.fields.invoiceType, secretRef },
      tx,
    );

    if (priorInstance) {
      await markCsrInstanceSuperseded(input.companyId, priorInstance.id, created.id, tx);
    }

    await setEgsUnitSecretRef(input.companyId, input.egsUnitId, secretRef, tx);
    await updateEgsUnitCsidStatus(input.companyId, input.egsUnitId, "compliance_pending", { dbOrTx: tx });

    return created;
  });

  return { csrPem, csrDerBase64, csrInstanceId: csrInstance.id };
}

export interface ConfirmCsidInput {
  companyId: string;
  egsUnitId: string;
  // Base64 DER or PEM — see signer/xadesZatcaSigner.ts's parseCertificate
  // for the same acceptance of either shape.
  binarySecurityToken: string;
  secret: string;
  stage: "compliance" | "production";
}

const CSID_STATUS_FOR_STAGE: Record<ConfirmCsidInput["stage"], (typeof zatcaCsidStatusEnum.enumValues)[number]> = {
  compliance: "compliance_issued",
  production: "production_issued",
};

export async function confirmCsidForEgsUnit(input: ConfirmCsidInput) {
  const unit = await getEgsUnit(input.companyId, input.egsUnitId);
  if (!unit) throw new EgsUnitNotFoundError(input.egsUnitId);

  // State-machine ordering (ZATCA Network Integration continuation) — per
  // the user-supplied baseline, Production CSID requires a prior,
  // completed Compliance CSID stage; "CSR -> Production CSID" is
  // explicitly not a valid shortcut. Every other starting state
  // (including a second "compliance" confirmation, or "production" from
  // "none"/"expired"/"revoked") is rejected the same way — this function
  // only ever advances the state machine forward by exactly one step.
  if (input.stage === "production" && unit.csidStatus !== "compliance_issued") {
    throw new ZatcaConfigurationError(
      `لا يمكن تأكيد شهادة الإنتاج (Production CSID) قبل إتمام مرحلة شهادة الامتثال (Compliance CSID) — الحالة ` +
        `الحالية لهذه الوحدة: "${unit.csidStatus}". يجب تأكيد Compliance CSID أولاً.`,
    );
  }
  if (input.stage === "compliance" && unit.csidStatus !== "compliance_pending") {
    throw new ZatcaConfigurationError(
      `لا يمكن تأكيد شهادة الامتثال (Compliance CSID) والحالة الحالية لهذه الوحدة هي "${unit.csidStatus}" — يجب ` +
        `إنشاء طلب CSR جديد أولاً (ينقل الحالة إلى compliance_pending).`,
    );
  }

  if (!unit.secretRef) {
    throw new ZatcaConfigurationError("لم يتم إنشاء طلب توقيع شهادة (CSR) لهذه الوحدة بعد — يجب إنشاؤه أولاً");
  }

  const pending = await getZatcaSecretStore().resolve(input.companyId, unit.secretRef);
  if (!pending?.privateKeyPem || !pending.publicKeyPem || !pending.curve) {
    throw new ZatcaConfigurationError(
      "لا يوجد مفتاح خاص محفوظ لهذه الوحدة بانتظار تأكيد الشهادة — أعيدي إنشاء طلب CSR",
    );
  }

  let cert: x509.X509Certificate;
  try {
    cert = new x509.X509Certificate(input.binarySecurityToken);
  } catch (err) {
    throw new ZatcaValidationError(
      `تعذّر قراءة الشهادة الممنوحة كملف X.509 صالح: ${err instanceof Error ? err.message : "خطأ في التحليل"}`,
    );
  }

  const certPublicKeySpkiDer = Buffer.from(cert.publicKey.rawData);
  const storedPublicKeyDer = pemToDer(pending.publicKeyPem);
  if (!certPublicKeySpkiDer.equals(storedPublicKeyDer)) {
    throw new ZatcaValidationError(
      "المفتاح العام في الشهادة الممنوحة لا يطابق زوج المفاتيح الذي تم إنشاؤه لطلب CSR هذا — لا يمكن قبول هذه الشهادة",
    );
  }

  const newSecretRef = await getZatcaSecretStore().put(input.companyId, input.egsUnitId, {
    binarySecurityToken: input.binarySecurityToken,
    secret: input.secret,
    privateKeyPem: pending.privateKeyPem,
    curve: pending.curve,
    // Carried forward (not dropped after the compliance stage): the
    // production-stage confirmation re-runs the same public-key match
    // check below, since the official onboarding flow exchanges the
    // existing Compliance CSID for a Production one rather than
    // generating a new key pair — the underlying key pair is expected to
    // stay the same across both stages. Only dropped once the state
    // machine reaches its terminal "production_issued" stage, where no
    // further confirmation can ever need it again.
    publicKeyPem: input.stage === "production" ? undefined : pending.publicKeyPem,
  });

  // Slice K — the old EGS-level secretRef (unit.secretRef) is only safe
  // to delete from ZatcaSecretStore if no zatca_csr_instances row
  // historically owns it. At compliance-stage confirmation, unit.secretRef
  // is exactly the secretRef generateCsrForEgsUnit wrote onto this EGS
  // unit's CSR Instance row (set once at generation time, never updated
  // afterward — see csrInstances.ts's file comment) — deleting it here
  // would leave that row's own secretRef field pointing at nothing,
  // exactly the historical-corruption bug this slice exists to close.
  // At production-stage confirmation, unit.secretRef is instead the
  // *compliance-stage* credential this same function's previous call
  // produced (via the put() above, on that earlier call) — no CSR
  // Instance row was ever updated to reference it (CSR Instance only ever
  // records the generation-time secretRef), so it has no historical owner
  // and remains safe to delete, exactly as before. This is a deliberate,
  // narrow ownership check — not a blanket "never delete" — so a secret
  // with no historical owner is still cleaned up rather than accumulating
  // forever.
  const historicalOwner = await findCsrInstanceBySecretRef(input.companyId, unit.secretRef);
  if (!historicalOwner) {
    await getZatcaSecretStore().delete(input.companyId, unit.secretRef);
  }
  await setEgsUnitSecretRef(input.companyId, input.egsUnitId, newSecretRef);

  const updated = await updateEgsUnitCsidStatus(input.companyId, input.egsUnitId, CSID_STATUS_FOR_STAGE[input.stage], {
    certificateExpiresAt: cert.notAfter,
  });
  return updated;
}

function pemToDer(pem: string): Buffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  return Buffer.from(body, "base64");
}
