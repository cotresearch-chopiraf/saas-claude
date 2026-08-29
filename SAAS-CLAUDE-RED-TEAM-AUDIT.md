# SaaS-Claude — Adversarial Pre-Production Red-Team Audit

**Audit mode:** Read-only. No source file, schema, migration, config, or dependency was modified during this audit. No commit, push, or PR was created.
**Repository:** `cotresearch-chopiraf/saas-claude` (audited standalone, on its own merits — no comparison to any other project).
**Audited commit:** `87b7b5d814be58fcd71ec51a3173102108016119`, branch `main`, working tree clean at time of audit.
**Auditor posture:** Adversarial. Default assumption was UNSAFE UNTIL PROVEN SAFE. No claim in code comments, README, or prior reports was trusted without independent verification.

---

## EXECUTIVE VERDICT

### **NOT PRODUCTION READY**

The codebase is a competently structured, cleanly typed MVP with genuinely solid tenant isolation and a real (non-mocked) passing test suite. It is **not safe for paid customers or financial reliance today**. Three classes of confirmed, dynamically-reproduced defects — an unprotected budget read-modify-write race that silently drops real money from a project's budget, a complete absence of role enforcement on every financially significant action (any invited "member" account has full owner-level financial power), and unrounded floating-point arithmetic in the tax/revenue figures shown to users — are each independently sufficient to block financial reliance. None of these require an architectural rewrite; all are fixable in days, not weeks. This verdict reflects the code as it exists on the audited commit, not the team's ability to fix it.

---

## A. VERIFIED BASELINE

All commands below were executed by the auditor in this session, against a disposable, newly created Postgres database (`audit_test`, same local Postgres 16 instance, distinct from any pre-existing dev database) and a locally created, untracked `server/.env` (not part of the git tree, not committed). This satisfies the mission's "use a disposable/test database" / "run the app locally" allowances without touching any tracked file or real data.

| Check | Command | Result |
|---|---|---|
| Git state | `git log -1`, `git status` | `87b7b5d8...`, branch `main`, clean working tree |
| Typecheck (server + client) | `npm run typecheck` | **PASS** — zero errors, both workspaces |
| Build (server + client) | `npm run build` | **PASS** — `tsc` + `vite build` both succeed, output produced |
| Test suite | `npm test` (server, `vitest run`) | **PASS — 22/22 tests, 6 files**, run against real Postgres, not mocked |
| Lint | — | **No lint script, no ESLint config anywhere in the repo.** Not run because it does not exist. |
| CI/CD | `.github/workflows` | **Does not exist.** No CI pipeline of any kind. |
| Migrations | `server/drizzle/*.sql` | 6 migration files present, applied cleanly to the audit database |
| Dependencies | `server/package.json` | No `helmet`, no `express-rate-limit`-equivalent beyond one hand-rolled limiter, no `pino`/structured logging, no APM/error-tracking SDK |

**Note on test suite quality:** the 22 tests are real integration tests against a real Postgres instance (`fileParallelism: false` specifically because test files share one DB). They correctly cover: tenant isolation on projects/budgets, the numbering off-by-one regression, the crash-hardening (`express-async-errors`) fix, and basic invoicing flows. They do **not** cover: concurrent requests (no test issues two simultaneous requests anywhere), role-based authorization (no test asserts a "member" is blocked from a financially significant action), or floating-point rounding at scale. This is stated plainly, not to disparage the suite, but because the mission requires evaluating whether tests protect the invariants that matter — they protect correctness-on-the-happy-path, not the concurrency and authorization invariants that turned out to be broken.

---

## B. CRITICAL FINDINGS

