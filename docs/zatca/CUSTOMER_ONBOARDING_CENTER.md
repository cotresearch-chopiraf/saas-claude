# ZATCA Customer Onboarding & Compliance Center

Records what the "ZATCA Customer Onboarding & Compliance Center" work added
to MIDAD, why it drew the boundaries it did, and the exact operator
checklist for a real Sandbox verification run. It supersedes nothing in
`docs/zatca/` — those files remain the record of the underlying backend's
own verification history; this file covers only the customer-facing layer
built on top of it.

## What this closed

Before this work, every ZATCA onboarding capability past "connect an
already-obtained credential" existed only as a backend route
(`server/src/routes/zatca.ts`) with no UI: CSR generation, Compliance CSID
request, Compliance Invoice test submission, Production CSID onboarding,
and renewal were all real, tested, working endpoints reachable only via a
direct authenticated HTTP call (curl/Postman) — never through the product a
real MIDAD customer would use. This is now closed: a tenant owner can walk
through CSR → Compliance CSID (request + confirm) → Compliance Invoice test
→ Production CSID (request + confirm) → Renewal from inside MIDAD, per EGS
unit, behind the existing "إعداد ZATCA الحقيقي" toggle on
`/zatca` (`client/src/pages/zatca/ZatcaOnboardingPanel.tsx`).

## What was NOT changed

- **No ZATCA business logic changed.** Every one of the six onboarding
  routes this Center calls was already implemented, tested, and correct —
  this work only added a UI (and four new read-only GET routes reusing
  existing domain functions, see below) on top of them. The CSR field
  validation, the Compliance CSID/Production CSID network contracts, the
  XAdES signer, and the ICV/PIH machinery are byte-for-byte unchanged.
- **No cryptographic logic in the client.** The browser never generates a
  key pair, builds a CSR, computes a hash, or signs anything — it only
  collects the same field values the existing backend routes already
  required and submits them, exactly as `ZatcaSettings.tsx`'s existing
  Simulation card already did for `/prepare`/`/submit`.
- **The Compliance CSID request/confirm split is preserved, not merged.**
  `POST /compliance-csid` (a real ZATCA call) and `POST /csid` (local
  confirmation) remain two separate actions, exactly as
  `domain/complianceCsid.ts`'s own file comment documents as a deliberate
  architectural boundary from an earlier slice. The UI is explicit about
  this: after a successful Compliance CSID request, it tells the tenant the
  real credential ZATCA returned is not shown or auto-applied (MIDAD never
  echoes a secret back to the browser) and that the separate confirm step
  still needs the credential entered directly.
- **Renewal does not touch the active credential.** `renewProductionCsidForEgsUnit`
  only ever writes a `zatca_provider_operations` history row — it was never
  wired to `zatca_egs_units.secretRef`/`csidStatus`, before or after this
  work. The Renewal tab says so explicitly and points the tenant back to
  the existing "ربط بيانات الاعتماد" (connect credentials) step to actually
  activate a renewed credential.
- **The Compliance Invoice (test) step takes a raw document, not a real
  invoice.** `domain/complianceInvoice.ts`'s own file comment states this
  is intentional — "ZERO financial integration" with real MIDAD invoices,
  so a compliance-test call can never touch a real ICV/PIH sequence.
  Building UBL XML/hash from a selected real invoice for this specific call
  would have meant either duplicating XML-building/hashing logic in the
  client (forbidden) or silently reusing the real `/prepare` pipeline for a
  test call (which would burn real ICV sequence numbers on test documents —
  a correctness bug). The UI instead takes the same raw Base64
  XML/hash/UUID the backend route contract already requires, with a
  client-side UUID generator (`crypto.randomUUID()`, not domain logic) for
  convenience, and says plainly that this is independent of MIDAD's real
  invoices.

## Two spec ambiguities, still unresolved (deliberately)

Both are cited verbatim from `server/src/lib/zatca/provider/fatooraClient.ts`'s
existing comments — nothing here resolves them, and the UI does not either:

1. **`currentCCSID` on Production CSID Onboarding.** `onboarding.pdf`'s
   documented 400 error list mentions `Missing-CurrentCCSID`/
   `Invalid-CurrentCCSID`, but no `currentCCSID` parameter appears in that
   same export's Parameters table for this endpoint. The code sends no such
   field and does not guess one. The Production CSID tab in the UI shows
   this ambiguity as a labeled note before the request button, and any real
   rejection naming it is shown as the real error text, not hidden.
2. **Renewal's missing `Authorization` header.** `renewal.pdf`'s captured
   Parameters table lists no `Authorization` row for this endpoint even
   though 401 is a documented possible response. The code sends no
   `Authorization` header for renewal and does not invent the row. Not
   separately called out in the Renewal tab's copy (the underlying call is
   unchanged either way), but a 401 there would surface as a real,
   unmasked authentication error via the same error-mapping used
   everywhere else in this Center.

