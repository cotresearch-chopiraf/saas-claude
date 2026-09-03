// Compliance Invoice submission + Compliance Attempt persistence — Slice M.
//
// AUDIT FINDING (confirmed fresh at the start of this slice, matching
// every prior slice's own finding for requestComplianceCsid in Slice L):
// ZatcaProvider.submitComplianceDocument (provider/types.ts, implemented
// by FatooraProvider — VERIFIED contract, Slice B) was, before this
// slice, called from nowhere outside its own provider tests
// (server/tests/zatcaProvider.test.ts). There was no existing domain/
// controller flow to connect to — this file IS that flow, created now for
// the first time. The provider itself is UNCHANGED (see
// fatooraProvider.ts/fatooraClient.ts/types.ts — none of the three were
// touched by this slice): it still only does HTTP + auth + request/
// response normalization, exactly as Slice B designed it.
//
// WHAT THIS MODULE DOES NOT DO: build, sign, or generate a compliance
// test document. ZatcaDocumentSubmissionInput (invoiceXmlBase64,
// invoiceHashBase64, uuid) is supplied by the caller verbatim — the same
// boundary Slice L already established for the CSR itself (csrBase64,
// never generated or stored by that slice's compliance-csid flow either).
// This keeps the whole module free of any dependency on real MIDAD
// invoices, documentBuilder.ts, or the XAdES signer — ZERO financial
// integration, exactly as this slice requires.
//
// DOCUMENT TYPE: see db/schema.ts's zatcaComplianceAttempts comment for
// why `documentType` reuses zatcaDocumentTypeEnum ("388"/"381"/"383")
// verbatim rather than inventing a new taxonomy.
//
// ATTEMPT PERSISTENCE — exactly when a row is and is not created (see
// this slice's own required audit/reasoning about "transactional
// integrity"):
//   - The provider was never invoked at all (a pre-flight check failed:
//     EGS unit not found, no CSR Instance yet, no Compliance Lifecycle
//     yet, or the Compliance secret does not resolve) -> NO attempt row.
//     Persisting one would claim a call happened when it did not — the
//     same discipline domain/complianceCsid.ts's Case C already follows.
//   - The provider call returns a real (non-throwing) ZatcaSubmissionResult
//     — including a genuine ZATCA-side "rejected" outcome, which
//     fatooraProvider.ts's normalizeComplianceInvoiceResponse already
//     returns rather than throws for exactly this reason -> ALWAYS
//     persist an attempt, with correlationId/rawStatus/normalizedOutcome
//     from that result and errorCategory/errorCode left null (no thrown
//     ZatcaError exists in this branch).
//   - The provider call itself throws a ZatcaError (network failure,
//     unrecognized response shape, transport/auth-layer rejection — see
//     provider/fatooraClient.ts) -> the call genuinely reached out (or
//     genuinely attempted to); this slice's own audit of "transactional
//     integrity" (spec §28: avoid claiming a call happened when the
//     provider was never invoked — not avoid recording one that WAS
//     invoked) means this IS recorded: an attempt with errorCategory from
//     the thrown error's own category, correlationId/rawStatus/
//     normalizedOutcome left null (no ZatcaSubmissionResult was ever
//     produced), and the error is then re-thrown unchanged so the
//     existing route-level ZatcaError -> HTTP-status mapping keeps
//     working exactly as it does for every other route in this file.
//   - A non-ZatcaError exception (an unexpected bug, not a ZATCA-related
//     failure) propagates with no attempt persisted — the existing
//     provider/domain error semantics in every other module in this
//     codebase never specially record those either.
//
// COMPLIANCE SEMANTICS, restated: nothing in this module updates
// zatca_compliance_lifecycles.status, zatca_egs_units.csidStatus, or
// implies any compliance-completion/production-eligibility fact. A
// Compliance Attempt records only the outcome of one individual call.

import { getEgsUnit, EgsUnitNotFoundError } from "./egsUnits.js";
import { findCurrentCsrInstance } from "./csrInstances.js";
import { getComplianceLifecycleForCsrInstance } from "./complianceLifecycles.js";
import { createComplianceAttempt, type InvoiceFamily } from "./complianceAttempts.js";
import { getZatcaSecretStore } from "../secretStore/index.js";
import { getZatcaProvider } from "../provider/index.js";
import { ZatcaConfigurationError, ZatcaError, ZatcaValidationError } from "../errors.js";
import type { ZatcaSubmissionResult } from "../provider/types.js";
import type { zatcaDocumentTypeEnum } from "../../../db/schema.js";

export interface SubmitComplianceInvoiceInput {
  companyId: string;
  egsUnitId: string;
  documentType: (typeof zatcaDocumentTypeEnum.enumValues)[number];
  // Which ZATCA compliance-test family this attempt targets — caller-
  // declared intent, validated below against the resolved CSR Instance's
  // Functionality Map before any provider call is made. See
  // domain/complianceAttempts.ts's InvoiceFamily comment and this file's
  // validateInvoiceFamilyAgainstCsr for the full reasoning; never derived
  // from documentType, the CSR, or anything else.
  invoiceFamily: InvoiceFamily;
  invoiceXmlBase64: string;
  invoiceHashBase64: string;
  uuid: string;
}