| ID | Severity | File | Function/Route | Evidence | Failure/Exploit Scenario | Business Impact | Proof Test | Fix Required |
|---|---|---|---|---|---|---|---|---|
| **F-01** | **CRITICAL** | `server/src/routes/changeOrders.ts:72–83` | `PATCH /projects/:projectId/change-orders/:changeOrderId` | Budget update is a SELECT (line 79–81), a JS addition (line 82), then a separate UPDATE (line 83) — no transaction, no `WHERE budgetTotal = $expected` optimistic guard, no row lock. | Two **different** change orders on the same project, approved concurrently, each read the same starting `budgetTotal`, each add their own delta in JS, and the later UPDATE overwrites the earlier one. **Dynamically reproduced**: project budget 5000, CO X delta=200, CO Y delta=300, approved via `Promise.all` — expected 5500 if safe, actual result **5300** (CO X's +200 was silently lost). | A contractor's project budget silently loses real dollar amounts whenever two change orders are approved close together — the exact scenario a busy PM triggers by approving a backlog of change orders in one sitting from two browser tabs, or two team members approving different change orders within the same minute. This directly corrupts the number a contractor relies on to know if they're over budget. | `node redteam.mjs` §CONCURRENCY RACE #2 — full console output captured, reproducible on demand. | Wrap the read-modify-write in a single `UPDATE projects SET budget_total = budget_total + $delta WHERE id = $id` (atomic SQL increment, no read step) inside a `db.transaction()`, or use `SELECT ... FOR UPDATE`. |
| **F-02** | **CRITICAL** | `server/src/routes/changeOrders.ts`, `invoices.ts` (`/send`, `/mark-paid`), `projects.ts` (`DELETE /:id`) | All financially significant mutation routes | `requireAuth` (company-membership only) is the *only* gate. There is no role check anywhere except `company.ts`'s local `requireOwner` (applied only to company settings/logo/invites). | **Dynamically reproduced** end-to-end: Owner invites a "member". Member accepts. Member then: approves a change order and moves real budget money → **HTTP 200**; sends an invoice to a real client → **HTTP 200**; marks an invoice as **paid** → **HTTP 200**; deletes an entire project → **HTTP 204**. The *only* action correctly blocked was inviting a new owner (403). | Any team member a contractor invites — e.g., a field employee given access to log daily site reports — can single-handedly approve budget-impacting change orders, send client-facing invoices, mark invoices paid (which typically triggers "paid" reporting/reconciliation), and permanently delete an entire project's data. This is not a theoretical privilege-escalation bug; it is the *default, documented, working behavior* of every "member" account. | Isolated script: register owner → invite member → member calls 5 endpoints → all financial ones return 200/204, only owner-invite returns 403. Full console output captured. | Introduce a role-check middleware (or per-route `requireOwner`/`requireRole`) on: change-order approve/reject, invoice send/mark-paid, project delete, and any other route with direct financial or destructive effect. Decide product-side which of these a "member" *should* be allowed to do, and enforce the rest. |
| **F-03** | **HIGH** | `server/src/routes/invoices.ts:39–41, 205` | `GET /invoices` (list), invoice PDF total | `taxAmount = subtotal * (rate/100)`, `total = subtotal + taxAmount`, computed in raw JS `Number` arithmetic with no rounding at any point before the value is returned to the client. | **Dynamically reproduced**: an invoice with items `0.01, 0.10, 0.29, 999999.99, 123456789.99` at tax rate 20.5% returns `taxAmount: 25513642.0279` and `total: 149970432.4079` — **four decimal places on a currency value**, not the two a monetary amount must have. | A contractor viewing this invoice sees a tax figure and total with fractional-cent precision that has no accounting meaning and will not match what is actually collected, deposited, or reported to a tax authority. This is exactly the class of bug the mission calls out by name (0.01, 999999.99, tax=20.5 edge cases). | Direct HTTP test: create invoice, `GET /invoices`, inspect `taxAmount`/`total` fields in the JSON response. Raw output captured above. | Round every computed monetary value to 2 decimal places (or compute in integer cents) at the point it is produced, both in the list endpoint and the PDF-total computation at line 205; apply the same audit to `quotes.ts`'s subtotal computation (same unrounded-float pattern, lower risk since quotes carry no tax field). |
| **F-04** | **HIGH** | `server/src/routes/invoices.ts:127–134` (`mark-paid`) | `PATCH /invoices/:id/mark-paid` | Route checks only `status !== "paid"` — it does not require the invoice to have been `sent` first. | **Dynamically reproduced**: a brand-new `draft` invoice, never sent to any client, was marked `paid` in one call — HTTP 200. | An invoice can be recorded as paid without ever having been delivered to the client, silently corrupting the draft → sent → paid state machine the rest of the product (and the paid-invoice tax/revenue summary feature) assumes holds. | `node statemachine-isolated.mjs` — `Invoice draft -> paid directly (skip 'sent') -> HTTP 200 ... *** DRAFT INVOICE CAN BE MARKED PAID WITHOUT EVER BEING SENT ***` | Require `status === "sent"` as a precondition for `mark-paid`, matching the enforced quote state machine (draft→sent is required before accept/reject, and this *is* correctly enforced for quotes). |
| **F-05** | **MEDIUM** | `server/src/routes/budget.ts` (`POST /expenses`) | `POST /projects/:projectId/budget/expenses` | `budgetItemId: z.string().uuid().optional()` is accepted and inserted with no check that the referenced budget item belongs to the current project or company. | **Dynamically reproduced**: an expense created under Company A's project, with `budgetItemId` set to a budget item belonging to a completely different company (Company B), was accepted — **HTTP 201**. | This is a data-integrity gap, not a tenant-isolation *read* breach (the GET endpoints filter by `projectId`, so Company A cannot see Company B's data through this hole) — but it permanently pollutes the database with a foreign key pointing across tenant boundaries, which will corrupt any future feature that joins `expenses` to `budgetItems` without re-validating the relationship (e.g. a future "expenses by budget category" report). | `redteam.mjs` §CROSS-ENTITY FK INTEGRITY — `*** NO OWNERSHIP VALIDATION *** expense ... created referencing budgetItemId=... (belongs to a DIFFERENT company's project)`. | Validate that `budgetItemId`, when provided, belongs to a budget item whose `projectId` matches `req.params.projectId` before inserting — same pattern already correctly used in `invoices.ts` for `quoteId` validation. |

