# ZATCA Live Sandbox Verification — Phase 25

Records the outcome of an attempted real ZATCA Sandbox verification run
against the current implementation (HEAD `b528ad1`, branch `main`). This
document contains no OTP, token, private key, password, secret,
Authorization header, or certificate private material anywhere — see the
per-operation rows below for what evidence a category means when the real
operation could not be attempted.

## Environment check (Phase 3-5)

| Check | Result |
|---|---|
| `ZATCA_FATOORA_SIMULATION_*` / `_PRODUCTION_*` env vars | **Absent** — zero `ZATCA_*` variables set anywhere in this environment (`env \| grep -o "^ZATCA_"` returns nothing) |
| `server/.env` ZATCA keys | **Absent** — only `DATABASE_URL`, `JWT_SECRET`, `PLAYWRIGHT_CHROMIUM_PATH`, `PORT` present |
| Sandbox certificate/credential material | **Absent** — no certificate, CSID, or credential exists anywhere in this environment for any real EGS unit |
| Conclusion | **LIVE TEST BLOCKED — CREDENTIALS NOT AVAILABLE** |

## Network connectivity (Phase 4)

| Check | Result |
|---|---|
| Documented Sandbox gateway hostname | `gw-fatoora.zatca.gov.sa` (per `docs/zatca/SPECIFICATION-VERIFICATION.md`, `ZATCA_NETWORK_INTEGRATION_SPEC.md` — never hardcoded in application code; MIDAD reads the base URL from environment config only) |
| DNS resolution | **Resolved** — `82.197.55.5` (via Cloudflare CDN), confirmed independently via `getent hosts` and Python `socket.gethostbyname` |
| HTTPS `CONNECT` to `gw-fatoora.zatca.gov.sa:443` | **Blocked** — local egress proxy returns `403 Forbidden` on the `CONNECT` tunnel |
| Control test: `CONNECT example.com:443` | **Identically blocked** — same `403`, proving the block is a general environment egress allowlist, not ZATCA-specific |
| Proxy status endpoint (`$HTTPS_PROXY/__agentproxy/status`) | Confirms an active allowlist policy; `recentRelayFailures` shows the identical `connect_rejected` / policy-denial reason for `www.google.com`, `example.com`, and `gw-fatoora.zatca.gov.sa` alike |
| Conclusion | **ZATCA LIVE VERIFICATION BLOCKED BY NETWORK/EGRESS** — infrastructure-level, not application-level |

## What this means for Phases 6-14, 22 (the real Sandbox chain)

No operation below was executed against ZATCA. None was simulated or
faked. Every row states the honest status.

| Operation | Local Tests | Live Sandbox | Result | Evidence | Notes |
|---|---|---|---|---|---|
| EGS creation | PASS | NOT ATTEMPTED | BLOCKED | `server/tests/zatcaConfigRoutes.test.ts` | Purely local (DB row), never touches ZATCA |
| CSR generation | PASS | NOT ATTEMPTED | BLOCKED | `server/tests/zatcaCsr.test.ts`, `zatcaCsrCsid.test.ts` | Real ECDSA/CSR generated locally; never submitted to ZATCA by MIDAD (documented architectural boundary, unchanged) |
| OTP handling | PASS (presence-check only) | NOT ATTEMPTED | BLOCKED | `zatcaCsr.test.ts` | MIDAD cannot validate an OTP against ZATCA without network access — this was never claimed otherwise |
| Compliance CSID | PASS (mock server) | NOT ATTEMPTED | BLOCKED | `zatcaComplianceLifecycles.test.ts`, `zatcaOnboardingCenterGaps.test.ts` | Real HTTP client code exercised against a local mock only |
| Compliance Invoice | PASS (mock server) | NOT ATTEMPTED | BLOCKED | `zatcaComplianceAttempts.test.ts` | Same |
| Production CSID onboarding | PASS (mock server) | NOT ATTEMPTED | BLOCKED | `zatcaProviderOperations.test.ts` | `currentCCSID` ambiguity unresolved — see below |
| Clearance | PASS (mock server) | NOT ATTEMPTED | BLOCKED | `zatcaCsrCsid.test.ts`'s full-stack test, `zatcaSubmissionExecution.test.ts` | Real signing + local verification exercised; never a real ZATCA response |
| Reporting | PASS (mock server) | NOT ATTEMPTED | BLOCKED | `zatcaSubmissionExecution.test.ts` | Same |
| Renewal | PASS (mock server) | NOT ATTEMPTED | BLOCKED | `zatcaProviderOperations.test.ts` | Authorization-header ambiguity unresolved — see below |
| Acceptance/rejection handling | PASS (mock server, both outcomes) | NOT ATTEMPTED | BLOCKED | `zatcaSubmissionExecution.test.ts` (500→retry_required, 400→compliance_failed, NOT_CLEARED→rejected+no-resubmit) | Real branch coverage against synthetic responses only |
| Failure/recovery (timeouts, 4xx/5xx, duplicate) | PASS (mock server) | NOT ATTEMPTED | BLOCKED | `zatcaProvider.test.ts`, `zatcaSubmissionExecution.test.ts` | Same |

