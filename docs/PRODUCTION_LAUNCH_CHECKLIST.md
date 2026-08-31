# MIDAD Production Launch Checklist

This is a practical, evidence-based checklist for the first real production launch — not a description of the target architecture (see `docs/MIDAD_MASTER_PROMPT.md` for that). Every item below is marked from one of three states, and only from direct evidence:

- `[x]` **VERIFIED** — proven from live code, a passing test, or a real HTTP/browser check performed against a running instance.
- `[ ]` **EXTERNAL CONFIRMATION REQUIRED** — cannot be verified from this repository; depends on a production infrastructure choice or account that hasn't been made/configured yet.
- `[ ]` **NOT CONFIGURED / DEFERRED** — deliberately not done in this repository, with the reason stated.

Nothing below is marked done because it "should" work or because a similar system usually has it. If you are reading this before launch, re-run the actual checks — do not trust this file blindly either.

---

## Application

- [x] Tenant authentication — `requireAuth` re-checks `users.status` from the DB on every request (`server/src/middleware/auth.ts`), not merely trusting the JWT. Covered by `tests/authorization.test.ts`, `tests/multiTenant.test.ts`.
- [x] Platform authentication — `platformAuth` does the same DB-authoritative check against `platform_operators` (`server/src/middleware/platformAuth.ts`). Live-verified: platform login works, tenant JWT → 401 on platform routes, platform JWT → 401 on tenant routes.
- [x] Tenant isolation — every project-scoped router re-verifies `companyId` ownership before any handler runs; sampled and confirmed across 50+ handlers in the pre-launch audit, zero IDOR found. Covered by `tests/multiTenant.test.ts`, `tests/financialIntegrity.test.ts`, and others.
- [x] Authorization — `server/src/lib/permissions.ts`'s RBAC matrix, re-read from the DB per request, gates every owner-only mutation. Untouched by this session.
- [x] Audit trail — single canonical `audit_events` table (`server/src/lib/audit.ts`), no second store anywhere.
- [x] Request IDs — `requestIdMiddleware` sets/echoes `X-Request-Id` on every request; live-verified present on responses.
- [x] Health/live — `GET /api/health/live` returns `{"status":"ok"}`, live-verified 200.
- [x] Health/ready — `GET /api/health/ready` runs `SELECT 1` against Postgres, live-verified 200.
- [x] Invoice transaction atomicity — `server/src/routes/invoices.ts POST /` wraps parent insert, audit event, and line-items insert in one `db.transaction`. Proven both by `tests/invoiceQuoteTransactionAtomicity.test.ts` (real DB-level failure, not mocked) and live via real HTTP (a genuine Postgres numeric-overflow error rolls back the parent row — verified count-before/count-after).
- [x] Quote transaction atomicity — same pattern, `server/src/routes/quotes.ts POST /`. Same dual proof (test + live HTTP).
- [x] Server tests — 588/588 passing (37 files).
- [x] Client tests — 249/249 passing (29 files).
- [x] Typecheck — server and client both clean (`tsc --noEmit`).
- [x] Build — server and client production builds both clean.

## Security

- [ ] **CORS production origin confirmed — EXTERNAL CONFIRMATION REQUIRED.** The mechanism now exists: `server/src/lib/corsOrigins.ts` + `CORS_ORIGIN` env var restricts allowed origins when set (comma-separated), live-verified both for an allowed origin (`Access-Control-Allow-Origin` reflects it) and a disallowed one (header correctly absent). But `CORS_ORIGIN` is unset by default — until a real production frontend origin is known and the env var is set at deploy time, the server keeps its previous wide-open (`*`) behavior. **Action required at deploy time:** set `CORS_ORIGIN` to the actual production frontend URL(s).
- [x] Security headers confirmed — `helmet({ contentSecurityPolicy: false })` is applied (`server/src/app.ts`); live-verified `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: no-referrer` present on real responses. CSP is deliberately left off: this server serves no HTML (pure JSON API + PDF/logo binary responses), so a document-level policy has nothing to apply to — forcing one on would be exactly the kind of blind policy this hardening pass was told not to add.
- [x] Secrets not committed — `server/.env` is gitignored and confirmed untracked (`git ls-files` shows no `.env`); no hardcoded secret found anywhere in `server/src` or `client/src` (grepped in the pre-launch audit).
- [x] JWT configuration confirmed — `JWT_SECRET` is required (the server throws at startup if unset), 7-day expiry, bcrypt password hashing (cost factor 10). `.env.example` documents `JWT_SECRET=change-me-to-a-long-random-string` as a placeholder that must be replaced before any real deployment.
- [ ] **Rate limiting confirmed — NOT CONFIGURED / DEFERRED beyond auth.** `authRateLimit` (10 requests/15min/IP) already protects `/api/auth/*` and `/api/platform/auth/*`. A *general* rate limiter across every route was considered and deliberately **not** added this session: doing so safely requires a traffic-policy decision this repository cannot make on its own (what request volume is normal vs. abusive differs per route — a legitimate BOQ import might fire dozens of sequential requests; a scripted attack on `/api/customers` looks identical in shape). Concretely, several existing test files already fire many rapid sequential requests from the same in-process "IP," and a naive general limiter risked turning those into false-positive 429s — exactly the failure mode the task warned against. This is genuine post-launch hardening work, not something to guess at now.
- [ ] **Production HTTPS confirmed — EXTERNAL CONFIRMATION REQUIRED.** HTTPS termination is an infrastructure/hosting-provider concern, not something this repository configures. Confirm the chosen host terminates TLS (most static/PaaS hosts do this by default) before launch.

