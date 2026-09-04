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
- [x] Graceful shutdown — `server/src/lib/shutdown.ts` stops accepting new HTTP connections then closes the Postgres pool, bounded by a 10s timeout, on both `SIGTERM` and `SIGINT`. Covered by `tests/gracefulShutdown.test.ts`.
- [x] Database pool bounds — `server/src/db/client.ts`'s `Pool` sets explicit `max` (10), `idleTimeoutMillis` (30s), `connectionTimeoutMillis` (5s), and `statement_timeout` (30s) — node-postgres's own unbounded defaults (in particular an infinite `connectionTimeoutMillis`) are never relied on. Covered by `tests/dbPoolResilience.test.ts`.
- [x] Server tests — 1126/1126 passing (76 files, Slice AC).
- [x] Client tests — 262/262 passing (30 files, Slice AC).
- [x] Typecheck — server and client both clean (`tsc --noEmit`).
- [x] Build — server and client production builds both clean.

## Security

- [ ] **CORS production origin confirmed — EXTERNAL CONFIRMATION REQUIRED.** The mechanism now exists: `server/src/lib/corsOrigins.ts` + `CORS_ORIGIN` env var restricts allowed origins when set (comma-separated), live-verified both for an allowed origin (`Access-Control-Allow-Origin` reflects it) and a disallowed one (header correctly absent). But `CORS_ORIGIN` is unset by default — until a real production frontend origin is known and the env var is set at deploy time, the server keeps its previous wide-open (`*`) behavior. **Action required at deploy time:** set `CORS_ORIGIN` to the actual production frontend URL(s).
- [x] Security headers confirmed — `helmet({ contentSecurityPolicy: false })` is applied (`server/src/app.ts`); live-verified `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: no-referrer` present on real responses. CSP is deliberately left off: this server serves no HTML (pure JSON API + PDF/logo binary responses), so a document-level policy has nothing to apply to — forcing one on would be exactly the kind of blind policy this hardening pass was told not to add.
- [x] Secrets not committed — `server/.env` is gitignored and confirmed untracked (`git ls-files` shows no `.env`); no hardcoded secret found anywhere in `server/src` or `client/src` (grepped in the pre-launch audit).
- [x] JWT configuration confirmed — `JWT_SECRET` is required (the server throws at startup if unset), 7-day expiry, bcrypt password hashing (cost factor 10). `.env.example` documents `JWT_SECRET=change-me-to-a-long-random-string` as a placeholder that must be replaced before any real deployment.
- [ ] **Rate limiting confirmed — NOT CONFIGURED / DEFERRED beyond auth.** `authRateLimit` (`server/src/middleware/rateLimit.ts`) protects `/api/auth/*` and `/api/platform/auth/*` at 10 requests/15min/IP in every real environment — production and development are never relaxed. (AC-05: the limit is raised to 100/15min/IP *only* when `NODE_ENV=test`, an explicit, documented, test-only exception closing a false-failure interaction with vitest's single-shared-process test runs — see that file's own comment and `tests/observabilityRateLimit.test.ts`.) A *general* rate limiter across every route remains deliberately **not** added: doing so safely requires a traffic-policy decision this repository cannot make on its own (what request volume is normal vs. abusive differs per route — a legitimate BOQ import might fire dozens of sequential requests; a scripted attack on `/api/customers` looks identical in shape). This is genuine post-launch hardening work, not something to guess at now.
- [ ] **Production HTTPS confirmed — EXTERNAL CONFIRMATION REQUIRED.** HTTPS termination is an infrastructure/hosting-provider concern, not something this repository configures. Confirm the chosen host terminates TLS (most static/PaaS hosts do this by default) before launch.

## Database

