# MIDAD — Architecture Map (Phase 0, Read-Only)

**Status: discovery only. Nothing in this document was produced by modifying code — every claim below is grounded in a fresh read of the repository at commit time.**

## A. Repository shape

npm workspaces monorepo, two packages:

```
saas-claude/
├── server/     Express 4 + TypeScript + Drizzle ORM + PostgreSQL
├── client/     React 18 + Vite + TypeScript + Tailwind CSS
├── docs/       (this audit)
└── .github/workflows/ci.yml
```

No `apps/`, `packages/`, or micro-service split — a single backend process, a single SPA. No monorepo tool (Nx/Turborepo) beyond plain npm workspaces.

## B. Frontend

- **Framework:** React 18, `react-router-dom` v6 for routing (client-side only, no SSR/RSC).
- **Build:** Vite 5.
- **Styling:** Tailwind CSS 3, no component library (no MUI/Chakra/shadcn) — hand-built components in `client/src/components/`.
- **State management:** **none** — no Redux/Zustand/React Query/SWR. Every page (`client/src/pages/*.tsx`) fetches its own data via a thin `apiFetch` wrapper (`client/src/api/client.ts`) inside `useEffect`, holds it in local `useState`. This is consistent everywhere it was checked (e.g. `Settings.tsx`).
- **Auth:** JWT stored client-side (`getToken()` in `api/client.ts`), attached as `Authorization: Bearer` on every request. `AuthContext.tsx` provides `useAuth()`.
- **i18n/localization:** a single `LanguageSelect.tsx` component; no i18n library (no react-i18next). Server-rendered documents (quotes/invoices) carry their own per-document language via `documentHtml.ts`; the app UI itself is Arabic-first, hard-coded Arabic strings throughout the JSX (confirmed in `Settings.tsx` — every label is a literal Arabic string, not a translation key).
- **Routes (complete list, from `App.tsx`):** `/login`, `/register`, `/forgot-password`, `/reset-password`, `/accept-invite`, `/q/:token` (public quote), `/i/:token` (public invoice), `/` (Dashboard), `/projects/:id` (ProjectDetail), `/quotes`, `/invoices`, `/team`, `/settings`. **No route exists for the tax/compliance engine, or for anything in the Construction Control domain (BOQ, procurement, subcontractors, IPC, cash flow, health score, risk, AI).**
- **Mobile:** no PWA manifest, no service worker, no mobile-specific layout found — the app is a standard responsive web SPA, not a dedicated field experience.

## C. Backend

- **Framework:** Express 4 (not Fastify/NestJS/Hono). `express-async-errors` is imported first in `app.ts` specifically so an unhandled rejection in any route handler returns a 500 instead of crashing the whole process (a deliberate fix from an earlier hardening pass, confirmed still in place).
- **Language:** TypeScript, compiled via `tsc` for production (`server/tsconfig.json`), run via `tsx` in development.
- **ORM:** Drizzle ORM 0.33 over `node-postgres` (`pg` 8). Single schema file, `server/src/db/schema.ts` (~530 lines) — no split-by-domain schema files.
- **Migrations:** `drizzle-kit generate` + a custom `migrate.ts` runner. **7 migrations exist (`0000`–`0006`), every one purely additive — no destructive statement (`DROP`, `ALTER ... NOT NULL` on an existing populated column, etc.) found in any of them.** No down-migrations exist for any of the 7 (consistent convention, not a gap introduced now).
- **Validation:** Zod, one schema per route/action, consistently applied at the top of every handler.
- **API style:** REST-ish JSON over HTTP, no GraphQL, no tRPC, no OpenAPI/Swagger spec generated or maintained anywhere in the repo.
- **Background jobs:** **none.** No queue library (no BullMQ/Agenda/pg-boss), no cron, no worker process. Every operation the client sees is synchronous within the HTTP request/response cycle.
- **Notifications:** `lib/mailer.ts`'s `sendMail()` is a `console.log` stub — no real email provider (Resend/SendGrid/SES) is wired up anywhere. No SMS, no push, no in-app notification model exists.
- **File storage:** `multer` disk storage (`lib/uploads.ts`), local filesystem only — used exclusively for company logo upload. No S3/GCS/Azure Blob integration. No generic "attach a file to any record" capability exists.
- **PDF generation:** Playwright/headless Chromium renders an HTML letterhead template (`lib/documentHtml.ts`) to PDF for quotes and invoices — a real browser engine chosen specifically for correct Arabic/French RTL/bidi text shaping. This is document *presentation* only, not a general reporting/BI engine.
- **AI/LLM integration:** **none found anywhere in the repository** — no Anthropic/OpenAI SDK dependency, no prompt files, no AI-related route.
- **Accounting integration:** **none** — no Sage/Qoyod/QuickBooks/Xero SDK or API client of any kind.

## D. Database

PostgreSQL (confirmed via `pg` driver + `postgresql` dialect in `drizzle.config.ts`). Single database, no read replicas or sharding referenced anywhere. Schema currently defines **24 tables** (see `MIDAD_CURRENT_STATE_AUDIT.md` for the full enumeration and capability trace):