---

## C. TENANT ISOLATION FINDINGS

**Verdict: SOLID.** This is the one area where static reading and dynamic testing both came back clean.

Every cross-tenant attempt in the dynamic test run — Company B against Company A's project (GET/PATCH/DELETE), Company A's budget, Company A's tasks, Company A's change order (attempted approval), Company A's quote (GET + PDF), Company A's invoice (GET + mark-paid), and a cross-parameter-confusion attempt (`PATCH /projects/{B's project}/budget/items/{A's item id}`) — **all returned HTTP 404**, not 403 or 500. A 404 (rather than 403) is the correct choice here: it reveals nothing about whether the resource exists at all, which is the right anti-enumeration posture.

This holds because every nested router (`budget.ts`, `tasks.ts`, `changeOrders.ts`, `dailyLogs.ts`) applies a router-level `.use()` middleware that re-verifies `project.companyId === req.companyId` before any sub-route executes, and every top-level lookup (`projects.ts`, `quotes.ts`, `invoices.ts`) scopes its `WHERE` clause by both `id` and `companyId` together (never `id` alone). This is a genuine, verified invariant — "prove the complete relationship chain is tenant-safe" is satisfied for every relationship exercised: `project→companyId`, `budgetItem→projectId`, `task→projectId`, `changeOrder→projectId`, `quote→companyId`, `invoice→companyId`.

The one caveat is **F-05** above: the *write*-side `expense.budgetItemId` relationship is not ownership-validated, though it does not translate into a cross-tenant *read* leak given the current read paths.

---

## D. AUTHORIZATION FINDINGS

**Verdict: BROKEN.** See **F-02**. There is exactly one authorization primitive in this codebase — `requireAuth`, which proves "this JWT belongs to *a* member of this company" — and exactly one place a stronger check exists (`requireOwner` in `company.ts`, gating settings/logo/invites). Every other route, including every route with direct financial consequence, uses `requireAuth` alone. The `role` enum (`owner`/`member`) exists in the schema and is checked in exactly one file. This was independently confirmed dynamically for change-order approval, invoice send, invoice mark-paid, and project deletion — all four succeeded as a plain member.

`company.ts`'s member→owner self-escalation path (a member inviting a new "owner") **is** correctly blocked (403) — this is the one authorization boundary in the codebase that works as intended.

---

## E. FINANCIAL INTEGRITY FINDINGS