- [ ] **Production provider selected — EXTERNAL CONFIRMATION REQUIRED.** Confirmed by fresh discovery this session: `docs/BACKUP_STRATEGY.md` explicitly states no provider has been chosen and deliberately does not implement provider-specific automation ahead of that choice. No provider-specific config (Vercel/Railway/Render/Supabase/AWS/etc.) exists anywhere in the repo.
- [ ] **Automated backups enabled — EXTERNAL CONFIRMATION REQUIRED.** Cannot be proven from this repository. Check in the chosen provider's own dashboard once selected.
- [ ] **PITR enabled where available — EXTERNAL CONFIRMATION REQUIRED.** Same as above.
- [ ] **Retention confirmed (≥ 7 daily + 4 weekly) — EXTERNAL CONFIRMATION REQUIRED.** Minimum defined in `docs/BACKUP_STRATEGY.md`; must be set and confirmed in the provider's dashboard.
- [ ] **Restore test completed — EXTERNAL CONFIRMATION REQUIRED.** Not performed — no production/scratch database credentials or infrastructure access were available in this session, and `docs/BACKUP_STRATEGY.md` explicitly requires this be run at least once before go-live, never against real customer data. **Date of last restore test: none.**

## Deployment

**Docker image (server/API only — see below for the client).** The root `Dockerfile` is a multi-stage build: it `npm ci`'s the full workspace, compiles the server with `tsc`, then produces a runtime image with production-only dependencies, a Playwright Chromium install (real PDF rendering, not optional), and the compiled `server/dist` + raw `server/drizzle/*.sql` migration files. Runs as a non-root user. CI validates this image builds from a clean checkout on every push/PR (`.github/workflows/ci.yml`'s "Build Docker image" step) — build-only, no registry push.

```bash
# Build (from the repo root, where the Dockerfile lives):
docker build -t midad-server .

# Apply migrations once, as a separate step — never automatically on every
# container start (see the Slice Z implementation report for why):
docker run --rm --env DATABASE_URL=... midad-server node dist/db/migrate.js

# Run the server:
docker run -d -p 4000:4000 \
  --env DATABASE_URL=... --env JWT_SECRET=... \
  --env MAIL_PROVIDER=resend --env RESEND_API_KEY=... --env MAIL_FROM_ADDRESS=... \
  --env STORAGE_PROVIDER=s3 --env S3_BUCKET=... --env S3_REGION=... --env S3_ACCESS_KEY_ID=... --env S3_SECRET_ACCESS_KEY=... \
  --env CORS_ORIGIN=https://app.example.com \
  midad-server
```

The image declares a `HEALTHCHECK` (AC-10) that polls `GET /api/health/ready` (not `/live`) every 30s via Node's own `fetch` — no curl/wget is installed in the slim base image, and none is added for this alone. `/ready` (not `/live`) is deliberate: this repo has no Kubernetes/Swarm manifest that would auto-replace an "unhealthy" container on a transient DB blip (the real risk Kubernetes's separate liveness/readiness split exists to avoid), so what actually matters here is `docker-compose`'s `depends_on: condition: service_healthy` and host-level monitoring being able to tell "process up but database unreachable" apart from a genuinely working container.

`docker-compose.yml` at the repo root currently defines only the Postgres service (local development) — it does not yet orchestrate the app image above; add an `app:` service there (or an equivalent in whatever orchestrator is chosen) when wiring a full docker-compose-based deployment.

