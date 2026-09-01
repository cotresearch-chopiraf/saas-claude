# ZATCA Slice 5 Continuation — Official Spec Verification Report

## Provenance notice (read this first)

This report is **not** independent verification against ZATCA's primary
sources. Every fresh attempt to reach `zatca.gov.sa` (and subdomains,
including `gw-fatoora.zatca.gov.sa`) and `www.w3.org` from this environment
during this continuation returned `EGRESS_BLOCKED` — the same result
obtained in Slices 3, 4, and 5 (first pass), now reproduced a fifth time,
immediately before this document was written. No local copy of any ZATCA
document (Detailed Technical Guideline, Security Features Implementation
Standard, XML Implementation Standard, FATOORA Portal User Manual) exists
anywhere under `/home/user`.

The task instruction for this continuation states that the official
documentation "has been independently located and verified outside" this
environment, and supplies detailed technical content directly in the prompt
to use as the specification baseline, with instructions to mark any item
that content does not cover as `SPEC_TEXT_REQUIRED` rather than guess.

**Every row below sourced from that in-prompt content is labeled
`USER-SUPPLIED (unverified by this session against zatca.gov.sa/w3.org —
both still EGRESS_BLOCKED)`.** This is a deliberate, honest distinction
from "officially verified" as that phrase is used elsewhere in this repo's
ZATCA docs (e.g. `SPECIFICATION-VERIFICATION.md`), and every place this
content is used in code or docs downstream carries the same label. No
"ZATCA Compliant" claim is made anywhere as a result of implementing
against this content.

## Verification table

