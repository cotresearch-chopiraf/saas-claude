# ZATCA Slice 5 — Discovery Report

Starting HEAD: `5fcfd89632327698cee613bff788abdd5bd0b187` (Slice 4 commit).
Working tree: clean. Fresh read of every file below was performed before any
Slice 5 edit (see the session's own tool trace); most of this architecture
was built earlier in this same session (Slices 1–4), so "fresh" here means
re-confirmed against the actual current file contents, not recalled from an
unrelated prior session.

## Existing architecture

| Component | File(s) | Status |
|---|---|---|
| `ZatcaProvider` interface | `lib/zatca/provider/types.ts` | **COMPLETE** — `getEnvironment`, `checkConnection`, `submitComplianceDocument`, `clearInvoice`, `reportInvoice`. |
| `FatooraProvider` (the one implementation) | `lib/zatca/provider/fatooraProvider.ts` | **PARTIALLY COMPLETE** — fully implemented against an env-configured endpoint contract; the exact byte-for-byte ZATCA request/response shape is unverified (see SPECIFICATION-VERIFICATION.md). Never hardcodes a ZATCA hostname. |
| `fatooraClient.ts` (raw HTTP transport) | `lib/zatca/provider/fatooraClient.ts` | **PARTIALLY COMPLETE** — real HTTP, timeout, correlation IDs, structured error mapping. Slice 5 refines the 4xx mapping (see below); still MISSING a verified certificate-failure signal (no way to distinguish it from generic auth failure without the primary spec). |
| `ZatcaSecretStore` | `lib/zatca/secretStore/types.ts`, `devSecretStore.ts`, `index.ts` | **PARTIALLY COMPLETE** — interface is production-shaped (tenant-scoped put/resolve/delete); only implementation is the explicitly non-production in-memory dev store. Slice 5 adds a guard so it cannot silently serve a real production deployment (see below). A real cloud-backed store remains **BLOCKED BY EXTERNAL DEPENDENCY** (no secret-manager decision has been made — see Slice 3's explicit non-authorization of the sandbox's incidental AWS credentials). |
| `ZatcaSigner` | `lib/zatca/signer/types.ts`, `notImplementedSigner.ts`, `index.ts` | **BLOCKED BY EXTERNAL DEPENDENCY** — the only implementation honestly fails (`ZatcaNotImplementedError`); no `XadesZatcaSigner` exists or was added, because the primary XAdES specification is unreachable. |
| EGS management | `lib/zatca/domain/egsUnits.ts`, `routes/zatca.ts` | **COMPLETE** for what's supported: create, deactivate, credential connect/clear, real (never fabricated) `verify-connection`. CSR/CSID issuance workflow is **BLOCKED**. |
| Tenant identity / VAT / CR | `lib/zatca/domain/config.ts` | **COMPLETE** — reuses `company_tax_identifiers`, no duplicate storage. |
| Document builder | `lib/zatca/documentBuilder.ts` | **COMPLETE** for the invoice shape MIDAD actually has (single tax rate, one document type). Documented, known limitations (free-text address, no per-line tax rate) unchanged this slice. |
| Hash / ICV / PIH | `lib/zatca/hash.ts`, `domain/icv.ts`, `domain/pih.ts` | **COMPLETE** as a MIDAD-side atomic implementation; **PARTIALLY VERIFIED** against the official algorithm (secondary sources only). Slice 5 adds a concurrency test, no logic change. |
| Prepare flow | `routes/zatca.ts` (`POST .../prepare`) | **COMPLETE** — atomic transaction (PIH lock → ICV claim → build → hash → PIH advance → submission insert), idempotent per (company, EGS unit, invoice). |
| Submission flow | `routes/zatca.ts` (`POST submissions/:id/submit`) | **PARTIALLY COMPLETE** — regenerates and hash-verifies the prepared document, is idempotent, and correctly refuses to call the provider without a real signature. Cannot reach "submitted to ZATCA" because signing is blocked. |
| Retry behavior | Same route | **COMPLETE** for the honest-failure case (retryCount increments, same submission row reused, no duplicate created). Real network-retry-after-transient-failure is exercised at the provider layer only (mock HTTP server tests), since the full route can never reach the provider today. |
| Onboarding status | `lib/zatca/domain/onboarding.ts` | **COMPLETE** — pure computed view, no duplicate state machine. |
| Tenant UI | `pages/ZatcaSettings.tsx` | **COMPLETE** for every implemented capability; correctly shows "not implemented" wording rather than a fabricated state for signing/submission. |
| Platform admin UI | `platform/pages/PlatformZatca.tsx` | **COMPLETE** — read-only, no secret exposure, onboarding + submission-state aggregates. |
| Permissions | `lib/permissions.ts` (`zatca.configure`, `zatca.submit`) | **COMPLETE** — unchanged since Slice 3; Slice 5 introduces no new permission (none was needed). |
| Tests | `server/tests/zatca*.test.ts` (8 files, ~110 ZATCA-specific tests before Slice 5) | **COMPLETE** for everything implemented; this slice adds concurrency and new-error-category coverage. |

## Remaining gap (unchanged root cause across Slices 3, 4, 5)

Every MISSING/BLOCKED item above traces back to the same two external
blockers, neither of which changed this slice:

1. **No reachable primary ZATCA specification** (`zatca.gov.sa` and all
   subdomains tested return `EGRESS_BLOCKED`; no official mirror exists
   elsewhere — see SPECIFICATION-VERIFICATION.md for the fresh re-check).
2. **No real ZATCA Simulation credentials** exist anywhere in this
   environment (`env | grep -i zatca` returns nothing; no `.env` file
   contains one).

Given both, Slice 5's scope is: strengthen what can be strengthened without
fabricating ZATCA-specific behavior, and document the blocker precisely
rather than re-stating it vaguely.
