# ZATCA Network Integration Spec Report

Companion to `docs/zatca/SLICE5_OFFICIAL_SPEC_VERIFICATION.md` and
`docs/zatca/SLICE5_IMPLEMENTATION.md`. This report covers the specific
network-integration continuation: whether MIDAD can safely implement the
real Compliance CSID / Production CSID / Reporting / Clearance API calls,
and if not, exactly what is missing.

## Provenance notice — read this first

This continuation's task instruction asserted independent verification of
the official ZATCA Developer Portal User Manual, citing a specific PDF URL
and page/section numbers (pp. 22–50, §2.3.9–2.3.10), and supplied detailed
workflow descriptions directly in the prompt.

Before writing anything below, this session re-attempted to fetch:

- `https://zatca.gov.sa/en/E-Invoicing/SystemsDevelopers/ComplianceEnablementToolbox/Documents/Developer%20Portal%20User%20Manual.pdf` (the exact cited URL)
- `https://zatca.gov.sa/en/E-Invoicing/Pages/default.aspx` (the domain root, to test whether the block is document-specific)
- `https://www.w3.org/TR/xml-c14n11/` (unrelated control check, consistent with every prior slice)

All three returned `EGRESS_BLOCKED` from this environment's network proxy.
This is the same result obtained on every previous attempt across Slices
3, 4, 5, and the prior continuation — now reconfirmed an eighth time. No
local copy of the manual exists anywhere in this environment.

**Every workflow description below sourced from this continuation's task
prompt is therefore labeled `USER-SUPPLIED (unverified by this session
against the primary PDF — zatca.gov.sa remains EGRESS_BLOCKED)`.** Per
this continuation's own explicit instruction, that is treated as expected
and not a reason to abandon the task — but it is also why every concrete
wire-level detail (exact endpoint paths beyond what earlier slices already
documented, HTTP headers, request/response JSON field names, status-code
meanings, authentication scheme specifics) is marked `SWAGGER_CONTRACT_REQUIRED`
rather than invented. The task instruction is explicit that only the
Integration Sandbox's own Swagger documentation is authoritative for that
level of detail, and this session has no way to reach it.

## Verification table

