# ZATCA Architecture Boundary — Freeze (Slice Y)

This document is the durable, project-level record of the architectural
boundary established across Slices R through Y. It exists so that a future
developer (human or agent) can determine, without redoing the R–X evidence
audits, exactly what is safe to build on MIDAD's ZATCA/FATOORA integration
and what remains blocked pending real ZATCA evidence.

It supersedes nothing already in `docs/zatca/` (`SLICE5_DISCOVERY.md`,
`SLICE5_IMPLEMENTATION.md`, `SLICE5_OFFICIAL_SPEC_VERIFICATION.md`,
`SPECIFICATION-VERIFICATION.md`, `ZATCA_NETWORK_INTEGRATION_SPEC.md`), which
remain the record of what was verified at the time each was written. This
document is the current, consolidated statement of the boundary as of Slice
Y and should be updated (not replaced) if a future primary-evidence audit
changes it.

Every claim below is labeled:

- **VERIFIED** — read directly from a primary ZATCA source by this project.
- **DERIVED** — a logical inference from VERIFIED facts, never itself
  confirmed by a primary source. A DERIVED value must never be treated as
  fact.
- **UNVERIFIED** — no primary-source evidence exists either way.
- **BLOCKED** — this codebase deliberately does not implement the concept,
  regardless of how easy it would be to build, because no VERIFIED basis for
  it exists.

## 1. Current verified capabilities

The following are implemented and covered by tests:

- CSR generation with a 4-digit Functionality Map field (`invoiceType`),
  ECDSA key pair, and CSR building (`lib/zatca/csr/`, `domain/csr.ts`).
- Compliance CSID request/response persistence (`domain/complianceCsid.ts`,
  `zatca_compliance_lifecycles`).
- Compliance Attempt persistence — one row per individual Compliance
  Invoice call, scoped to a Compliance Lifecycle, with `invoiceFamily`
  validated against the CSR's Functionality Map before any provider call
  (`domain/complianceInvoice.ts`, `domain/complianceAttempts.ts`,
  `zatca_compliance_attempts`).
- Production CSID Onboarding and Renewal, each recorded as one historical
  `zatca_provider_operations` row per real call (`domain/productionCsid.ts`,
  `domain/providerOperations.ts`).
- Reporting and Clearance wire contracts (`lib/zatca/provider/`), XML
  building, hashing, QR tags 1–8, XAdES signing — unchanged by Slices R–Y,
  documented in the earlier `docs/zatca/` files above.

## 2. Current safe execution boundary

```text
SAFE:

CSR
 ↓
Compliance CSID
 ↓
Compliance Attempts
 ↓
Individual provider outcomes
 ↓
Production CSID provider operations
 ↓
Renewal provider operations
 ↓
Historical execution records (zatca_provider_operations,
zatca_compliance_attempts, zatca_compliance_lifecycles)
```

Everything in this layer records **what MIDAD technically did and what
ZATCA technically returned** — nothing more. No row, field, or status value
anywhere in this layer asserts a compliance judgment.

## 3. Blocked compliance-decision layer

```text
BLOCKED:

Authoritative Compliance Step model (zatca_compliance_steps or any
  synonymous table/model)
Required-test matrix
1100 official test count
Renewal test matrix
Compliance completion semantics
Onboarding completion semantics
Renewal completion semantics
ZATCA approval/compliance verdict engine
```

None of the above may be implemented until a future primary-evidence audit
explicitly unlocks it (see §26/Future Unlock Contract, below).

## 4. Functionality Map — verified meaning

| Value | Status | Meaning |
|---|---|---|
| `1000` | VERIFIED | Standard Tax Invoice, Standard Debit Note, Standard Credit Note (B2B) |
| `0100` | VERIFIED | Simplified Tax Invoice, Simplified Debit Note, Simplified Credit Note (B2C) |
| `1100` | VERIFIED (family compatibility only) | Permits both Standard and Simplified families |
| `1100` exact test list/count | **UNVERIFIED** | No primary ZATCA source enumerates it |

