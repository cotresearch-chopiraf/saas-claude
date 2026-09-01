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

import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { getEgsUnit, updateEgsUnitCsidStatus, setEgsUnitSecretRef, EgsUnitNotFoundError } from "./egsUnits.js";
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
  if (unit.secretRef) await getZatcaSecretStore().delete(input.companyId, unit.secretRef);
  await setEgsUnitSecretRef(input.companyId, input.egsUnitId, secretRef);
  await updateEgsUnitCsidStatus(input.companyId, input.egsUnitId, "compliance_pending");

  return { csrPem, csrDerBase64 };
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
  });
  await getZatcaSecretStore().delete(input.companyId, unit.secretRef);
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