// Slice Q-Implementation — MIDAD-SIDE INTEGRITY RULE, NOT A ZATCA API
// CONTRACT. No verified ZATCA source states that the Compliance Invoice
// endpoint itself validates a request's family against the submitting
// CSR's Functionality Map (provider/types.ts's ZatcaDocumentSubmissionInput
// carries no CSR linkage at all). This check exists solely so MIDAD
// refuses, before ever contacting ZATCA, a request whose declared family
// the caller's own CSR could not have produced — derived from the Slice
// P/Q-verified meaning of the Functionality Map (T=Standard, S=Simplified,
// digits 1/2 of "TSXY"), never from an inferred test count or any other
// unverified rule.
//
// "0000" is deliberately rejected for EITHER family rather than silently
// allowed: its validity is itself UNVERIFIED (Slice O/P) — there is no
// evidence-backed basis to permit a compliance-test family against a
// Functionality Map value nothing confirms is even a valid CSR input.
function validateInvoiceFamilyAgainstCsr(csrInvoiceType: string, invoiceFamily: InvoiceFamily): void {
  const t = csrInvoiceType[0];
  const s = csrInvoiceType[1];
  if (csrInvoiceType === "0000" || t === undefined || s === undefined) {
    throw new ZatcaValidationError(
      `لا يمكن التحقق من توافق نوع الفاتورة (${invoiceFamily}) مع خريطة وظائف CSR غير المعروفة/غير المدعومة "${csrInvoiceType}" — ` +
        "هذه القيمة غير موثّقة",
    );
  }
  if (invoiceFamily === "standard" && t !== "1") {
    throw new ZatcaValidationError(
      `طلب CSR هذا (invoiceType="${csrInvoiceType}") لا يدعم الفواتير القياسية (Standard) — لا يمكن إرسال فاتورة اختبار امتثال قياسية له`,
    );
  }
  if (invoiceFamily === "simplified" && s !== "1") {
    throw new ZatcaValidationError(
      `طلب CSR هذا (invoiceType="${csrInvoiceType}") لا يدعم الفواتير المبسّطة (Simplified) — لا يمكن إرسال فاتورة اختبار امتثال مبسّطة له`,
    );
  }
}

export async function submitComplianceInvoiceForEgsUnit(
  input: SubmitComplianceInvoiceInput,
): Promise<{ attempt: Awaited<ReturnType<typeof createComplianceAttempt>>; result: ZatcaSubmissionResult }> {
  const unit = await getEgsUnit(input.companyId, input.egsUnitId);
  if (!unit) throw new EgsUnitNotFoundError(input.egsUnitId);

  if (!input.invoiceXmlBase64.trim() || !input.invoiceHashBase64.trim() || !input.uuid.trim()) {
    throw new ZatcaValidationError("مستند فاتورة الامتثال (XML) وتجزئته والمعرّف الفريد (uuid) مطلوبة جميعاً");
  }

  // Ownership chain, exactly as required: company -> EGS Unit ->
  // (current) CSR Instance -> Compliance Lifecycle. No client-supplied
  // lifecycle id is ever accepted (see this file's header comment) — it
  // is always resolved server-side through this tenant-scoped chain, the
  // same "never trust a bare id" contract every lookup in this domain
  // layer already follows.
  const csrInstance = await findCurrentCsrInstance(input.companyId, input.egsUnitId);
  if (!csrInstance) {
    throw new ZatcaConfigurationError("لم يتم إنشاء طلب CSR لهذه الوحدة بعد — يجب إنشاؤه أولاً");
  }
  const lifecycle = await getComplianceLifecycleForCsrInstance(input.companyId, csrInstance.id);
  if (!lifecycle) {
    throw new ZatcaConfigurationError(
      "لم يتم طلب شهادة الامتثال (Compliance CSID) لطلب CSR هذا بعد — يجب طلبها أولاً قبل إرسال فاتورة اختبار الامتثال",
    );
  }

  // MIDAD-side integrity check (never a claimed ZATCA rule — see this
  // function's own comment) — runs before any provider call or secret
  // resolution, so an incompatible request never reaches the network and
  // never creates an attempt row.
  validateInvoiceFamilyAgainstCsr(csrInstance.invoiceType, input.invoiceFamily);

  const secret = await getZatcaSecretStore().resolve(input.companyId, lifecycle.secretRef);
  if (!secret?.binarySecurityToken || !secret.secret) {
    throw new ZatcaConfigurationError("تعذّر استرجاع بيانات اعتماد شهادة الامتثال المخزّنة — أعيدي طلب شهادة الامتثال");
  }

  const provider = getZatcaProvider(unit.environment);
  const attemptedAt = new Date();
  let result: ZatcaSubmissionResult | undefined;
  let thrown: ZatcaError | undefined;
  try {
    result = await provider.submitComplianceDocument(
      { binarySecurityToken: secret.binarySecurityToken, secret: secret.secret },
      { invoiceXmlBase64: input.invoiceXmlBase64, invoiceHashBase64: input.invoiceHashBase64, uuid: input.uuid },
    );
  } catch (err) {
    if (err instanceof ZatcaError) {
      thrown = err;
    } else {
      throw err;
    }
  }

  const attempt = await createComplianceAttempt(input.companyId, {
    complianceLifecycleId: lifecycle.id,
    documentType: input.documentType,
    invoiceFamily: input.invoiceFamily,
    correlationId: result?.correlationId ?? null,
    rawStatus: result?.rawStatus ?? null,
    normalizedOutcome: result?.status ?? null,
    attemptedAt,
    errorCategory: thrown?.category ?? null,
    errorCode: null,
  });

  if (thrown) throw thrown;
  return { attempt, result: result! };
}