## Spec ambiguities — classification (Phase 26)

| Item | Classification | Basis |
|---|---|---|
| `currentCCSID` on Production CSID Onboarding | **UNVERIFIED** | `onboarding.pdf`'s 400 error list names it; its Parameters table does not. No live Sandbox response obtained this phase or any prior phase. Code sends no such field (documented refusal to guess) |
| Renewal's missing `Authorization` header | **UNVERIFIED** | `renewal.pdf`'s Parameters table has no `Authorization` row despite 401 being a documented response. No live evidence obtained. Code sends none (documented refusal to guess) |
| C14N 1.0 vs 1.1 | **DOCUMENTED, UNVERIFIED against ZATCA** | The engineering argument (MIDAD's XML never carries `xml:`-prefixed inherited attributes; the canonicalized subset is always the complete root element) is sound and documented in `canonicalHash.ts`, but is a claim about MIDAD's own document shape, not a verified fact about which algorithm ZATCA's spec requires. `www.w3.org/TR/xml-c14n11/` and `zatca.gov.sa`'s Security Features Implementation Standard are both unreachable from this environment (confirmed blocked, same as above) — no local copy of either exists in this repository. Resolvable only by a real ZATCA hash-acceptance/rejection or a reachable copy of the primary spec text, neither available this phase |
| QR Tag 9 | **EXTERNAL ZATCA-SIGNED DATA — NOT A LOCAL DEFECT** | Structurally requires ZATCA's own CA signature over a real Production CSID's public key; no environment can produce this locally. Code correctly refuses to fabricate it (`qrCryptographicTags.ts`) |

## Local verification actually completed this phase (fresh evidence, not reused from a prior report)

| Area | Result |
|---|---|
| Baseline server tests | PASS — 86 files / 1275 tests |
| Baseline client tests | PASS — 32 files / 278 tests |
| Typecheck (server + client) | PASS |
| Build (server + client) | PASS |
| ZATCA suite ×3 consecutive | PASS — 30 files / 471 tests each run, identical, no flakiness |
| Cross-tenant isolation (CSR/compliance-csid/compliance-invoices/production-csid/renewal/GET state routes) | PASS — `zatcaOnboardingCenterGaps.test.ts` re-run fresh, 20/20 |
| `zatcaOnboardingRateLimit` (per-company, covers `verify-connection`/`compliance-csid`/`compliance-invoices`/`production-csid`/`production-csid/renew`) | PASS — re-run fresh |
| Secret-flow grep (`logger.`/`console.` calls across the entire ZATCA subsystem + new onboarding files) | PASS — no new leak; only pre-existing, already-audited calls found; client `localStorage` usage is limited to the unrelated auth JWT token |
| Audit-event writes on the 4 new GET routes | Confirmed **zero** `recordAuditEvent` calls (correct — pure reads, matching every other GET route's convention) |
| Domain/crypto files (`domain/`, `csr/`, `signer/`, `canonicalHash.ts`, `qr.ts`, `qrCryptographicTags.ts`) | Confirmed **byte-for-byte unchanged** since the prior audit (`git diff a8f42d2..b528ad1` on these paths is empty) — every prior finding on ICV/PIH/XAdES/QR/state-machine correctness still applies unmodified |

## Verdict

**ZATCA LIVE VERIFICATION BLOCKED — NO PRODUCTION CLAIM.**

Neither network access nor Sandbox credentials exist in this environment.
Nothing above was simulated or fabricated. See
`docs/zatca/CUSTOMER_ONBOARDING_CENTER.md` for the operator checklist to
run once real Sandbox access exists — it remains accurate and unchanged by
this phase (no code changed).
