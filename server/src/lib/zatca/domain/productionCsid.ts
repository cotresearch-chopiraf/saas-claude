// Production CSID Onboarding + Renewal — provider-operation instrumentation
// only, Slice W.
//
// SCOPE BOUNDARY, STATED HONESTLY — this file is the direct continuation
// of the R→V audit chain's own conclusion (Slice V §5/§17): it implements
// ONLY the "safe subset" of a future compliance architecture — an
// INTERNAL HISTORICAL EXECUTION LAYER recording that MIDAD made one
// specific, operator-triggered provider call and what came back. It does
// NOT implement, infer, or approximate:
//   - a compliance-step / test-count model (zatca_compliance_steps remains
//     unimplemented, deliberately — see Slice N/V);
//   - any "compliance completed" / "onboarding completed" / "renewal
//     completed" state (none of these are defined by any verified ZATCA
//     source — Slice R/T);
//   - an automatic transition from a Compliance Attempt's outcome to a
//     Production CSID request (that would itself be a compliance-
//     completion decision this codebase has no evidence to make) — both
//     functions below are only ever invoked by an explicit, operator-
//     triggered API call, exactly like every other provider-facing route
//     in this file (compliance-csid, compliance-invoices), never by any
//     automatic trigger reacting to another operation's result.
//
// AUDIT FINDING (confirmed fresh at the start of this slice, matching
// every prior slice's own finding pattern): both
// ZatcaProvider.requestProductionCsidOnboarding and .renewProductionCsid
// (provider/types.ts, VERIFIED contracts, Slice C) were, before this
// slice, called from nowhere outside their own provider tests. This file
// is that flow, created now for the first time. The provider itself is
// UNCHANGED — neither method's signature nor fatooraClient.ts/
// fatooraProvider.ts were touched by this slice.
//
// PROVIDER OUTCOME VS INTERNAL STATUS — kept deliberately distinct
// columns (see db/schema.ts's zatcaProviderOperations comment):
// `providerOutcome` stores ZATCA's own verified vocabulary verbatim
// (Renewal's "issued"/"not_compliant" discriminant) when the operation
// type has one; `internalStatus` stores only MIDAD's own technical fact
// about whether the call concluded with a real response
// ("response_received", which covers BOTH "issued" and "not_compliant" —
// ZATCA responded either way, it just declined in the second case) or
// with a thrown transport/protocol failure ("failed"). Never conflate
// the two: "not_compliant" is never stored as internalStatus "failed".

import { getEgsUnit, EgsUnitNotFoundError } from "./egsUnits.js";
import { findCurrentCsrInstance } from "./csrInstances.js";
import { getComplianceLifecycleForCsrInstance } from "./complianceLifecycles.js";
import { createProviderOperation } from "./providerOperations.js";
import { getZatcaSecretStore } from "../secretStore/index.js";
import { getZatcaProvider } from "../provider/index.js";
import { ZatcaConfigurationError, ZatcaError, ZatcaValidationError } from "../errors.js";
import type { ZatcaProductionCsidOnboardingResult, ZatcaProductionCsidRenewalResult } from "../provider/types.js";

export interface RequestProductionCsidOnboardingInput {
  companyId: string;
  egsUnitId: string;
}

