# ZATCA Specification Verification — Slice 5

Per the Slice 5 execution rule: primary (official ZATCA) sources take priority
over blogs, GitHub examples, unofficial SDKs, and third-party tutorials. An
item is only implemented as "verified" if it was checked against a source in
that first tier. Everything else in this table is either unreachable or
explicitly excluded from being treated as authoritative.

## Environment check (repeated fresh for Slice 5, 2026-09-01)

`WebFetch` was attempted against every ZATCA host tried in this and prior
slices, immediately before any Slice 5 code was written:

| URL attempted | Result |
|---|---|
| `https://zatca.gov.sa/en/E-Invoicing/SystemsDevelopers/Pages/default.aspx` | `EGRESS_BLOCKED` |
| `https://zatca.gov.sa/en/E-Invoicing/SystemsDevelopers/ComplianceEnablementToolbox/Pages/DownloadSDK.aspx` | `EGRESS_BLOCKED` |
| `https://gw-fatoora.zatca.gov.sa/e-invoicing/developer-portal` | `EGRESS_BLOCKED` |
| `https://github.com/zatca` (checking for an official public SDK/XSD mirror) | Reachable, but the organization has **no public repositories** |

`WebSearch` for an official (non-`zatca.gov.sa`) mirror of the SDK/XSD/
Schematron turned up only unofficial community packages (`wes4m/zatca-xml-js`,
`Saleh7/php-zatca-xml`, `SallaApp/ZATCA`) and confirmed the only official
distribution channel is the SDK download page above, which is blocked in this
environment. This is a **network egress policy block specific to
`zatca.gov.sa` and its subdomains**, not a transient failure — it has now been
independently reproduced in Slices 3, 4, and 5, across four distinct URLs.

Per Slice 5 Section 3: **"If an official source cannot be accessed or
verified: STOP that specific implementation. Do not guess."** Every row below
that depends on the primary specification is therefore marked BLOCKED, and no
code in this slice implements the corresponding behavior from memory or from
an unofficial source.

## Verification table

| Area | Officially Verified | Source | Status |
|---|---|---|---|
| FATOORA API (endpoints, auth scheme, headers, response/error structure) | No | None reachable — `zatca.gov.sa` blocked | **BLOCKED — OFFICIAL SPECIFICATION NOT VERIFIED**. Unchanged from Slice 3/4: endpoint paths/headers remain environment-configured, never hardcoded (`lib/zatca/provider/fatooraClient.ts`). |
| UBL / XML structure | No (unchanged since Slice 1) | Cross-corroborated via `WebSearch` against secondary integration guides only, in Slice 1's discovery — never the primary XSD/Schematron | **BLOCKED** for anything beyond what Slice 1 already built and labeled unverified. No new UBL fields added this slice. |
| Hash (SHA-256, Base64, genesis value) | No | Same secondary-source cross-corroboration as Slice 1 | **BLOCKED** for exact-byte-range confirmation (e.g. whether signature/extension elements are excluded before hashing). `lib/zatca/hash.ts` unchanged this slice. |
| ICV (Invoice Counter Value) | Partially — the *general concept* (sequential, gap-free, per-EGS counter) is well-corroborated, but exact reset/renewal rules are not | Secondary sources only | Implementation (Slice 2) already treats this conservatively: atomic per-(company, EGS) counter, no reset logic invented. Slice 5 adds a concurrency test proving the existing atomic-claim design actually serializes under parallel load — this is a MIDAD-side transaction-safety property, not a ZATCA fact, so it needed no external verification. |
| PIH (Previous Invoice Hash) | Partially — chaining concept and genesis value corroborated, exact encoding/edge cases not | Secondary sources only | Unchanged this slice (`lib/zatca/domain/pih.ts`). |
| XAdES (signature profile, canonicalization, SignedProperties, certificate embedding) | No | None reachable | **BLOCKED — OFFICIAL SPECIFICATION NOT VERIFIED.** No `XadesZatcaSigner` implemented. `NotImplementedSigner` (Slice 4) remains the only `ZatcaSigner`, and continues to fail honestly rather than fabricate a signature. |
| CSR / CSID lifecycle (CSR attributes, OTP, Compliance→Production flow) | No | None reachable | **BLOCKED.** No CSR generation code added. The existing `csidStatus` enum (Slice 2: none/compliance_pending/compliance_issued/production_issued/expired/revoked) already models the state surface; Slice 5 does not add a second one. |
| QR (TLV tags, encoding) | Partially — Phase 1 tags (1–5: seller name, VAT number, timestamp, total, VAT total) are well-corroborated; Phase 2 cryptographic tags (6–9) are not, since they depend on XAdES | Secondary sources only, from Slice 1 | Unchanged this slice (`lib/zatca/qr.ts`). No official test vectors exist to cite, so none were invented — Slice 1's existing tests remain self-consistent/round-trip tests only. |

## Conclusion

No new ZATCA-specific technical behavior requiring primary-source
verification was implemented in Slice 5. Every change in this slice is either:

1. A refinement grounded in **standard, non-ZATCA-specific HTTP semantics**
   (distinguishing 401/403/429 — see `lib/zatca/errors.ts`), or
2. A **MIDAD-internal architecture/safety property** that needed no external
   verification (production secret-store guard, ICV concurrency test).

This keeps Slice 5 honest about the fact that the hard blocker identified in
Slice 4 (no reachable primary ZATCA source, no real credentials) has not
changed.