Both remain **Pending ZATCA Sandbox Verification** — resolvable only against
a real Sandbox response, never by guessing here.

## New backend surface (read-only, reused domain functions only)

Four new `GET` routes were added so the UI can show current state after a
page reload, none of them adding new business logic — each wraps an
existing domain lookup function that already existed for other callers:

| Route | Reuses |
|---|---|
| `GET /api/zatca/egs-units/:id/csr` | `findCurrentCsrInstance` |
| `GET /api/zatca/egs-units/:id/compliance-csid` | `findCurrentCsrInstance` + `getComplianceLifecycleForCsrInstance` |
| `GET /api/zatca/egs-units/:id/compliance-invoices` | `listComplianceAttemptsForLifecycle` |
| `GET /api/zatca/egs-units/:id/production-csid` | `listProviderOperationsForEgsUnit` |

None of them ever returns a `secretRef` or any credential material — see
`server/tests/zatcaOnboardingCenterGaps.test.ts` for the tests proving this
per route.

A new `zatcaOnboardingRateLimit` (per-company, 20/15min in production, same
shape as the existing `zatcaSubmitRateLimit`) was added to the five
onboarding routes that make a real outbound ZATCA call and were previously
unprotected: `verify-connection`, `compliance-csid`, `compliance-invoices`,
`production-csid`, `production-csid/renew` — the ZATCA Live Sandbox
Verification audit's own finding. `csr` and `csid` are unaffected (neither
makes a real network call).

HTTP-level cross-tenant regression tests were added for `compliance-csid`,
`compliance-invoices`, `production-csid`, and `production-csid/renew` — the
same audit's other finding (the underlying domain functions were already
company-scoped; only the explicit HTTP-level test was missing for these
four routes specifically).

## Operator checklist for a real ZATCA Sandbox verification run

This checklist assumes the reader has real ZATCA Sandbox Developer Portal
access. No credential, OTP, or secret value belongs in this file, in any
commit, in logs, or in a screenshot — see the security review this Center's
implementation itself passed (Phase 13/23) for what "never expose" means in
practice.

| # | Step | Driven by |
|---|---|---|
| 1 | Obtain ZATCA Sandbox Developer Portal access | Admin/manual — outside MIDAD entirely |
| 2 | Set `ZATCA_FATOORA_SIMULATION_BASE_URL` / `_COMPLIANCE_PATH` / `_COMPLIANCE_CSID_PATH` / `_PRODUCTION_CSID_PATH` / `_CLEARANCE_PATH` / `_REPORTING_PATH` via the deployment's secret/environment management | Admin/manual — never committed, never hardcoded (see `fatooraClient.ts`'s own refusal to guess these) |
| 3 | Create a tax identity + EGS unit in MIDAD | **UI-driven** — `/zatca` page, steps ١ and ٢ |
| 4 | Generate a CSR | **UI-driven** — Onboarding Center, tab "١. طلب CSR" |
| 5 | Obtain an OTP from the ZATCA Developer Portal | Admin/manual — outside MIDAD |
| 6 | Request a Compliance CSID | **UI-driven** — tab "٢. شهادة الامتثال", section أ (real ZATCA call) |
| 6b | Confirm the Compliance CSID (enter the credential from step 6's real ZATCA response) | **UI-driven** — tab "٢", section ب |
| 7 | Submit a Compliance Invoice test document | **UI-driven** — tab "٣. فاتورة اختبار الامتثال" (caller supplies the raw test document; see "What was NOT changed" above) |
| 8 | Obtain a Production CSID | **UI-driven** — tab "٤. تفعيل الإنتاج", section أ, then confirm in section ب — **blocked pending Sandbox verification of the `currentCCSID` ambiguity above** |
| 9 | Submit a real Clearance test invoice | **UI-driven** — existing Simulation card (`/zatca`, step ٥) prepare/submit flow, unchanged by this Center |
| 10 | Submit a real Reporting test invoice | **UI-driven** — same flow as step 9, routed automatically by invoice subtype |
| 11 | Verify the real responses (HTTP status, ZATCA's own acceptance/rejection fields) against what MIDAD persisted | **UI-driven** to read (submission history, `/zatca` step ٦); verifying correctness against ZATCA's own documentation is a manual review step |
| 12 | Test renewal | **UI-driven** — tab "٥. التجديد" — **blocked pending Sandbox verification of the Authorization-header ambiguity above** |

Steps 8 and 12 are the only two genuinely blocked-pending-Sandbox-evidence
items — everything else is fully UI-driven today. Neither is a missing UI;
both are the two documented spec ambiguities above, which only a real
Sandbox response can resolve.
