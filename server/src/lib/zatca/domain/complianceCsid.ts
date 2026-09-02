// Compliance CSID request + Compliance Lifecycle persistence — Slice L.
//
// AUDIT FINDING (confirmed fresh at the start of this slice, matching
// every prior slice's own finding): ZatcaProvider.requestComplianceCsid
// (provider/types.ts, implemented by FatooraProvider — VERIFIED contract,
// Slice A) was, before this slice, called from nowhere outside its own
// provider tests (server/tests/zatcaProvider.test.ts). There was no
// "existing domain/controller flow that consumes its result" to connect
// to — this file IS that flow, created now for the first time. The
// provider itself is UNCHANGED (see fatooraProvider.ts/fatooraClient.ts/
// types.ts — none of the three were touched by this slice): it still only
// does HTTP + auth + request/response normalization, exactly as Slice A
// designed it. Everything below (lifecycle creation, secret storage,
// database persistence) is domain-layer, per this slice's own required
// separation.
//
// SCOPE BOUNDARY, STATED HONESTLY: this module does not touch
// zatca_egs_units.csidStatus or zatca_egs_units.secretRef at all — the
// existing CSID state machine (domain/csr.ts's confirmCsidForEgsUnit,
// which advances csidStatus from a client-supplied certificate obtained
// through whatever channel actually worked for the tenant) is entirely
// unmodified and untouched by this slice. requestComplianceCsidForEgsUnit
// below is a SEPARATE, additive path: it calls ZATCA directly to obtain a
// real Compliance CSID and records that fact as a durable, independent
// Compliance Lifecycle row — but deliberately does NOT feed that
// credential into the EGS unit's active-credential slot or advance
// csidStatus. Wiring the two together (e.g. treating a successful call
// here as equivalent to confirmCsidForEgsUnit's "compliance" stage) is
// exactly the kind of "aggregate state introduced solely because the
// lifecycle table exists" this slice is explicitly forbidden from doing
// (see the Slice L spec's §23) — that remains a future, separately-scoped
// architectural decision, not one this slice makes implicitly.
//
// IMPORTANT ARCHITECTURAL PRINCIPLE, restated: a Compliance Lifecycle row
// existing (status "issued") means ONLY that ZATCA issued a Compliance
// CSID for this CSR in response to this one request. It is NOT, and must
// never be read as, "all required Compliance Steps passed" or "this CSR
// Instance is production-eligible" — no verified ZATCA source available to
// this project establishes that equivalence (see docs/zatca — Slices D
// through I). Compliance Attempts (real submitComplianceDocument calls)
// and Compliance Steps (aggregate completion tracking) remain unimplemented
// and out of scope.

import { getEgsUnit, EgsUnitNotFoundError } from "./egsUnits.js";
import { findCurrentCsrInstance } from "./csrInstances.js";
import { createComplianceLifecycle, getComplianceLifecycleForCsrInstance } from "./complianceLifecycles.js";
import { getZatcaSecretStore } from "../secretStore/index.js";
import { getZatcaProvider } from "../provider/index.js";
import { ZatcaConfigurationError, ZatcaDuplicateError, ZatcaValidationError } from "../errors.js";

export interface RequestComplianceCsidInput {
  companyId: string;
  egsUnitId: string;
  otp: string;
  // The CSR (base64 DER) previously returned by generateCsrForEgsUnit
  // (POST /egs-units/:id/csr) — this module does not generate a CSR and
  // does not persist one; the tenant/operator supplies the exact same
  // value they already received from that earlier call, matching how
  // MIDAD's CSR/CSID onboarding has worked since Slice 5 continuation (the
  // CSR itself is never stored anywhere — see domain/csr.ts).
  csrBase64: string;
}

// Postgres unique-violation (23505) on
// zatca_compliance_lifecycles_csr_instance_unique specifically — same
// pattern as routes/zatca.ts's isDuplicateSubmissionRaceError, closing the
// TOCTOU gap between this function's own pre-check
// (getComplianceLifecycleForCsrInstance) and the actual insert.
function isDuplicateComplianceLifecycleRaceError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; constraint?: unknown };
  return e.code === "23505" && e.constraint === "zatca_compliance_lifecycles_csr_instance_unique";
}