- **F-03** (unrounded floating-point tax/total) is the primary finding — see table above.
- **Numeric column types are appropriate**: `numeric(12,2)` for money, `numeric(5,2)` for percentages — this is the correct Postgres type choice (not `float`/`double`) and avoids storage-level precision loss. The bug is entirely in the *application-layer* arithmetic that reads these `numeric` columns as JS `Number` and never re-rounds before responding.
- **Tax-rate freezing at invoice creation is correctly implemented and verified**: `invoices.taxRatePercent` is copied from `company.defaultTaxRatePercent` at creation time (confirmed by reading `invoices.ts`'s POST handler) and is never recomputed from the live company setting afterward — a later change to company tax settings does not retroactively alter an already-issued invoice's stored rate. This is a genuine, correctly implemented invariant, not just a comment claim.
- **No partial payments**: an invoice's `status` is a strict `draft`/`sent`/`paid` enum with a single `paidAt` timestamp — there is no way to record a partial payment against an invoice. For a contractor business this is a real product limitation (see Section K), not itself a bug, since nothing in the code claims partial-payment support.

---

## F. CONCURRENCY FINDINGS

All of the following were **actually executed** as concurrent HTTP requests against the live server — not inferred from code alone, per the mission's mandatory-dynamic-test requirement.

| Scenario | Method | Result |
|---|---|---|
| Same change order, 2 simultaneous approve requests | `Promise.all` × 2 | **SAFE** — request 1 → 200, request 2 → 409, budget increment applied exactly once |
| Same change order, 10 simultaneous approve requests | `Promise.all` × 10 | **SAFE** — 1× 200, 9× 409, budget applied exactly once |
| Two **different** change orders on the same project, approved simultaneously | `Promise.all` × 2 | **CONFIRMED LOST UPDATE (F-01)** — expected budget 5500 if safe, actual 5300 |
| Same password-reset token, 2 simultaneous reset-password calls, different new passwords | `Promise.all` × 2 | **SAFE** — request 1 → 200, request 2 → 400 ("invalid or expired"), login with the first new password succeeds |

**Honest accounting of the "safe" results:** the code for both the single-change-order approval path (`changeOrders.ts:57–86`) and the password-reset consumption path (`auth.ts` `reset-password`) has the exact same shape — a SELECT to check current state, followed by a separate, non-transactional UPDATE, with **no** `WHERE status = 'pending'` guard on the UPDATE itself and no unique/atomic constraint enforcing single-use. In both cases, repeated trials (up to 10-way concurrency for the change order) did not reproduce a double-application. This is because, in this environment, the first request's full SELECT→UPDATE round trip on localhost Postgres completes fast enough that the second request's SELECT almost always observes the already-updated state. **This is not the same as the code guaranteeing the invariant** — under different latency conditions (a busier connection pool, a remote database with higher round-trip time, or simply an unlucky scheduling window) the same two SELECTs could both observe "pending"/"unused" before either UPDATE commits, at which point the invariant would fail for the same reason F-01 demonstrably does: **the check and the mutation are not atomic.** This is reported as a **latent, code-level defect that did not reproduce under this test's timing**, distinct from F-01 which *did* reproduce — the required proof standard ("this invariant fails because X can occur before Y") is satisfied logically (the SELECT-then-UPDATE gap is real and code-visible) even though a live failure was not captured for these two specific paths.

The invitation-acceptance path has the same SELECT-then-INSERT shape but is backstopped by the `users.email` UNIQUE constraint at the database level — a genuinely safe fallback (concurrent accept-invite calls with the same invite email would collide on the unique index even if the application-level check races), which is why it was not separately flagged as a concurrency risk.

---

## G. TRANSACTION FINDINGS

**Confirmed by reading every route file in the repository: zero uses of `db.transaction()` anywhere in the codebase.** Every multi-step mutation (change-order approval + budget update, invoice creation + item insertion, quote acceptance, number claiming + document insertion) is a sequence of independent `await db.insert/update(...)` calls with no rollback path.

Concretely, this means: if a multi-step mutation fails partway through (e.g., the quote-item insert after the quote insert throws), the earlier steps are **not rolled back** — the database is left in a partially-written state. The `claimNextNumber` atomic counter (see Section H below) is called *before*, and separately from, the subsequent quote/invoice INSERT — a failure after claiming a number and before the insert completes leaves a **permanent gap** in the numbering sequence (not a collision, a gap — see the numbering audit below for why this specific consequence is acceptable).

This absence of transactions is the single root architectural cause behind F-01 and the latent risk noted in Section F.

---

## H. STATE-MACHINE FINDINGS

Dynamically tested, clean test data, real HTTP calls:

| Transition attempted | Result |
|---|---|
| Quote `draft` → `accepted` (skip `sent`) | **409, blocked correctly** |
| Quote `accepted` → accept again | first 200 (real accept), second **409, blocked correctly** |
| Quote `accepted` → `rejected` | **409, blocked correctly** |
| Invoice `draft` → `paid` directly (skip `sent`) | **200 — VIOLATION, see F-04** |
| Invoice `paid` → mark-paid again | **409, blocked correctly** |
| Change order `approved` → approve again (sequential) | first 200, second **409, blocked correctly** |

Numbering (`server/src/lib/numbering.ts`): `claimNextNumber` uses a single raw SQL `UPDATE ... SET x = x + 1 RETURNING x`, which **is** genuinely atomic at the Postgres level for the purpose of guaranteeing *uniqueness* — two concurrent claims cannot receive the same number. It does **not** guarantee a *gapless* sequence, because (per Section G) the claim is not transactionally bound to the subsequent document insert: a failure after claiming and before inserting burns a number permanently. **State exact guarantee: unique, monotonically increasing, not gapless.** For most jurisdictions' invoice-numbering requirements, gaplessness (not merely uniqueness) is often the actual legal requirement — this is a real business/compliance risk if a contractor's local regulations require strictly sequential, gap-free invoice numbers, independent of whether it is a "bug" in the code's own terms.

---

## I. SECURITY FINDINGS

Verified live against the running server (`curl -I`), not inferred from code alone:

```
HTTP/1.1 200 OK
X-Powered-By: Express
Access-Control-Allow-Origin: *
Content-Type: application/json; charset=utf-8
```

- **No security headers of any kind**: no `Content-Security-Policy`, `X-Frame-Options`, `X-Content-Type-Options`, `Strict-Transport-Security`, or `Referrer-Policy`. `helmet` is not a dependency and is not used. **PRODUCTION GAP.**
- **`X-Powered-By: Express` is leaked** — trivial framework fingerprinting for an attacker, no functional impact on its own.
- **CORS is fully permissive** (`Access-Control-Allow-Origin: *`, confirmed live with an arbitrary `Origin` header echoed back as `*`). Practical exploitability is **lower than it would be with cookie-based auth**, because this app uses a JWT sent via `Authorization: Bearer` header (confirmed in `client` code and `middleware/auth.ts`) rather than an auto-attached cookie — a malicious third-party site cannot silently ride a victim's session the way it could with cookie auth, since it has no way to obtain the token to attach unless it already has some other foothold. It is still a defense-in-depth failure worth fixing (there is no reason a production API needs to accept requests from arbitrary web origins), but this audit does **not** claim it is directly exploitable as CSRF/session-riding given the current auth model — that claim would require demonstrating an actual attack path, which was not found.
- **JWT**: HS256, 7-day expiry, single shared secret from env, **no revocation mechanism** — a leaked or stolen token remains valid for up to 7 days with no way to invalidate it server-side (no token blacklist, no session table). This is a real gap for a system that will hold financial data, though it is a known, common trade-off of stateless JWTs rather than an implementation bug.
- **Password reset / invite tokens**: 256-bit (`randomBytes(32)`), SHA-256 hashed at rest (raw token only ever appears in the outbound link, never stored), correctly single-use in dynamic testing (Section F). Genuinely solid.
- **File upload** (`lib/uploads.ts`): `fileFilter` checks only client-supplied `mimetype` (spoofable — no magic-byte/content-sniffing validation), size-capped at 2MB, SVG is in the allowed list. **On the actual attack path**: uploaded logos are (a) embedded as a `data:` URI directly inside Playwright-rendered PDF HTML — Playwright/Chromium does not execute embedded `<script>` inside an SVG referenced via a `data:` URI `<img src>` in this rendering context, so **no PDF-generation-time XSS was found or is claimed**; and (b) also served directly via `express.static("/uploads", ...)` — navigating a browser directly to `/uploads/logos/<file>.svg` **would** execute an embedded script in that response's own origin. Whether this is exploitable against a real victim depends on deployment topology (is the API served same-origin with the authenticated SPA, or cross-origin?) which this audit could not fully determine from the code alone — reported as **PLAUSIBLE, not CONFIRMED**, since the concrete attack chain (get a victim to click a direct link to an attacker-uploaded SVG on the API's own origin, while that origin also serves session-bearing content) was not demonstrated end-to-end. Recommend validating magic bytes and/or dropping SVG from the allowed logo types regardless, since the theoretical exposure costs little to close.
- **Rate limiting**: confirmed live. `/api/auth/*` (register/login/reset/invite-accept) is correctly rate-limited (10 requests exhausted the budget in testing, subsequent calls correctly returned 429). **Every other route in the application, including the fully public `/api/public/quotes/:token` and `/api/public/invoices/:token` families, has zero rate limiting** — dynamically confirmed with 25 rapid, unauthenticated GETs against a public quote endpoint, **all 25 succeeded**. Given the public PDF endpoints trigger a real headless-Chromium render per request (see next finding), this is a genuine resource-exhaustion exposure, not merely a style nit.