| Requirement | Official source (as cited by user) | Exact section/page | Current MIDAD implementation | Gap | Action |
|---|---|---|---|---|---|
| FATOORA production endpoints (compliance, compliance/invoices, production/csids, reporting/single, clearance/single) | ZATCA Systems Developers hub / Detailed Technical Guideline | Not given (URLs only) | `lib/zatca/provider/fatooraClient.ts` reads all URLs from env vars, throws if unset — no hostname hardcoded. Documented in `.env.example` (task #52, done): `ZATCA_FATOORA_{SIMULATION\|PRODUCTION}_{BASE_URL,COMPLIANCE_PATH,CLEARANCE_PATH,REPORTING_PATH}` map to `/core/compliance/invoices`, `/core/invoices/clearance/single`, `/core/invoices/reporting/single` respectively — `/core/compliance` (CSR→Compliance CSID) and `/core/production/csids` (Compliance CSID→Production CSID) are documented but deliberately NOT wired to any env var or `ZatcaProvider` method, since no request/response contract for them was supplied (see `domain/csr.ts`) | None for architecture; exact URL values are USER-SUPPLIED | Done — see `.env.example`. Wiring the two CSID-exchange endpoints into `ZatcaProvider` remains `SPEC_TEXT_REQUIRED` (their request/response JSON shape was never supplied) |
| FATOORA request/response JSON field names, headers, auth scheme, API version | Detailed Technical Guideline | Not given — only endpoint URLs were supplied | Conservative status-code-driven classification in `fatooraProvider.ts`/`fatooraClient.ts`, unchanged since Slice 3/5 | Exact field names, headers, auth scheme are `SPEC_TEXT_REQUIRED` | No change to request/response body shape this continuation — keep existing conservative classification (never treat unknown 2xx as success) |
| Hash canonicalization steps (remove UBLExtensions/QR AdditionalDocumentReference/Signature, strip XML declaration, C14N11, SHA-256, Base64) | Security Features Implementation Standard (19 May 2023) | Not given (exact XPath expressions not supplied) | `lib/zatca/hash.ts` — plain `SHA-256(content)`, no removal/canonicalization step | USER-SUPPLIED: removal-then-canonicalize sequence. Exact XPath predicates for locating the elements are `SPEC_TEXT_REQUIRED` — implemented against MIDAD's own known `xmlBuilder.ts` output structure instead of an official XPath | Implement removal by element name against MIDAD's own generated structure (task #46), document the XPath gap explicitly in code comments |
| C14N vs C14N11 | W3C xml-c14n11 spec | Not given; `www.w3.org` unreachable to diff directly | N/A (no canonicalization existed before) | The exact byte-level diff between C14N 1.0 and 1.1 is `SPEC_TEXT_REQUIRED` (could not be fetched) | Use `xml-crypto`'s C14N (base, 1.0) implementation; document as engineering judgment that MIDAD's XML (no `xml:`-prefixed attributes, always whole-document) makes the two algorithms behaviorally equivalent for this document shape — NOT a claim that this was checked against ZATCA's required algorithm choice |
| XAdES SignedProperties structure (SigningTime, SigningCertificate/Cert/CertDigest, IssuerSerial/X509IssuerName+X509SerialNumber) | Security Features Implementation Standard | Not given | No XAdES signer exists (`NotImplementedSigner` only) | USER-SUPPLIED structure; exact namespace prefixes/attribute ordering beyond what was given are `SPEC_TEXT_REQUIRED` | Implement using fixed public XAdES (ETSI TS 101 903) / XMLDSig (`http://www.w3.org/2000/09/xmldsig#`) standard namespace URIs — these are public cross-industry standards, not ZATCA-specific guesses (task #48) |
| SignedInfo references (`Reference URI="#xades-SignedProperties"`, `Reference Id="invoiceSignedData"`) | Security Features Implementation Standard | Not given | N/A | USER-SUPPLIED exact IDs — implemented verbatim as given | Use exactly these two reference identifiers in `XadesZatcaSigner` (task #48) |
| CSR fields (CN, EGS Serial Number, OU, O, C, Invoice Type TSXY, Location, Industry) | Security Features Implementation Standard | Not given | No CSR generation exists | USER-SUPPLIED exact field list — implemented verbatim | Implement CSR builder with exactly these fields via `node-forge` (task #47) |
| Organization Identifier format (15 digits, starts and ends with 3) | Security Features Implementation Standard | Not given | N/A | USER-SUPPLIED validation rule | Validate in CSR builder input (task #47) |
| ECDSA curve for the key pair | Not specified by user (only "ECDSA... per official security requirements") | N/A | N/A | Curve choice is `SPEC_TEXT_REQUIRED` | Use `secp256k1` only if an env var / config makes the curve explicit and overridable, and document this as an assumption, not a verified requirement (task #47) — see code comment for the specific reasoning |
| CSR → OTP → Compliance CSID → Production CSID sequence | FATOORA Portal User Manual | Not given | `csidStatus` enum already exists (Slice 2): none/compliance_pending/compliance_issued/production_issued/expired/revoked | USER-SUPPLIED sequence description; exact request/response bodies at each step are `SPEC_TEXT_REQUIRED` | Model the sequence as domain state transitions only; go through `ZatcaProvider` for any network call (task #51) |
| OTP handling (from FATOORA portal, 1 hour validity, manual paste into MIDAD, never persisted/logged) | FATOORA Portal User Manual | Not given | No OTP handling exists | USER-SUPPLIED — implemented verbatim as a non-persisted request field | OTP accepted only as a transient request parameter, never written to DB or logs (task #51) |
| QR tags 1-9 (seller name, VAT no., timestamp, total, VAT total, XML hash, ECDSA signature, ECDSA public key, ZATCA CA signature) | Security Features Implementation Standard / XML Implementation Standard | Not given | `lib/zatca/qr.ts` implements tags 1-5 only (Slice 1) | Tags 6-8 now computable once hash/signature/public key exist; tag 9 requires a real ZATCA CA response, which this environment cannot obtain | Implement tags 6-8 for real; explicitly mark tag 9 unavailable/blocked in code and docs (task #50) — never fabricate a CA signature |
| Reporting API (Simplified/B2C, within 24h, EGS self-stamps) vs Clearance API (Standard/B2B, must be cleared before delivery) | Detailed Technical Guideline | Not given | Not yet distinguished in submission routes | USER-SUPPLIED distinction | Keep as separate code paths per invoice type, not merged (task carried into #51/#52 scope; no route restructuring beyond what's needed for the distinction) |
| FATOORA response disposition taxonomy (accepted / accepted_with_warnings / rejected / auth errors / duplicate / rate_limited / timeout / network_error / provider_error / unknown_response) | Detailed Technical Guideline | Not given | `errors.ts` already has a comparable category taxonomy (Slice 5 first pass); response disposition itself only partially modeled | Minor terminology gap only | No structural change required — existing `ZatcaError` categories already cover this taxonomy; confirmed equivalence, no code change needed |

## Items intentionally left `SPEC_TEXT_REQUIRED` (not implemented from memory)

- Exact FATOORA JSON request/response field names and HTTP headers (only endpoint URLs were supplied).
- Exact XPath expressions for locating `UBLExtensions`/QR `AdditionalDocumentReference`/`Signature` elements for hash-canonicalization removal.
- The precise C14N-vs-C14N11 byte-level diff (both `www.w3.org` and the ZATCA standard text are unreachable).
- The exact ECDSA curve ZATCA requires.
- Exact CSR/CSID/OTP request and response JSON bodies for each lifecycle step.
- Tag 9 of the QR code (requires a real ZATCA CA response — cannot be produced without a real Production CSID from an actual FATOORA environment).

None of these are guessed. Where implementation requires a concrete choice
(e.g. the ECDSA curve), the choice is made explicit, overridable via
configuration, and documented as an assumption rather than a verified fact.

## Conclusion

This continuation implements the architecture and code paths the user's
in-prompt content describes, with honest provenance labeling throughout.
This does **not** upgrade MIDAD's ZATCA integration to "verified against
official ZATCA specification" — that status still requires genuine access
to `zatca.gov.sa`/the official documents, which remains unavailable to this
session. See `docs/zatca/SLICE5_IMPLEMENTATION.md` for what was built on
top of this baseline and the resulting readiness status.