// Requests a real Compliance CSID from ZATCA for this EGS unit's current
// CSR Instance and persists the result as a Compliance Lifecycle row.
//
// PARTIAL FAILURE — reasoned about explicitly, per the Slice L spec:
//   Case A (ZATCA returns credentials; ZatcaSecretStore.put succeeds; the
//     DB insert fails, including the race case above): the secretRef
//     ZatcaSecretStore now holds is orphaned (never referenced by any
//     row). This is the same residual risk domain/csr.ts's
//     generateCsrForEgsUnit already documents and accepts for the same
//     reason: ZatcaSecretStore is a separate store, not this database, so
//     no single transaction can span both without inventing a distributed
//     transaction this slice is explicitly told not to build. The orphan
//     is unclaimed storage, never a correctness or security issue (it is
//     never resolvable by any company/secretRef pair any row exposes).
//   Case B (DB insert succeeds; a later step fails): there is no later
//     step in this function — createComplianceLifecycle's return is the
//     last thing this function does, so Case B does not arise here.
//   Case C (ZATCA returns a non-success response): requestComplianceCsid
//     throws a ZatcaError (see provider/fatooraClient.ts) before this
//     function ever calls ZatcaSecretStore.put or createComplianceLifecycle
//     — no row is created, no secret is stored, and the error propagates
//     to the caller unchanged. No false "issued" state is ever persisted.
export async function requestComplianceCsidForEgsUnit(input: RequestComplianceCsidInput) {
  const unit = await getEgsUnit(input.companyId, input.egsUnitId);
  if (!unit) throw new EgsUnitNotFoundError(input.egsUnitId);

  if (!input.otp || !input.otp.trim()) {
    throw new ZatcaValidationError("رمز التحقق (OTP) مطلوب لطلب شهادة الامتثال (Compliance CSID)");
  }
  if (!input.csrBase64 || !input.csrBase64.trim()) {
    throw new ZatcaValidationError("طلب توقيع الشهادة (CSR) مطلوب لطلب شهادة الامتثال — أنشئي طلب CSR أولاً");
  }

  // The CSR Instance this Compliance Lifecycle will belong to — the
  // EGS unit's most recent, not-yet-superseded CSR generation. Tenant
  // ownership is implicit: findCurrentCsrInstance is scoped by companyId,
  // the same "never trust a bare id" contract every other lookup in this
  // domain layer follows (see csrInstances.ts's file comment).
  const csrInstance = await findCurrentCsrInstance(input.companyId, input.egsUnitId);
  if (!csrInstance) {
    throw new ZatcaConfigurationError("لم يتم إنشاء طلب CSR لهذه الوحدة بعد — يجب إنشاؤه أولاً قبل طلب شهادة الامتثال");
  }

  // One Compliance Lifecycle per CSR Instance (approved 1:0..1
  // cardinality, also enforced by the database's own unique index) — this
  // pre-check gives a clear, cheap rejection before spending a real
  // network round trip on a request that would fail anyway; the race
  // catch below closes the gap if two requests for the same CSR Instance
  // are genuinely concurrent.
  const existing = await getComplianceLifecycleForCsrInstance(input.companyId, csrInstance.id);
  if (existing) {
    throw new ZatcaDuplicateError("تم طلب شهادة الامتثال (Compliance CSID) لطلب CSR هذا مسبقاً — لا يمكن تكرار الطلب لنفس الـ CSR");
  }

  const provider = getZatcaProvider(unit.environment);
  // Throws (never returns a "failed" result) on any non-success FATOORA
  // response — see provider/fatooraClient.ts's fatooraRequestComplianceCsid
  // and provider/fatooraProvider.ts's own comment. Nothing below this line
  // runs unless ZATCA genuinely issued a Compliance CSID.
  const result = await provider.requestComplianceCsid(input.csrBase64, input.otp);

  // The Compliance CSID's own credential — a completely independent
  // secret from the CSR Instance's own secretRef (which holds the CSR's
  // ECDSA key pair). No privateKeyPem/publicKeyPem/curve here: unlike
  // domain/csr.ts's confirmCsidForEgsUnit, this function does not carry
  // the CSR's key pair forward into this secret and does not wire this
  // credential into the EGS unit's active-credential slot or csidStatus
  // (see this file's header comment for why) — it exists solely so this
  // Compliance Lifecycle row has an opaque reference to the real
  // credential ZATCA issued, never the credential material itself.
  const secretRef = await getZatcaSecretStore().put(input.companyId, input.egsUnitId, {
    binarySecurityToken: result.binarySecurityToken,
    secret: result.secret,
  });

  try {
    return await createComplianceLifecycle(input.companyId, {
      csrInstanceId: csrInstance.id,
      requestId: result.requestId,
      dispositionMessage: result.dispositionMessage,
      secretRef,
    });
  } catch (err) {
    if (isDuplicateComplianceLifecycleRaceError(err)) {
      throw new ZatcaDuplicateError(
        "تم طلب شهادة الامتثال (Compliance CSID) لطلب CSR هذا مسبقاً — لا يمكن تكرار الطلب لنفس الـ CSR",
      );
    }
    throw err;
  }
}