---

## J. PERFORMANCE FINDINGS

- **N+1 query pattern, confirmed by code reading**: `GET /quotes` and `GET /invoices` both do one query for the list, then `Promise.all(rows.map(row => db.query...findMany(items for row)))` — one extra round trip per row. **No pagination exists anywhere in the API** — every list endpoint returns the full table for the company. At the scale a single small contractor company would realistically produce (dozens to low hundreds of quotes/invoices/projects) this is invisible; it becomes a real latency and connection-pool-pressure problem once a company accumulates thousands of documents, which is a plausible multi-year outcome for an active user. **Not measured at actual 10k/100k-row scale** (no such dataset was created — doing so would risk exceeding the audit's time/resource budget for a scale this specific codebase has not yet reached in production), so this is reported as a **reasoned, code-grounded SCALABILITY LIMIT** rather than a benchmarked one — stated as such, not overstated as a measured fact.
- **Indexes, confirmed by reading the full schema (`schema.ts`)**: the *only* indexes in the entire schema are the three `.unique()` constraints (`users.email`, `quotes.publicToken`, `invoices.publicToken`). **There is no explicit index on any foreign key column** (`companyId`, `projectId`, `budgetItemId`, `quoteId`, etc. — Postgres does not automatically index foreign keys) and **no index on `passwordResetTokens.tokenHash` or `companyInvites.tokenHash`**, both of which are looked up by exact-match on every reset/invite request. At MVP scale this is invisible (sequential scans over a few hundred rows are effectively free); it will show up as measurable query latency once any of these tables reach the tens-of-thousands-of-rows range, which — given the target market of many small independent contractor companies rather than one company doing enormous transaction volume — is a plausible multi-year horizon rather than an immediate risk.
- **PDF/Chromium resource exhaustion**: confirmed by code reading (`lib/pdf.ts`) that a single shared `browserPromise` Chromium instance serves all PDF requests, with a new page opened (and reliably closed in a `finally` block — no page-handle leak was found) per render, but **with no concurrency limiter, queue, or cap** on how many pages can be open simultaneously. Combined with the confirmed-zero rate limiting on the public PDF endpoints (Section I), this is a real **resource-exhaustion / availability risk**: a burst of concurrent requests to a public quote/invoice PDF link (which requires no authentication and no token guessing — an attacker who has legitimately seen one link, or is testing their own account, can hit it in a tight loop) could spawn enough simultaneous Chromium pages to degrade or exhaust server memory/CPU for all tenants. This was **not stress-tested to actual failure** in this audit (deliberately, to avoid destabilizing the shared audit environment) — it is classified precisely as **resource exhaustion / availability risk**, not RCE, and not sandbox escape; no such demonstration was attempted or is claimed.

---

## K. DATA MODEL FINDINGS

Answering the mission's job-costing questions directly, from the schema as it exists:

- **Original Contract Value + Approved Change Orders = Revised Contract Value?** Partially computable, not directly stored. `projects.budgetTotal` is mutated in place by each approved change order (Section F/G) — there is no separate `originalContractValue` field preserved. The "original" value could be *reconstructed* by summing the current `budgetTotal` minus every approved `changeOrders.amountDelta` for that project, but the schema does not store or expose this as a first-class figure, and no endpoint computes it. **Answer: not reliably computable as a single query today; requires a derived calculation the codebase does not currently perform.**
- **Budget vs. Committed vs. Actual Cost?** The schema has `budgetItems` (budget) and `expenses` (actual cost, via `expense.budgetItemId` → `budgetItems`). There is **no "committed" concept** anywhere (e.g., outstanding purchase orders or subcontractor commitments not yet invoiced as expenses) — only two of the three standard job-costing categories exist.
- **Billed vs. Collected?** `invoices.status` (`draft`/`sent`/`paid`) with a single `paidAt` timestamp gives a binary billed/collected signal per invoice, but with no partial-payment support (Section E), "collected" cannot diverge from "billed" for a given invoice — it is all-or-nothing.
- **Gross Margin?** Not computable as a stored or derived field anywhere in the schema or routes; would require the contractor to manually combine `budgetTotal`/expense totals against invoice totals themselves.

**This is a genuine PRODUCT GAP for a tool positioned as job-costing/financial software for contractors**, distinct from a bug — nothing in the code claims these figures are available, so this is reported per the mission's classification rules as a product limitation to be prioritized, not a defect to be "fixed."

---

## L. OPERATIONAL READINESS

Per the mission's explicit instruction not to excuse gaps because the project is an MVP:

| Area | Status |
|---|---|
| CI/CD | **Absent.** No `.github/workflows`, no pipeline of any kind. Tests and typecheck are only run manually. |
| Linting | **Absent.** No ESLint config, no lint script. |
| Backups | **Absent.** No backup/restore tooling, script, or documentation found anywhere in the repo. **NOT PRODUCTION READY** on this axis, stated exactly as the mission requires. |
| Observability | **Absent.** No structured logging, no error-tracking SDK (Sentry or equivalent), no metrics/APM. The only "observability" is `console.error(err)` in the generic error handler and `console.log` for dev-mode "emails." |
| File storage | Local disk (`multer` disk storage) for logos — explicitly a stopgap in the code's own comment, correctly self-identified as such; will not survive a redeploy on most hosting platforms (ephemeral filesystem) or work at all in a multi-instance deployment. |
| Data export / account deletion | Not found in the codebase — no GDPR-style export or deletion endpoint. |
| Transactional email | `lib/mailer.ts` only `console.log`s the reset/invite link — **no real email provider is wired up.** This is an external-dependency gap of the same shape as the Stripe gap (Section M), but was **not** named in scope as intentionally deferred by the owner the way Stripe explicitly was — flagged here as a genuine open gap rather than silently assumed deferred. |

---

## M. STRIPE

**STATUS: INTENTIONALLY DEFERRED / BLOCKED BY OWNER.**

No Stripe code exists in the repository, and none was expected or searched for as a defect — per explicit instruction, this is not classified as a bug, and no payment integration, alternate payment provider, or architectural change was implemented or suggested to work around its absence.

**Forward-readiness assessment only** (does the current architecture accept Stripe cleanly later, without a rewrite):

- The per-company `featureFlags` JSONB column (currently `{invoicing: boolean}`) is a reasonable, already-proven mechanism to gate a future `payments`/`billing` flag the same way `invoicing` is gated today — no schema change needed to add the flag itself.
- The `invoices` table's `status` enum and `paidAt` timestamp are a plausible landing spot for a Stripe webhook handler to write into (`sent` → `paid` transition, `paidAt` set from the webhook payload) without restructuring existing tables — a `stripePaymentIntentId` column would be a straightforward additive migration.
- **The one real blocker to raise before wiring Stripe in**: F-01/Section G's absence of transactions is a materially bigger problem once real money movement is involved. A Stripe webhook handler that does multi-step writes (mark invoice paid + record a payment ledger row + adjust any running total) with the same non-transactional pattern used throughout this codebase would carry the identical lost-update risk demonstrated in F-01, applied to actual payment reconciliation instead of an internal budget figure. This is not a reason to delay Stripe further — it is a concrete, scoped prerequisite (introduce `db.transaction()` for any multi-step financial write) worth doing *before*, not after, Stripe webhooks start writing to these tables.

---

## GO / NO-GO GATE

| Question | Answer |
|---|---|
| **PRODUCTION** | **NO** |
| **PAID CUSTOMERS** | **NO** |
| **FINANCIAL RELIANCE** | **NO** |
| **BETA CUSTOMERS** | **NO** (not until BLOCKER-01 through BLOCKER-03 are fixed — a beta contractor's real budget numbers would still be exposed to F-01, and any invited employee would still have full financial control) |
| **INTERNAL USE** (owner + trusted team only, no real client-facing financial commitments made off these numbers) | **YES**, with awareness of BLOCKER-01 through BLOCKER-03 |

### Blockers

- **BLOCKER-01** — Change-order budget updates are not atomic (F-01). Confirmed, reproducible silent loss of budget data under ordinary concurrent use (two change orders approved close together). Must fix before any customer — internal or external — relies on a project's budget figure being correct.
- **BLOCKER-02** — No role enforcement on financially significant actions (F-02). Any invited "member" account has full owner-level power to approve change orders, send invoices, mark invoices paid, and delete projects. Must fix before inviting any team member who is not fully trusted with total financial control is safe.
- **BLOCKER-03** — Unrounded floating-point tax/total figures shown to users (F-03). Must fix before any dollar figure shown or invoiced by this system can be trusted for real accounting.
- **BLOCKER-04** — Invoice state machine allows `draft → paid` directly, bypassing `sent` (F-04). Must fix before "paid" status can be trusted as meaning "this invoice was actually delivered to and paid by a client."
- **BLOCKER-05** — No backups, no CI, no observability (Section L). Must exist before any customer's data is entrusted to this system in a way that would be costly to lose or slow to diagnose.

---

## REMEDIATION QUEUE

**No fixes were implemented as part of this audit. This is an ordered queue only, per the mission's absolute stop condition.**

### P0 — must fix before any external customer

**P0-1 — F-01, change-order budget race**
- *Finding:* Concurrent approval of different change orders on the same project causes a lost update on `projects.budgetTotal`.
- *Root cause:* Read-modify-write (`SELECT budgetTotal` → JS add → `UPDATE`) with no transaction, no row lock, no atomic SQL increment.
- *Required invariant:* The final `budgetTotal` after N concurrent approvals must equal the starting value plus the sum of all N approved deltas, regardless of timing.
- *Recommended fix strategy:* Replace the SELECT+JS-add+UPDATE with a single atomic `UPDATE projects SET budget_total = budget_total + $delta WHERE id = $id RETURNING budget_total`, mirroring the pattern already correctly used in `lib/numbering.ts`. Wrap the change-order status UPDATE and this budget UPDATE in one `db.transaction()`.
- *Tests required:* A concurrency test that approves 2+ different change orders on the same project via `Promise.all` and asserts the final `budgetTotal` equals the exact expected sum — the exact scenario this audit reproduced by hand should become a permanent regression test.
- *Acceptance criteria:* The audit's Concurrency Race #2 scenario, re-run, must produce 5500, not 5300.

**P0-2 — F-02, missing role enforcement**
- *Finding:* No route restricts change-order approval, invoice send/mark-paid, or project deletion to owners.
- *Root cause:* `requireAuth` is the only authorization primitive applied to these routes; the existing `requireOwner` helper in `company.ts` was never extended to other routers.
- *Required invariant:* A "member"-role account can only perform the specific set of actions the product decides members should have (this is a product decision, not purely technical — the fix requires the owner to specify which actions are member-safe).
- *Recommended fix strategy:* Extract `requireOwner` (or an equivalent `requireRole`) into shared middleware; apply it to change-order approve/reject, invoice send/mark-paid, and project delete at minimum, pending the product owner's decision on the full list.
- *Tests required:* A test suite (this audit's isolated `authz-isolated.mjs` scenario formalized) that registers an owner, invites a member, and asserts each financially significant route returns 403 for the member unless explicitly designed to allow it.
- *Acceptance criteria:* Every route in F-02's evidence returns 403 for a plain member, unless the product owner explicitly decides otherwise.

**P0-3 — F-03, unrounded financial output**
- *Finding:* `taxAmount`/`total` computed with unrounded floating point, returning 4-decimal-place currency values.
- *Root cause:* No rounding step after JS floating-point arithmetic in `invoices.ts` (list endpoint and PDF-total computation) and `quotes.ts` (subtotal).
- *Required invariant:* Every monetary value returned by the API has exactly 2 decimal places.
- *Recommended fix strategy:* Round every computed money value to 2 decimals at the point of output (or migrate the arithmetic to integer cents internally).
- *Tests required:* Unit test with the exact edge-case amounts this audit used (0.01, 0.10, 0.29, 999999.99, 123456789.99, tax rates 0/20.5/100) asserting 2-decimal output.
- *Acceptance criteria:* This audit's financial-edge-case request, re-run, returns `taxAmount`/`total` with exactly 2 decimal places.

**P0-4 — F-04, invoice state-machine bypass**
- *Finding:* `mark-paid` allows `draft → paid` directly, skipping `sent`.
- *Root cause:* Precondition check is `status !== "paid"` instead of `status === "sent"`.
- *Recommended fix strategy:* Change the precondition to require `status === "sent"`.
- *Tests required:* This audit's `draft → paid` scenario, formalized as a regression test expecting 409.
- *Acceptance criteria:* A draft invoice cannot be marked paid without first being sent.

### P1 — must fix before paid production

- **P1-1** — F-05: validate `expense.budgetItemId` belongs to the current project before insert, mirroring the existing `quoteId` validation pattern in `invoices.ts`.
  - *Required invariant:* Every foreign key accepted from client input is validated to belong to the caller's own tenant/project before being persisted.
  - *Tests required:* Cross-tenant `budgetItemId` rejection test.
  - *Acceptance criteria:* This audit's F-05 scenario returns 400/404, not 201.
- **P1-2** — Introduce `db.transaction()` for every multi-step financial mutation identified in Section G, closing the latent risk noted in Section F for the password-reset and single-change-order-approval paths, even though neither reproduced a live failure in this audit.
- **P1-3** — Add rate limiting to the public quote/invoice PDF endpoints and a concurrency cap/queue on Chromium page creation in `lib/pdf.ts` (Section J).
- **P1-4** — Add `helmet` (or equivalent) for security headers; restrict CORS to known origins instead of `*`.
- **P1-5** — Stand up backups, CI (at minimum: typecheck + test on every push), and basic error tracking/observability (Section L / BLOCKER-05).

### P2 — should fix before scale

- Add indexes on all foreign key columns and both `tokenHash` columns (Section J).
- Add pagination to `GET /quotes` and `GET /invoices`; eliminate the N+1 pattern.
- Wire a real transactional email provider (currently `console.log`-only).

### P3 — product improvements

- Preserve `originalContractValue` as a first-class field (or a computed endpoint) rather than requiring manual reconstruction (Section K).
- Add a "committed cost" concept distinct from budget/actual.
- Support partial invoice payments rather than a binary paid/unpaid state.
- Validate uploaded logo files by magic bytes, not client-supplied MIME type; consider dropping SVG from the allowed types given the Section I exposure.

### P4 — future enhancements

- Token revocation / session invalidation for JWTs.
- Data export and account-deletion endpoints.
- Real object storage for uploaded logos (already self-identified in the code as a stopgap).

---

*This audit is complete. Per the mission's absolute stop condition: no code was modified, no commit was made, no push was made, and no PR was created. Awaiting explicit approval before any remediation work begins.*