> `1100` supports both Standard and Simplified families, but its exact test
> matrix/count remains unverified.

**DERIVED, not fact:** `1100 = 6 tests` (from a naive `1000` + `0100`
union). This must never be encoded anywhere as if it were verified.

**Third-party, not authoritative:** Slice X's audit found non-ZATCA blogs
(2025–2026) claiming "12 compliance tests" with a specific named battery.
This is a Tier-3 secondary source per this project's own source hierarchy
and must never be encoded as a ZATCA requirement. Its only value is as
evidence that even secondary commentary disagrees on the number — which, if
anything, reinforces that Blocker A remains genuinely open, not that either
number (6 or 12) is safer to use than the other.

### Positions 3 and 4

MIDAD persists the CSR's 4-digit Functionality Map value verbatim and uses
only positions 1 and 2 (0-indexed: 0 and 1) for current invoice-family
compatibility checks (`domain/complianceInvoice.ts`'s
`validateInvoiceFamilyAgainstCsr`). Positions 3 and 4 are **not
interpreted** by any current validation logic — a non-zero value there is
never, on its own, a reason to reject a CSR or a compliance-invoice
submission. This behavior is approved and protected by
`server/tests/zatcaArchitectureGuardrails.test.ts`.

There remains an unresolved documentation discrepancy between two primary
sources over what the letters at those positions stand for (`TSXY` in the
Detailed Technical Guideline vs. `TSCZ` in the Developer Portal Manual and
the Security Features Implementation Standard, themselves disagreeing on
what `C`/`Z` mean — see Slice S). **This slice does not attempt to resolve
that discrepancy** and no code assigns semantics to either position.

## 5. Self-billing independence

- **VERIFIED** mechanism: `KSA-2 InvoiceTypeCode/@name` in the invoice XML
  (confirmed independently by both the XML Implementation Standard and the
  Data Dictionary — Slice S), structure `NNPNESB` where the final `B`
  encodes self-billing. This is entirely inside the invoice XML domain.
- CSR Functionality Map position 4 is a **completely separate, unrelated**
  field. It must never be read as a self-billing flag.
- Current code: `lib/zatca/xmlBuilder.ts`'s `SUBTYPE_NAME_ATTRIBUTE` sets
  the `InvoiceTypeCode` `name` attribute from `CanonicalZatcaDocument.subtype`
  (`"standard"` → `"0100000"`, `"simplified"` → `"0200000"`) only — it never
  reads any CSR or Functionality Map value, and `CanonicalZatcaDocument`
  carries no such field. Self-billing (the final digit of the 7-digit code)
  is not yet distinguished by this builder at all — a pre-existing scope
  limit, not a Slice Y change. Protected by
  `server/tests/zatcaArchitectureGuardrails.test.ts`.

## 6. Provider operation boundaries

- **Compliance CSID** and **Compliance Invoice**: wired since Slices L/M,
  unchanged since.
- **Production CSID Onboarding** and **Renewal**: wired in Slice W, each an
  explicit, operator-triggered API call. Neither is triggered automatically
  by any other operation's outcome.
- No code anywhere transitions automatically from a Compliance Attempt's
  result to a Production CSID request, and no code consumes an Onboarding
  or Renewal result to update `zatca_egs_units.csidStatus` or any other
  unit-level state.

## 7. Status semantics (frozen)

`zatca_provider_operations.internalStatus` has exactly two values:

| Value | Meaning |
|---|---|
| `response_received` | ZATCA returned a real response — covers Renewal's verified `issued` **and** `not_compliant` outcomes alike, since both are a real response |
| `failed` | The provider call itself failed technically (transport/protocol error, a thrown `ZatcaError`) before any valid response existed |

`providerOutcome` stores ZATCA's own verbatim vocabulary (`"issued"` /
`"not_compliant"` for Renewal; `null` for Onboarding, which has no verified
outcome discriminant) — never reinterpreted, never converted into a
boolean, never merged with `internalStatus`.

