# ZATCA Slice 5 Continuation — Implementation Architecture

Companion to `docs/zatca/SLICE5_OFFICIAL_SPEC_VERIFICATION.md` (which
records the specification provenance — read that first). This document
describes what was actually built on top of that baseline: the real
cryptographic architecture, what is genuinely tested and working, and
what remains a documented, honest gap.

## What changed vs. Slice 3/4/5 (first pass)

Before this continuation, ZATCA "signing" was a hard boundary: the only
`ZatcaSigner` implementation (`NotImplementedSigner`) always threw,
honestly, because no XAdES specification and no real credential existed.
Every document hash was a plain `SHA-256` of the raw XML string, with no
canonicalization or removal of pre-signature elements.

This continuation replaces both of those with real, tested implementations
— while preserving every existing architectural boundary
(`ZatcaProvider`/`ZatcaSigner`/`ZatcaSecretStore` abstractions, tenant
isolation, the "never fabricate success" rule, protected financial-domain
isolation) untouched.

## New modules

- **`lib/zatca/canonicalHash.ts`** — `computeCanonicalInvoiceHash(xml)`:
  removes `ext:UBLExtensions`, the QR `AdditionalDocumentReference`, and
  any `Signature` element, canonicalizes via `xml-crypto`'s C14N, then
  `SHA-256`+Base64. Wired into `/prepare` and `/submit` in place of the
  old plain-string hash. `lib/zatca/hash.ts`'s original `computeDocumentHash`
  is unchanged and still used only for the PIH genesis value.
- **`lib/zatca/csr/keyPair.ts`** — real ECDSA key-pair generation via
  Node's native WebCrypto. The curve is `SPEC_TEXT_REQUIRED` — must be set
  via `ZATCA_CSR_ECDSA_CURVE`, no default is ever guessed.
- **`lib/zatca/csr/csrBuilder.ts`** — real, signed PKCS#10 CSR generation
  via `@peculiar/x509` (chosen over the originally-suggested `node-forge`,
  which has no EC support at all — verified by inspecting its source).
  Standard fields use public PKIX OIDs; ZATCA-custom fields (EGS serial
  number, invoice type, location, industry) require their OIDs to be
  supplied explicitly — never invented.
- **`lib/zatca/signer/xadesZatcaSigner.ts`** — real XAdES-BES signing:
  builds `SignedProperties`/`SignedInfo` per the user-supplied structure,
  canonicalizes with the same C14N as the hash module, signs with
  WebCrypto ECDSA, embeds the signature in `ext:UBLExtensions`.
- **`lib/zatca/signer/verify.ts`** — local, self-contained (offline)
  verification of a signed document: well-formedness, hash recompute,
  `SignedProperties` digest recompute, certificate digest/issuer/serial
  consistency, certificate validity-period check, and real cryptographic
  signature verification. Wired into `/submit` — any failure stops before
  any provider call.
- **`lib/zatca/qrCryptographicTags.ts`** — derives real QR tags 6-8
  (invoice hash, ECDSA signature, ECDSA public key) from a real signed
  document. Tag 9 (ZATCA's own CA signature) is never produced — it
  requires a real Production CSID response this environment cannot obtain.
- **`lib/zatca/domain/csr.ts`** — `generateCsrForEgsUnit` (real key pair +
  CSR, private key stashed in `ZatcaSecretStore` pending confirmation) and
  `confirmCsidForEgsUnit` (accepts a certificate the tenant obtained some
  other way, verifies its public key matches the CSR's key pair before
  ever storing it). Two new tenant routes: `POST
  /api/zatca/egs-units/:id/csr` and `POST /api/zatca/egs-units/:id/csid`.

## What is deliberately NOT implemented

- **Submitting the CSR to ZATCA.** No verified request/response contract
  exists for `/core/compliance` (CSR → Compliance CSID) or
  `/core/production/csids` (Compliance CSID → Production CSID) — only
  their URLs were supplied. `domain/csr.ts` exists specifically so a
  tenant who obtains a real credential through some other channel can
  still get MIDAD's state to reflect it, without MIDAD inventing the
  network call.
- **The `/submit` route's actual provider call.** Real signing and real
  local verification now both work — proven end-to-end in
  `tests/zatcaCsrCsid.test.ts`'s full-HTTP-stack test — but the route
  still stops after verification passes, because no EGS unit in this
  environment can ever reach that point with a ZATCA-issued (rather than
  test-generated) certificate, and wiring the provider call ahead of a
  real credential would be dead code no honest test could exercise.
- **QR tag 9**, for the same reason as CSR submission.
- **Tenant-facing UI for CSR generation / CSID confirmation.** Both new
  routes are backend-only in this continuation, tested via HTTP
  integration tests (`tests/zatcaCsrCsid.test.ts`). The existing
  Simulation UI (prepare/submit) was verified in a real browser and
  correctly surfaces the new, more specific "no private key yet" failure
  reason — see the final report for screenshots/detail.

## Test coverage added this continuation

7 new test files (68 new tests), covering: canonical hash determinism and
artifact removal, CSR field validation and key generation, XAdES signing
(including a full cryptographic round-trip verified against WebCrypto's
own `verify()`), local verification's tamper-detection for every field it
checks (including an expired-certificate case), QR tag derivation, and the
CSR→CSID→sign→locally-verify chain both as direct module calls and through
the real HTTP routes. All existing Slice 2-5 tests still pass unchanged.

## Honest readiness assessment

Real, cryptographically-correct XAdES signing and local verification now
exist and are proven to work end-to-end against test-generated
certificates. No real ZATCA-issued certificate has ever been used (this
environment has no network access to ZATCA). See the final report for the
exact readiness status — this is architecture/simulation progress, not a
compliance claim.