## Database

- [ ] **Production provider selected — EXTERNAL CONFIRMATION REQUIRED.** Confirmed by fresh discovery this session: `docs/BACKUP_STRATEGY.md` explicitly states no provider has been chosen and deliberately does not implement provider-specific automation ahead of that choice. No provider-specific config (Vercel/Railway/Render/Supabase/AWS/etc.) exists anywhere in the repo.
- [ ] **Automated backups enabled — EXTERNAL CONFIRMATION REQUIRED.** Cannot be proven from this repository. Check in the chosen provider's own dashboard once selected.
- [ ] **PITR enabled where available — EXTERNAL CONFIRMATION REQUIRED.** Same as above.
- [ ] **Retention confirmed (≥ 7 daily + 4 weekly) — EXTERNAL CONFIRMATION REQUIRED.** Minimum defined in `docs/BACKUP_STRATEGY.md`; must be set and confirmed in the provider's dashboard.
- [ ] **Restore test completed — EXTERNAL CONFIRMATION REQUIRED.** Not performed — no production/scratch database credentials or infrastructure access were available in this session, and `docs/BACKUP_STRATEGY.md` explicitly requires this be run at least once before go-live, never against real customer data. **Date of last restore test: none.**

## Deployment

- [ ] **API deployed — EXTERNAL CONFIRMATION REQUIRED.** No production hosting is configured in this repository. `server/package.json` has a working `start` script (`node dist/index.js` after `npm run build`) that a host can run directly.
- [ ] **Client deployed — EXTERNAL CONFIRMATION REQUIRED.** `README.md` explicitly lists production hosting (Railway/Render/Vercel or similar) as something that still needs an external account connected to this repo — confirmed again by fresh discovery this session, not just carried over from a prior report. `server/src/app.ts` has no `express.static`/catch-all for `client/dist` and none was added this session, since the architecture doesn't clearly commit to the API server also serving the frontend (separate npm workspaces, independent build steps) — adding one speculatively would be exactly the kind of guessed infrastructure this task was told not to produce. **Decision needed:** either host `client/dist` on a static host/CDN, or explicitly decide the Express server should serve it (a small, deliberate follow-up if so).
- [ ] **Client can reach API — EXTERNAL CONFIRMATION REQUIRED.** Depends on both of the above being deployed and the client's API base URL being configured to point at the real API origin.
- [ ] **Production environment variables configured — EXTERNAL CONFIRMATION REQUIRED.** Required at minimum: `DATABASE_URL`, `JWT_SECRET` (a real random value, not the `.env.example` placeholder), `PORT` (optional, defaults to 4000). Newly relevant as of this session: `CORS_ORIGIN` (optional but recommended — see Security above).
- [ ] **Production domain configured — EXTERNAL CONFIRMATION REQUIRED.** Not chosen yet.
- [ ] **CORS matches production client — EXTERNAL CONFIRMATION REQUIRED.** Mechanism ready (see Security above); needs the real domain once chosen.
- [x] Health endpoints reachable — verified locally this session (`/api/health/live`, `/api/health/ready` both 200 against a real running instance). Re-verify against the actual production URL once deployed.
- [ ] **HTTPS working — EXTERNAL CONFIRMATION REQUIRED.** Same as Production HTTPS above.

## Operations

- [x] Admin platform login works — live-verified this session.
- [x] Organizations list works — live-verified this session (20 results returned).
- [x] Organization search works — live-verified this session (substring match against real seeded data).
- [x] Support sessions work — grant/list/activity/revoke all live-verified in the immediately preceding pre-launch audit session (unchanged by this session's work; this session touched no support-session code).
- [x] Activity works — same, live-verified in the prior session.
- [x] Revoke works — same, live-verified in the prior session; revoked sessions correctly return 403 on subsequent activity reads.
- [x] Audit trail works — `invoice.created` audit events confirmed present via `GET /api/audit-events` in this session's new tests.
- [x] Logs accessible — structured JSON logs to stdout/stderr (`server/src/lib/logger.ts`), one line per request plus explicit financial-mutation and error log lines.
- [x] Request IDs searchable — every structured log line and every error response carries the same `requestId`, generated/validated by `requestIdMiddleware` and echoed as the `X-Request-Id` response header.

---

## Summary

**Code-level items:** all verified complete as of this session (invoice/quote transaction atomicity, CORS restriction mechanism, security headers, and the full existing test/typecheck/build gate).

**Deliberately deferred (not launch blockers):** general rate limiting beyond auth endpoints, error-tracking service integration (see below).

**Error tracking provider: NOT CONFIGURED.** No Sentry (or equivalent) package, DSN, or environment variable exists anywhere in this repository, and none was added this session — there is nothing to point it at without an account/DSN, and inventing one would violate this task's explicit instruction never to fabricate a service integration. Structured logs + request IDs remain the baseline for diagnosing a customer-reported issue; this is not a launch blocker, matching the pre-launch audit's own classification.

**Genuinely external, unverifiable from this repository:** production database provider/backups/PITR/restore-testing, and production client/API hosting + domain + HTTPS + the resulting CORS origin value. These require an actual infrastructure decision and account access this session does not have.