// Requests a real Production CSID from ZATCA for this EGS unit's current
// CSR Instance's Compliance CSID (per the verified onboarding contract —
// "Uses the Compliance CSID's own credential" — provider/types.ts) and
// records the result as one historical provider-operation row. Does NOT
// touch zatca_egs_units.csidStatus, does NOT mark anything "onboarding
// complete" — see this file's header comment.
export async function requestProductionCsidOnboardingForEgsUnit(
  input: RequestProductionCsidOnboardingInput,
): Promise<{ operation: Awaited<ReturnType<typeof createProviderOperation>>; result: ZatcaProductionCsidOnboardingResult }> {
  const unit = await getEgsUnit(input.companyId, input.egsUnitId);
  if (!unit) throw new EgsUnitNotFoundError(input.egsUnitId);

  const csrInstance = await findCurrentCsrInstance(input.companyId, input.egsUnitId);
  if (!csrInstance) {
    throw new ZatcaConfigurationError("لم يتم إنشاء طلب CSR لهذه الوحدة بعد — يجب إنشاؤه أولاً");
  }
  const lifecycle = await getComplianceLifecycleForCsrInstance(input.companyId, csrInstance.id);
  if (!lifecycle) {
    throw new ZatcaConfigurationError(
      "لم يتم طلب شهادة الامتثال (Compliance CSID) لطلب CSR هذا بعد — يجب طلبها أولاً قبل طلب شهادة الإنتاج",
    );
  }

  const secret = await getZatcaSecretStore().resolve(input.companyId, lifecycle.secretRef);
  if (!secret?.binarySecurityToken || !secret.secret) {
    throw new ZatcaConfigurationError("تعذّر استرجاع بيانات اعتماد شهادة الامتثال المخزّنة — أعيدي طلب شهادة الامتثال");
  }

  const provider = getZatcaProvider(unit.environment);
  const startedAt = new Date();
  let result: ZatcaProductionCsidOnboardingResult | undefined;
  let thrown: ZatcaError | undefined;
  try {
    result = await provider.requestProductionCsidOnboarding(
      { binarySecurityToken: secret.binarySecurityToken, secret: secret.secret },
      lifecycle.requestId,
    );
  } catch (err) {
    if (err instanceof ZatcaError) {
      thrown = err;
    } else {
      throw err;
    }
  }

  // A fresh, independent secret for the Production CSID credential itself
  // — never conflated with the Compliance Lifecycle's own secretRef used
  // above, and never overwriting it (same discipline as
  // domain/complianceCsid.ts's requestComplianceCsidForEgsUnit).
  const secretRef = result ? await getZatcaSecretStore().put(input.companyId, input.egsUnitId, {
    binarySecurityToken: result.binarySecurityToken,
    secret: result.secret,
  }) : null;

  const operation = await createProviderOperation(input.companyId, {
    egsUnitId: input.egsUnitId,
    operationType: "production_csid_onboarding",
    internalStatus: thrown ? "failed" : "response_received",
    providerRequestId: result?.requestId ?? null,
    dispositionMessage: result?.dispositionMessage ?? null,
    providerOutcome: null, // this operation type has no verified outcome discriminant — see schema comment
    secretRef,
    errorCategory: thrown?.category ?? null,
    startedAt,
    finishedAt: new Date(),
  });

  if (thrown) throw thrown;
  return { operation, result: result! };
}

export interface RenewProductionCsidInput {
  companyId: string;
  egsUnitId: string;
  // The renewal CSR — caller-supplied, opaque to this function, exactly
  // like domain/complianceCsid.ts's csrBase64. This function does not
  // generate a CSR and does not tie it to any zatca_csr_instances row —
  // see this file's header comment for why inventing that relationship
  // is out of scope for pure provider-operation instrumentation.
  csrBase64: string;
  otp: string;
}

// Calls ZATCA's Production CSID Renewal endpoint and records the result
// as one historical provider-operation row. Never claims "renewal
// complete" — both the verified "issued" and "not_compliant" outcomes are
// recorded as real, received responses (internalStatus:
// "response_received"), and the outcome itself is stored verbatim in
// providerOutcome, never interpreted further.
export async function renewProductionCsidForEgsUnit(
  input: RenewProductionCsidInput,
): Promise<{ operation: Awaited<ReturnType<typeof createProviderOperation>>; result: ZatcaProductionCsidRenewalResult }> {
  const unit = await getEgsUnit(input.companyId, input.egsUnitId);
  if (!unit) throw new EgsUnitNotFoundError(input.egsUnitId);

  if (!input.csrBase64.trim() || !input.otp.trim()) {
    throw new ZatcaValidationError("طلب CSR ورمز التحقق (OTP) مطلوبان لتجديد شهادة الإنتاج (Production CSID)");
  }

  const provider = getZatcaProvider(unit.environment);
  const startedAt = new Date();
  let result: ZatcaProductionCsidRenewalResult | undefined;
  let thrown: ZatcaError | undefined;
  try {
    result = await provider.renewProductionCsid(input.csrBase64, input.otp);
  } catch (err) {
    if (err instanceof ZatcaError) {
      thrown = err;
    } else {
      throw err;
    }
  }

  // Both verified outcomes ("issued" and "not_compliant") carry credential
  // material per the real Swagger example (renewal.pdf's own 428 schema) —
  // stored via ZatcaSecretStore either way, never dropped, and never
  // interpreted as proof of anything beyond "this is the credential
  // material ZATCA returned for this call".
  const secretRef = result ? await getZatcaSecretStore().put(input.companyId, input.egsUnitId, {
    binarySecurityToken: result.binarySecurityToken,
    secret: result.secret,
  }) : null;

  const operation = await createProviderOperation(input.companyId, {
    egsUnitId: input.egsUnitId,
    operationType: "production_csid_renewal",
    internalStatus: thrown ? "failed" : "response_received",
    providerRequestId: result?.requestId ?? null,
    dispositionMessage: result?.dispositionMessage ?? null,
    providerOutcome: result?.outcome ?? null,
    secretRef,
    errorCategory: thrown?.category ?? null,
    startedAt,
    finishedAt: new Date(),
  });

  if (thrown) throw thrown;
  return { operation, result: result! };
}