**This status set is frozen.** It is not to be expanded merely for
theoretical future use. If additional statuses are ever needed, they must
remain purely technical/internal (e.g. distinguishing further transport
failure modes), never compliance-layer semantics.

### Forbidden as compliance-layer statuses

```text
compliant
approved
passed
compliance_completed
onboarding_completed
renewal_completed
ZATCA_APPROVED
ZATCA_COMPLIANT
```

### Forbidden equivalent booleans

```text
isCompliant
isApproved
compliancePassed
onboardingPassed
renewalPassed
```

No synonym, alternate casing, or renamed equivalent is permitted either.
Statically checked (for the identifiers above and their common casings) by
`server/tests/zatcaArchitectureGuardrails.test.ts`.

### `response_received` ≠ success ≠ passed ≠ compliant ≠ completed

This distinction is mandatory and permanent. In particular,
`providerOutcome = "not_compliant"` must never automatically become
`internalStatus = "failed"` — ZATCA responded; it just declined. Verified by
a dedicated test in `server/tests/zatcaProviderOperations.test.ts` (Slice
W), unchanged by this slice.

### Attempt/operation finished vs. compliance finished

`finished_at` / `attemptedAt` mean only that the specific technical/provider
interaction concluded. `compliance_completed_at`, `onboarding_completed_at`,
and `renewal_completed_at` (or equivalents under any other name) remain
BLOCKED — no field with that semantic meaning, regardless of its literal
name, may be introduced.

## 8. Compliance Attempt rule

A Compliance Attempt represents one individual provider interaction. It may
safely store raw provider status, normalized individual outcome, technical
error information, timestamps, and provider metadata — and must remain
scoped to that individual attempt. An attempt's result must never
automatically become an overall "compliance passed", "compliance
completed", "onboarding completed", "renewal completed", "ZATCA approved",
or "ZATCA compliant" judgment.

## 9. The negative-gate rule

ZATCA's `Missing-ComplianceSteps` error (returned by the real Production
CSID Onboarding endpoint per its Swagger export — VERIFIED, Slice O/S/X) is
a **negative gate**: it proves compliance steps are a prerequisite for that
specific operation. It does **not** provide the list of steps, the test
count, a completion definition, a queryable completion status, or a
positive compliance flag. The absence of this error on one specific
Onboarding call is not an observable, independently-queryable completion
signal — it is observable only by attempting that exact gated call.

**Therefore:** `Missing-ComplianceSteps absent ⇒ compliance_completed = true`
(or any equivalent inference) must never be implemented.

## 10. `zatca_compliance_steps` freeze

The authoritative table/model `zatca_compliance_steps` is **FROZEN**. Do
not create it, and do not recreate its semantics under a different name
(`compliance_requirements`, `required_compliance_tests`,
`zatca_required_steps`, `zatca_test_matrix`, or any equivalent). A future
implementation is permitted only once a future primary-evidence audit
explicitly unlocks the required semantics (§13, below).

Individual raw provider results remain safe to store
(`rawStatus`/`normalizedOutcome`/`errorCategory`/`providerOutcome` on
`zatca_compliance_attempts` and `zatca_provider_operations`) — what is
frozen is any **rollup** across them (`allTestsPassed`, `testsPassed`,
`compliancePassed`, `requiredTestsPassed`, or equivalents), since no primary
source defines what such a rollup would even mean.

## 11. Production CSID Onboarding boundary

```text
Compliance Attempt
        ↓
NO AUTOMATIC TRANSITION
        ↓
Production CSID Onboarding operation
```

Onboarding is operator-triggered only (`POST
/egs-units/:id/production-csid`, requires an explicit authenticated call).
No code infers, from the existence of a Compliance CSID or from any
attempt's outcome, that Production CSID onboarding should happen
automatically.

## 12. Renewal boundary

`renewProductionCsid()` is a provider operation, recorded as historical
execution only. The following remain **UNVERIFIED**:

- The exact renewal test matrix.
- Whether renewal repeats onboarding's tests, uses a reduced matrix, an
  independent matrix, or none at all.