`companies, users, projects, budget_items, expenses, tasks, change_orders, daily_logs, password_reset_tokens, company_invites, quotes, quote_items, invoices, invoice_items, compliance_rule_versions, company_compliance_profiles, company_tax_overrides, compliance_audit_events, company_tax_identifiers`

(19 base tables plus enums; the 5 compliance tables were added in the most recent phase of work, migration `0006`.)

**Indexing:** confirmed (carried forward from the prior platform audit, still true) — the *only* indexes anywhere in the schema are three `.unique()` constraints (`users.email`, `quotes.publicToken`, `invoices.publicToken`). **No index exists on any foreign key column**, and none was added for the new compliance tables' hot lookup paths either (`company_tax_overrides(company_id, setting_key, status)`, `compliance_rule_versions(country_code, status, effective_from)`) — flagged again here because MIDAD's cost/procurement/progress engines will multiply the number of foreign-keyed join queries well beyond what this schema currently indexes for.

## E. Authentication

JWT (HS256, `jsonwebtoken`), 7-day expiry, single shared secret from `JWT_SECRET` env var, no refresh-token rotation, no revocation list — a leaked token is valid until it naturally expires. `bcryptjs` for password hashing (10 rounds). Password reset and team-invite flows use 256-bit random tokens, SHA-256 hashed at rest, single-use (enforced via an atomic conditional UPDATE, confirmed fixed in the prior remediation phase).

## F. Authorization / tenant / project model

- **Tenant boundary:** the `companies` table. Every other table hangs off `companyId` (directly, or transitively via `projectId → project.companyId`). Every query in every route is scoped by `req.companyId` (derived server-side from the verified JWT, never client-supplied) — confirmed as a genuinely solid, consistently-applied pattern across the whole codebase, re-verified multiple times in prior audit passes this session.
- **Roles:** exactly two — `owner`, `member` (`userRoleEnum` in schema). **No `admin`, `finance_manager`, `accountant`, or project-scoped role exists anywhere.** A single company-wide role governs every user's permissions company-wide; there is no per-project role assignment (i.e., no "this user is only a member on Project A but an approver on Project B").
- **Permission model:** `lib/permissions.ts` — a single, centralized, named-action → allowed-roles map (`PERMISSIONS` object), enforced via a `requirePermission(action)` middleware that re-reads the user's role from the database on every request (not trusted from the JWT). Currently covers exactly 7 actions: `changeOrder.approve`, `invoice.send`, `invoice.markPaid`, `quote.send`, `project.delete`, `company.manage`, `compliance.manage`. **This is a real, reusable, centralized authorization primitive — the correct foundation to extend for MIDAD's much larger action surface (procurement approvals, IPC approvals, budget approvals, etc.), not something that needs to be replaced.**
- **Project model:** `projects` table is flat — `id, companyId, name, clientName, address, status (active/on_hold/completed), budgetTotal, startDate`. No parent/child project hierarchy, no WBS, no multi-phase/multi-package structure, no site/branch concept.

## G. Testing

Vitest + Supertest, run against a **real** Postgres database (not mocked), with a `resetDb()` `TRUNCATE`-based helper between tests. `fileParallelism: false` in `vitest.config.ts` because test files share one DB. 13 test files, confirmed passing as of the last full run in this session (82/82 including the new compliance suite). Genuine integration tests (real HTTP via `supertest(app)`, real DB writes) — not unit tests with mocked layers. No frontend tests found anywhere in `client/`.

## H. CI/CD

`.github/workflows/ci.yml` (added in the prior remediation phase): installs dependencies, installs Playwright's Chromium, typechecks, runs migrations against a Postgres service container, runs the test suite, builds. Triggers on push to `main` and on pull requests. No deployment step, no staging environment, no infrastructure-as-code (no Terraform/Pulumi/CDK) found anywhere in the repository — deployment target is undetermined from the repository alone.

## I. Observability

`lib/logger.ts` — a minimal structured JSON logger (no external dependency), wired into the global error handler and into every authorization denial and financial mutation across the routes that were touched during the prior remediation and compliance phases. No APM, no error-tracking SDK (Sentry or equivalent), no metrics/tracing.

## J. Summary judgment for Phase 0 purposes

The existing system is a **clean, well-tested, single-tenant-boundary-correct MVP for a small renovation-contractor's back office**: auth, team, projects, a flat budget/expense tracker, tasks, change orders (with real budget-impact math, confirmed atomic under concurrency in the prior audit), daily site notes, quotes and invoices (with a genuinely well-built, GCC-aware tax engine now layered underneath, itself carrying 4 confirmed P0 bugs per the just-delivered `TAX_COMPLIANCE_RED_TEAM_AUDIT.md`). It has **no BOQ, no cost-code hierarchy, no procurement, no supplier, no subcontractor, no committed-cost, no forecast, no owner/subcontractor IPC workflow, no progress/earned-value engine, no cash-flow module, no project-health score, no risk engine, no approval-workflow engine beyond the RBAC gate, no document/evidence system beyond a logo upload, no AI, and no mobile field experience.** This is not a criticism of what exists — what exists is solid for what it is — it is the honest starting line for the MIDAD transformation's Phase 0 gap analysis, detailed capability-by-capability in `MIDAD_CURRENT_STATE_AUDIT.md`.