- [ ] **API deployed — EXTERNAL CONFIRMATION REQUIRED.** No production hosting account is configured in this repository, but the deployable artifact now exists and is CI-validated: the Docker image above (`server/package.json`'s `start` script, `node dist/index.js`, is what it runs). Any host that can run a Docker image (or a plain Node 22 process, with `npx playwright install --with-deps chromium` run once) can serve this.
- [ ] **Client deployed — EXTERNAL CONFIRMATION REQUIRED.** The client is a static Vite build (`client/dist/`) meant to be served separately (a static host/CDN) — `server/src/app.ts` has no `express.static`/catch-all for it, and none was added, since the architecture deliberately keeps the two as independent deployment artifacts (separate npm workspaces, independent build steps, matching `CORS_ORIGIN`'s split-origin assumption). **Decision needed:** host `client/dist` on a static host/CDN, or explicitly decide the Express server should serve it (a small, deliberate follow-up if so).
- [ ] **Client can reach API — EXTERNAL CONFIRMATION REQUIRED.** Depends on both of the above being deployed and the client's API base URL being configured to point at the real API origin.
- [ ] **Production environment variables configured — EXTERNAL CONFIRMATION REQUIRED.** Required at minimum: `DATABASE_URL`, `JWT_SECRET` (a real random value, not the `.env.example` placeholder), `PORT` (optional, defaults to 4000), `CORS_ORIGIN` (recommended — see Security above). Production additionally requires an explicit `MAIL_PROVIDER`, `STORAGE_PROVIDER`, and (if using ZATCA in production) `ZATCA_SECRET_STORE_PROVIDER` — see Providers below; each fails closed (refuses to start/serve, never silently degrades) if left unset in `NODE_ENV=production`.
- [ ] **Production domain configured — EXTERNAL CONFIRMATION REQUIRED.** Not chosen yet.
- [ ] **CORS matches production client — EXTERNAL CONFIRMATION REQUIRED.** Mechanism ready (see Security above); needs the real domain once chosen.
- [x] Health endpoints reachable — verified locally (`/api/health/live`, `/api/health/ready` both 200 against a real running instance), and now also polled automatically by the Docker image's own `HEALTHCHECK`. Re-verify against the actual production URL once deployed.
- [ ] **HTTPS working — EXTERNAL CONFIRMATION REQUIRED.** Same as Production HTTPS above.

## Providers (storage, email, ZATCA secrets)

Every provider below follows the same fail-closed rule: an **explicit** choice is always honored in any environment; only a **silently unset** provider refuses to start/serve in `NODE_ENV=production` (development/test may fall back to the safe local/console default). Full variable reference in `.env.example`.

- **Email** (`server/src/lib/mailer.ts`) — `MAIL_PROVIDER=console` logs to the server console (dev/test default; refused in production unless explicitly set). `MAIL_PROVIDER=resend` sends real email via the Resend API and requires `RESEND_API_KEY` + `MAIL_FROM_ADDRESS`; the Resend HTTP call has a bounded 10s timeout (AC-07) so a hung connection can never block a request indefinitely.
- **File storage** (`server/src/lib/storage/`) — `STORAGE_PROVIDER=local` writes to the local `uploads/` directory (dev default; lost on redeploy to an ephemeral host, refused in production unless explicitly set). `STORAGE_PROVIDER=s3` uses any S3-compatible object store (AWS S3, Cloudflare R2, MinIO — `S3_ENDPOINT` for non-AWS) via `S3_BUCKET`/`S3_REGION`/`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY`.
- **ZATCA secret store** (`server/src/lib/zatca/secretStore/`) — the in-memory dev store is non-durable and refuses to run in production unless `ZATCA_ALLOW_DEV_SECRET_STORE` is explicitly set (never do this in a real deployment). `ZATCA_SECRET_STORE_PROVIDER=aws-secrets-manager` uses AWS Secrets Manager for private-key/CSID credential storage — see the ZATCA environment variable table below for its own required variables.

## ZATCA / FATOORA e-invoicing environment variables

Every variable below is read verbatim by `server/src/lib/zatca/provider/fatooraClient.ts` — MIDAD never hardcodes a ZATCA hostname or path. Full reference copy lives in `.env.example`; this table is the launch-time summary. `{ENV}` stands for either `SIMULATION` (ZATCA sandbox) or `PRODUCTION` (live FATOORA gateway) — each environment's EGS units are configured independently, so both blocks can be set at once.

| Variable | Required? | Secret? | Format | Used by |
| --- | --- | --- | --- | --- |
| `ZATCA_FATOORA_{ENV}_BASE_URL` | **Yes**, before any EGS unit in that environment submits | No (URL) | Base host, e.g. `https://gw-fatoora.zatca.gov.sa/e-invoicing` | Every submit call (clearance + reporting) |
| `ZATCA_FATOORA_{ENV}_COMPLIANCE_PATH` | **Yes**, same as above | No (path) | e.g. `/core/compliance/invoices` | Compliance document checks |
| `ZATCA_FATOORA_{ENV}_CLEARANCE_PATH` | **Yes**, same as above | No (path) | e.g. `/core/invoices/clearance/single` | `clearInvoice` (standard invoices) |
| `ZATCA_FATOORA_{ENV}_REPORTING_PATH` | **Yes**, same as above | No (path) | e.g. `/core/invoices/reporting/single` | `reportInvoice` (simplified invoices) |
| `ZATCA_FATOORA_{ENV}_COMPLIANCE_CSID_PATH` | No — no route calls the CSID-exchange provider methods yet | No (path) | e.g. `/core/compliance` | `requestComplianceCsid` (unused by any route today; reserved for future CSID-exchange work) |
| `ZATCA_FATOORA_{ENV}_PRODUCTION_CSID_PATH` | No — same as above | No (path) | e.g. `/core/production/csids` | `requestProductionCsidOnboarding` / `requestProductionCsidRenewal` (unused by any route today) |
| `ZATCA_FATOORA_{ENV}_API_VERSION` | No — defaults to `"V2"` | No (string) | ZATCA's published API version label | Every FATOORA HTTP call |
| `ZATCA_FATOORA_TIMEOUT_MS` | No — defaults to `15000` | No (integer, ms) | Shared request timeout, both environments | Every FATOORA HTTP call |
| `ZATCA_CSR_ECDSA_CURVE` | **Yes**, before any CSR is generated | No (string) | One of `P-256`, `P-384`, `P-521` | `server/src/lib/zatca/csr/` — refuses to run until set explicitly, since no curve is hardcoded |
| `ZATCA_SECRET_STORE_PROVIDER` | **Yes in production** (or explicit `ZATCA_ALLOW_DEV_SECRET_STORE` opt-out — never use in real production) | No (string) | `aws-secrets-manager` (only supported non-dev value) | `secretStore/index.ts` — private-key/CSID credential storage |
| `ZATCA_SECRETS_MANAGER_REGION` | **Yes** if `ZATCA_SECRET_STORE_PROVIDER=aws-secrets-manager` | No | AWS region, e.g. `eu-west-1` | `awsSecretsManagerStore.ts` |
| `ZATCA_SECRETS_MANAGER_ACCESS_KEY_ID` | **Yes** if using AWS Secrets Manager and not relying on an instance/task role | **Yes — secret** | AWS access key ID | `awsSecretsManagerStore.ts` |
| `ZATCA_SECRETS_MANAGER_SECRET_ACCESS_KEY` | Same as above | **Yes — secret** | AWS secret access key | `awsSecretsManagerStore.ts` |
| `ZATCA_SECRETS_MANAGER_KEY_PREFIX` | No — defaults to `midad/zatca` | No (string) | Secret-name namespace prefix | `awsSecretsManagerStore.ts` |

**Minimum for a real ZATCA Simulation launch:** the four `ZATCA_FATOORA_SIMULATION_*` URL/path variables, `ZATCA_CSR_ECDSA_CURVE`, and a real `ZATCA_SECRET_STORE_PROVIDER` (AWS Secrets Manager credentials) — never the in-memory dev store in a real deployment. The `_PRODUCTION_*` block is only needed once genuinely ready to submit against ZATCA's live gateway, and the `*_CSID_PATH` variables are only needed if/when a future slice wires the CSID-exchange provider methods to a route.

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

**Code-level items:** verified complete as of Slice AC (invoice/quote transaction atomicity, graceful shutdown, database pool bounds, CORS restriction mechanism, security headers, real ZATCA production submission execution layer with AWS Secrets Manager credential storage, Docker image with CI-validated build and a `/ready` HEALTHCHECK, and the full existing test/typecheck/build gate).

**Deliberately deferred (not launch blockers):** general rate limiting beyond auth endpoints, error-tracking service integration (see below).

**Error tracking provider: NOT CONFIGURED.** No Sentry (or equivalent) package, DSN, or environment variable exists anywhere in this repository — there is nothing to point it at without an account/DSN, and inventing one would violate the standing rule never to fabricate a service integration. Structured logs + request IDs remain the baseline for diagnosing a customer-reported issue; this is not a launch blocker.

**Genuinely external, unverifiable from this repository:** production database provider/backups/PITR/restore-testing, production client/API hosting + domain + HTTPS + the resulting CORS origin value, and CI branch protection on the repository's default branch (a GitHub repository setting, not something any file in this repo can prove or configure — verify directly in GitHub: Settings → Branches → Branch protection rules). These require an actual infrastructure decision and account/repository-admin access this session does not have.
