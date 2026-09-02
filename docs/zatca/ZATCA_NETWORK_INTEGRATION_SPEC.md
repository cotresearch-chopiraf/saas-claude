# ZATCA Network Integration Spec Report

Companion to `docs/zatca/SLICE5_OFFICIAL_SPEC_VERIFICATION.md` and
`docs/zatca/SLICE5_IMPLEMENTATION.md`. This report covers the specific
network-integration continuation: whether MIDAD can safely implement the
real Compliance CSID / Production CSID / Reporting / Clearance API calls,
and if not, exactly what is missing.

## Provenance notice — read this first (updated)

The original version of this document recorded that `zatca.gov.sa` was
`EGRESS_BLOCKED` from this environment on every attempt (eight independent
confirmations across Slices 3-5 and the prior continuation), and that every
wire-level detail was therefore `SWAGGER_CONTRACT_REQUIRED`. That network
block is still true and unchanged — this session has never reached
`zatca.gov.sa`.

What changed: the user registered their own account on the real ZATCA
Developer Portal (`sandbox.zatca.gov.sa`), and — from inside that account —
exported and shared the following files directly in this conversation:

| File | What it is | Genuinely read by this session |
|---|---|---|
| `reporting.pdf` | Raw Swagger/OpenAPI export ("e-Invoicing Sandbox Release (2.1.0)") for `POST /invoices/reporting/single` | Yes — full text extracted, all fields verified |
| `clearance.pdf` | Same, for `POST /invoices/clearance/single` | Yes — full text extracted, all fields verified |
| `zacta_manuel.pdf` | Official ZATCA **Developer Portal User Manual** ("فاتورة", Version 3, Nov 2022), 96 pages | Yes — read in full (text layer; the manual's own API screenshots are images and are NOT machine-text-extractable, see caveat below) |
| `20220624_ZATCA_Electronic_Invoice_XML_Implementation_Standard_vF.pdf` | Official XML Implementation Standard | Skimmed for cross-corroboration of already-implemented XML building/hashing — no contradictions found |
| `20220624_ZATCA_Electronic_Invoice_Security_Features_Implementation_Standards.pdf` | Official Security Features Implementation Standard | Skimmed for cross-corroboration of already-implemented CSR/key-pair/QR generation — no contradictions found |
| `EInvoice_Data_Dictionary.xlsx` | Official field data dictionary | Received; not yet needed for this continuation's scope (XML field-level work is unchanged) |

This is a qualitatively different provenance than everything else in this
document: it is the user's own primary-source export, not a secondary
source and not text asserted in a task prompt. Where this document says
**VERIFIED**, it means this session independently read the exact bytes of
that export. Where it says **CROSS-CORROBORATED (manual, not Swagger)**, it
means the official User Manual confirms an endpoint, flow, or field exists
and roughly what it carries, but the manual documents the Swagger UI via
step-by-step **screenshots** (images), which this session's PDF-text
extraction cannot read — so exact JSON field names and exact HTTP header
names for those specific calls remain unconfirmed and are still marked
`SWAGGER_CONTRACT_REQUIRED`. Nothing below is invented from either
category.

## Verification table

| Component | Official source | Verified contract | MIDAD status | Required action |
|---|---|---|---|---|
| **Reporting** (simplified invoice) | `reporting.pdf` — real Swagger export, read in full | **VERIFIED.** `POST /invoices/reporting/single`. Headers: `Authorization` (Basic, `binarySecurityToken`:`secret`), `Accept-Language` (en/ar), `Clearance-Status: "0"` (required), `Accept-Version: "V2"` (required). Body: `{invoiceHash, uuid, invoice}`. Response: `{validationResults, reportingStatus: "REPORTED"\|"NOT_REPORTED"}`. 409 = already reported. | **Implemented and tested this continuation** — `fatooraClient.ts`, `fatooraProvider.ts`'s `reportInvoice`/`normalizeReportingResponse`, 6 new dedicated tests in `zatcaProvider.test.ts` (REPORTED, WARNING-but-still-success, NOT_REPORTED, 409→duplicate, unrecognized-status guard, header assertions) | Done for the wire contract. `/submit` route is still not wired to call it — see note below |
| **Clearance** (standard invoice) | `clearance.pdf` — real Swagger export, read in full | **VERIFIED.** `POST /invoices/clearance/single`. Same headers except `Clearance-Status: "1"`. Body: same shape. Response: `{validationResults, clearanceStatus: "CLEARED"\|"NOT_CLEARED", clearedInvoice: string\|null}` (`clearedInvoice` = base64 ZATCA-signed/stamped XML, present only on `CLEARED`). 208 = hash previously submitted; 303 = clearance deactivated for this account, use Reporting instead. | **Implemented and tested this continuation** — `normalizeClearanceResponse`, `clearedInvoiceXmlBase64` field added to `ZatcaSubmissionResult`, 5 new dedicated tests (CLEARED with extraction, NOT_CLEARED never populates the field, 208→duplicate, 303→configuration error, unrecognized-status guard) | Done for the wire contract. `/submit` route not wired — see note below |
| Compliance CSID (CSR + OTP → Compliance CSID) | `zacta_manuel.pdf` §2.3.10.1 (pp. 25-27) | **CROSS-CORROBORATED (manual, not Swagger).** Confirmed: endpoint reached via "Compliance CSID API" in the Sandbox Swagger UI; request requires a valid OTP plus the CSR in the request body; response is 200 on success; `Accept-Version: V2` required for all calls. Exact JSON field name for the CSR (`"csr"` is known from a bled-through shared schema fragment seen in `clearance.pdf`, not from this manual) and the exact HTTP header name for OTP are in screenshot images the manual embeds, not extractable text — `SWAGGER_CONTRACT_REQUIRED` for those specifics | CSR generation is real and tested (`domain/csr.ts`'s `generateCsrForEgsUnit`). The network exchange itself is still not implemented — `confirmCsidForEgsUnit` accepts an externally-obtained certificate and verifies it against the CSR's key pair before storing it | `SWAGGER_CONTRACT_REQUIRED` for the exact request/response wire format before this can be wired to a real network call |
| Compliance Invoice / compliance checks | `zacta_manuel.pdf` §2.3.10.2 (pp. 28-33) | **CROSS-CORROBORATED (manual, not Swagger).** Confirmed: authenticated with the `binarySecurityToken`/`secret` Basic-Auth pair returned by the Compliance CSID call (same auth pattern as Reporting/Clearance); request body is described as "invoice hash, UUID, encoded XML invoice" — the **same three-field shape** already used by `buildDocumentBody` for Reporting/Clearance. Response schema itself (success/rejection field names) not shown — only "Result (200)" / "Result (400)" screenshots | `submitComplianceDocument` exists on `FatooraProvider` (Slice 3), reuses `buildDocumentBody` (now cross-corroborated) and the conservative `normalizeUnverifiedComplianceResponse` — deliberately not upgraded to the strict Reporting/Clearance-style normalizer since the response schema is still unconfirmed | `SWAGGER_CONTRACT_REQUIRED` for the response schema before this can be treated as verified |
| Production CSID onboarding (Compliance CSID + "compliance request ID" → Production CSID) | `zacta_manuel.pdf` §2.3.10.3 (pp. 34-39) | **CROSS-CORROBORATED (manual, not Swagger).** Confirmed: same Basic-Auth pattern; request body is described as "the compliance request ID" (a single field, exact JSON key not shown — screenshot); response 200 on success. **New finding, not previously known**: the manual states production onboarding "will return an invalid response until [compliance] checks are completed" between the Compliance CSID and Production CSID steps — i.e. the real backend enforces a *third* gate (compliance checks completed) beyond just "Compliance CSID issued", which MIDAD's state machine does not currently track (see gap below) | Not implemented as a network call. MIDAD's own state machine enforces the ordering this workflow implies (`confirmCsidForEgsUnit` refuses `stage: "production"` unless `csidStatus` is already `compliance_issued`) | `SWAGGER_CONTRACT_REQUIRED` for the network exchange. **Known gap**: no state field yet tracks "compliance checks completed" as a distinct precondition from "Compliance CSID issued" — a real Production CSID call could still be rejected by ZATCA even after MIDAD's current check passes. Left undone rather than guessed at, since the exact completion criterion (how many checks, which invoice types) is not documented anywhere available to this session |
| Production CSID renewal (OTP + CSR → new Production CSID) | `zacta_manuel.pdf` §2.3.10.4 (pp. 40-45) | **CROSS-CORROBORATED (manual, not Swagger).** Confirmed: requires OTP + CSR in the request body (same shape pattern as Compliance CSID), authenticated with the existing CSID's Basic-Auth pair | Not implemented — no distinct renewal code path exists; `generateCsrForEgsUnit` can be called again to produce a fresh CSR, but nothing automates the renewal-specific request | `SWAGGER_CONTRACT_REQUIRED` |
| VAT Registration Number consistency (CSID VAT must match subsequent CSR/invoice/QR VAT) | `zacta_manuel.pdf` §2.3.9 (p. 23), verbatim: *"the VAT Registration number used to obtain the test CSID must match with the VAT Registration number in the Renewal CSR and/or e-invoices... submitted in all subsequent calls made using that specific test CSID"* | **Now confirmed by a genuine primary source** (previously implemented from general domain knowledge, not a citable source) | Implemented and tested in the prior pass of this continuation: `generateCsrForEgsUnit` requires `fields.organizationIdentifier` to exactly equal the company's registered VAT number | Done |
| Compliance-before-Production ordering | `zacta_manuel.pdf` §2.3.9 (p. 23) and §2.3.10.3 (p. 34), describing Production CSID as requiring "a test Compliance CSID to be submitted" first | **Now confirmed by a genuine primary source** | Implemented and tested in the prior pass of this continuation: `confirmCsidForEgsUnit` refuses a `production`-stage confirmation unless `csidStatus` is already `compliance_issued` | Done, though see the "compliance checks completed" gap noted above — this ordering check is necessary but may not be sufficient against the real backend |
| CSR field definitions (Organization Identifier, Organization Unit Name, Invoice Type functionality map, EGS Serial Number, key pair algorithm) | `zacta_manuel.pdf` §5.3.1-5.3.3 (pp. 89-94) | **CROSS-CORROBORATED.** Confirms: Organization Identifier = 15-digit VAT number starting and ending with `3`; Organization Unit Name = branch name, or the 10-digit TIN of the group member when the 11th digit of the Organization Identifier is `1` (VAT group); Invoice Type = 4-digit binary map over "TSCZ"; EGS Serial Number format `1-<vendor>|2-<model>|3-<serial>`; key pair = ECDSA on the P-256/secp256k1 curve, CSR signed with SHA-256 | Matches the existing implementation in `domain/csr.ts` and `keyPair.ts` (Slice 5 continuation) — no discrepancy found, no code change needed from this cross-check | None — confirmation only |
| SDK / Portal-Based Validator | Not covered by any file shared this continuation | `SWAGGER_CONTRACT_REQUIRED` / tool itself unreachable | `validateZatcaDocument` (Slice 1/4) performs only structural/arithmetic checks and always sets `sdkVerified: false` — unchanged | `OFFICIAL_SDK_UNAVAILABLE_IN_ENVIRONMENT` |

## What this continuation actually changed in code

Only the two **VERIFIED** rows (Reporting, Clearance) were wired against
their exact contract — `fatooraClient.ts` (headers, 208/303/409 status
handling, `Accept-Version` default), `fatooraProvider.ts` (`Clearance-Status`
header selection, `normalizeReportingResponse`, `normalizeClearanceResponse`,
`clearedInvoiceXmlBase64` extraction), `provider/types.ts`
(`ZatcaSubmissionResult.clearedInvoiceXmlBase64`), and 11 new tests in
`zatcaProvider.test.ts` (32 tests total in that file, all passing).

Compliance CSID, Compliance Invoice, and Production CSID (onboarding and
renewal) remain **not wired to any network call** — the manual raised their
confidence from "workflow name only" to "cross-corroborated flow, still
missing exact field/header names", which is real progress but not the
Swagger-level certainty this project requires before writing a network
integration that claims to be correct. `SWAGGER_CONTRACT_REQUIRED` still
applies to all four.

The `/submit` route (`routes/zatca.ts`) is deliberately **not** wired to
call the now-verified `reportInvoice`/`clearInvoice` even though their wire
contract is verified: no EGS unit in this environment has ever held a
ZATCA-issued (rather than test-generated) certificate, and no real Sandbox
credentials exist here to submit against. Wiring the route without a way
to test it against anything real would be exactly the "looks more complete
than it is" failure mode this project has consistently avoided. This is a
scope decision, not a technical blocker — the provider methods themselves
are ready.

## Sandbox / SDK access

No ZATCA endpoint (Sandbox or production) has been contacted at any point
in this project. `zatca.gov.sa` remains `EGRESS_BLOCKED` from this
environment. All verification in the two **VERIFIED** rows above came from
reading the user's own exported Swagger documents directly, not from a live
API call — a real Sandbox transaction has never been executed or observed.

**Real Sandbox result: SIMULATION BLOCKED — credentials/network
unavailable.** This is unchanged by this continuation.

**SDK/validator: `OFFICIAL_SDK_UNAVAILABLE_IN_ENVIRONMENT`.**