| Component | Official source | Verified contract | MIDAD status | Required action |
|---|---|---|---|---|
| Compliance CSID (CSR + OTP → Compliance CSID) | ZATCA Developer Portal User Manual (USER-SUPPLIED, unverified) | `SWAGGER_CONTRACT_REQUIRED` — endpoint exists at `/core/compliance` per Slice 5's endpoint list, but request/response body, headers, and status-code semantics are not available | CSR generation is real and tested (`domain/csr.ts`'s `generateCsrForEgsUnit`). The network exchange itself is not implemented — `confirmCsidForEgsUnit` instead accepts an externally-obtained certificate and verifies it against the CSR's key pair before storing it | Obtain the Sandbox's Swagger contract before wiring a real `ZatcaProvider` method; until then, no code path fabricates this exchange |
| Compliance Invoice / compliance checks | ZATCA Developer Portal User Manual (USER-SUPPLIED, unverified) | `SWAGGER_CONTRACT_REQUIRED` | Not implemented. `submitComplianceDocument` exists on `FatooraProvider` from Slice 3 and posts to the same `compliancePath` used for `checkConnection`, but its request/response contract (`buildDocumentBody`/`normalizeSubmissionResponse`) is itself only cross-corroborated secondary-source consensus, not verified against this manual | `SWAGGER_CONTRACT_REQUIRED` |
| Production CSID onboarding (current Compliance CSID + compliance request ID → Production CSID) | ZATCA Developer Portal User Manual (USER-SUPPLIED, unverified) | `SWAGGER_CONTRACT_REQUIRED` — endpoint exists at `/core/production/csids` per Slice 5's endpoint list; request/response contract unknown, including the exact shape of "compliance request ID" | Not implemented as a network call. MIDAD's own state machine now enforces the *ordering* this workflow implies (`confirmCsidForEgsUnit` refuses `stage: "production"` unless `csidStatus` is already `compliance_issued` — see below) without inventing the wire contract | `SWAGGER_CONTRACT_REQUIRED` for the network exchange; ordering enforcement is done |
| Production CSID renewal (OTP + current CSID + CSR → new Production CSID) | ZATCA Developer Portal User Manual (USER-SUPPLIED, unverified) | `SWAGGER_CONTRACT_REQUIRED` | Not implemented — no distinct renewal code path exists; `generateCsrForEgsUnit` can be called again to produce a fresh CSR, but nothing automates the renewal-specific request | `SWAGGER_CONTRACT_REQUIRED` |
| Reporting (simplified invoice) | ZATCA Developer Portal User Manual (USER-SUPPLIED, unverified) | `SWAGGER_CONTRACT_REQUIRED` for the exact request/response — endpoint at `/core/invoices/reporting/single` per Slice 5's endpoint list | `reportInvoice` exists on `FatooraProvider` (Slice 3), unchanged. `/submit` never reaches it — it stops after real local signature verification, since no EGS unit in this environment has ever held a ZATCA-issued (rather than test-generated) certificate | `SWAGGER_CONTRACT_REQUIRED`; would also need a real credential to test against |
| Clearance (standard invoice) | ZATCA Developer Portal User Manual (USER-SUPPLIED, unverified) | `SWAGGER_CONTRACT_REQUIRED` — endpoint at `/core/invoices/clearance/single` | `clearInvoice` exists on `FatooraProvider` (Slice 3), unchanged, same as Reporting | `SWAGGER_CONTRACT_REQUIRED`; same caveat |
| VAT Registration Number consistency (CSID VAT must match subsequent CSR/invoice/QR VAT) | ZATCA Developer Portal User Manual (USER-SUPPLIED, unverified) | This is a MIDAD-internal business rule, not a wire contract — no Swagger dependency | **Implemented and tested this continuation**: `generateCsrForEgsUnit` now requires `fields.organizationIdentifier` to exactly equal the company's registered VAT number; every invoice already draws from that same identity, so this one check is sufficient | Done |
| Compliance-before-Production ordering ("CSR → Production CSID" must not be a shortcut) | ZATCA Developer Portal User Manual (USER-SUPPLIED, unverified) | Also a MIDAD-internal state-machine rule, not a wire contract | **Implemented and tested this continuation**: `confirmCsidForEgsUnit` now refuses a `production`-stage confirmation unless `csidStatus` is already `compliance_issued`, and refuses a redundant repeat confirmation at either stage | Done |
| SDK / Portal-Based Validator | ZATCA Developer Portal User Manual (USER-SUPPLIED, unverified) | `SWAGGER_CONTRACT_REQUIRED` / tool itself unreachable | `validateZatcaDocument` (Slice 1/4) performs only structural/arithmetic checks and always sets `sdkVerified: false` — this was already true before this continuation and is not a new claim | `OFFICIAL_SDK_UNAVAILABLE_IN_ENVIRONMENT` |

## Why the network provider methods are not implemented this continuation

The task instruction is explicit and, on this point, unambiguous: "DO NOT
invent any API request body, header, field, endpoint variant, certificate
format, or authentication rule that is not explicitly documented," with
`SWAGGER_CONTRACT_REQUIRED` as the required response when the exact
Swagger schema cannot be accessed. Every one of the four network
exchanges above (Compliance CSID, Compliance Invoice, Production CSID
onboarding/renewal, Reporting, Clearance) requires exactly that
undocumented detail — none of it was supplied in the task prompt beyond
workflow *names and ordering*, and this session's own attempts to reach
the primary source failed identically to every prior attempt.

Implementing them anyway — inventing a JSON body shape, a header name, a
status-code meaning — would violate this instruction as directly as
implementing them from memory would, and would produce code that looks
tested (mock-server tests can always be made to pass against an invented
contract) while being unverifiable against reality. That is a worse
outcome than not implementing it: it would look more complete than it is.

What *is* real and delivered this continuation: the two workflow-ORDERING
rules the manual's description implies (compliance-before-production,
VAT consistency) — genuinely implementable and testable without any wire
contract, because they are checks MIDAD's own state can enforce on
itself.

## Sandbox / SDK access

Per the task instruction's Step 3, if Developer-Portal/Sandbox access were
reachable even with `zatca.gov.sa` itself blocked, it should be used. No
such alternate path was found — the only URL tested besides the manual
PDF was the domain root, which failed identically. No Integration Sandbox
credentials exist in this environment.

**Real Sandbox result: SIMULATION BLOCKED — credentials/network
unavailable.** No real ZATCA endpoint (Sandbox or production) was
contacted at any point in this continuation.

**SDK/validator: `OFFICIAL_SDK_UNAVAILABLE_IN_ENVIRONMENT`.**