- Exact renewal completion semantics.

Renewal must never be assumed equal to onboarding, and no renewal
requirement may be invented from implementation convenience (e.g. "it
accepts a CSR and OTP, so it probably re-runs the same tests as onboarding"
is exactly the kind of inference this project has ruled out since Slice R).

## 13. Future unlock contract

| Blocker | What would unlock it | What is insufficient |
|---|---|---|
| **A — 1100 exact test matrix/count** | A primary ZATCA source explicitly enumerating the complete `1100` test matrix/list | A family-compatibility statement alone ("1100 = both families"); a derived union of `1000`+`0100`; any third-party test-count claim |
| **B — Renewal test matrix** | A primary ZATCA source explicitly defining renewal tests/checks | The existence of a Compliance-CSID-before-renewal requirement alone; the renewal endpoint's request/response shape alone; equivalence with onboarding assumed by convenience |
| **C — Compliance completion** | A primary ZATCA source explicitly defining (1) what completion means, (2) what conditions establish it, and (3) how MIDAD can observe it (a documented status, API field, or portal state) | A generic success response (HTTP 200); `Reported`/`Accepted with Warnings`; CSID issuance of any kind; the mere absence of `Missing-ComplianceSteps` on one call |

Only a **primary** ZATCA source (official manuals, technical guidelines,
implementation standards, Swagger/OpenAPI exports, Developer Portal
documentation) can unlock a blocker. Secondary sources (blogs, third-party
integration guides, community SDKs) may be used only to locate a primary
source, never to declare a requirement verified.

## 14. Rules for future developers — decision tree

```text
Need to store what MIDAD technically did?
        ↓
YES
        ↓
Historical execution layer (zatca_provider_operations /
zatca_compliance_attempts / zatca_compliance_lifecycles)
        ↓
SAFE

Need to store an individual provider result?
        ↓
YES
        ↓
Attempt / provider operation row
        ↓
SAFE

Need to determine which tests ZATCA requires?
        ↓
YES
        ↓
CHECK PRIMARY EVIDENCE
        ↓
If absent → BLOCKED

Need to calculate compliance completion?
        ↓
YES
        ↓
CHECK PRIMARY EVIDENCE
        ↓
If absent → BLOCKED

Need to display "ZATCA compliant / approved"?
        ↓
NO
        ↓
BLOCKED

Need to automatically issue/renew a Production CSID based on test
outcomes?
        ↓
NO
        ↓
BLOCKED until explicit ZATCA semantics exist
```

If you believe you have found a primary source that unlocks Blocker A, B,
or C: do not implement against it directly. Run a dedicated evidence audit
slice (the pattern Slices N, O, P, R, S, T, U, X established) first, update
this document's §4/§12/§13 with the exact citation, and only then open a
separate implementation slice.

## 15. Automated guardrails protecting this document

`server/tests/zatcaArchitectureGuardrails.test.ts` (added in Slice Y):

- Static scan of every ZATCA source file (server `lib/zatca/**`,
  `routes/zatca.ts`, `routes/platformZatca.ts`, `db/schema.ts`, and the
  client ZATCA API/pages) for the forbidden completion identifiers in §7 and
  the forbidden `1100 = 6` / third-party `12 tests` phrases in §4 — outside
  of comment lines, so disclaiming documentation comments remain allowed.
- A static check that no CSR/Functionality-Map-handling file mentions
  self-billing, and that `xmlBuilder.ts`'s `InvoiceTypeCode` encoding and
  `CanonicalZatcaDocument` (`types.ts`) never reference a CSR or
  Functionality Map field.
- Behavioral tests proving Functionality Map positions 3/4 do not affect
  the standard/simplified family check (`1001`/`0111`/`1111` behave exactly
  like `1000`/`0100`/`1100` respectively), without assigning any meaning to
  what a non-zero position 3/4 value represents.

These guardrails are intentionally narrow (only the files this boundary
actually spans) and behavioral where practical, so a future change that
violates this document fails CI rather than depending on a developer
re-reading this file.
