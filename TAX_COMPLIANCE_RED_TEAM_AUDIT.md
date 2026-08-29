# Tax & Compliance Engine — Red-Team Audit (Production Readiness Gate)

**Mode: READ-ONLY / AUDIT-ONLY.** No source file, schema, migration, test, configuration, country pack, or UI file was modified during this audit. No commit, no push. This report is the only artifact created.

**Scope audited:** the Tax & Compliance Engine as it currently exists in `cotresearch-chopiraf/saas-claude` — the global compliance core (`server/src/lib/compliance/`), 7 country packs (SA, AE, QA, KW, BH, OM, MA), the API layer (`server/src/routes/compliance.ts`), and its integration into `invoices.ts`/`quotes.ts`. **Not yet built and therefore not falsely claimed as audited-and-passing:** the Compliance Center UI (Phase 11), the AI regulatory-research pipeline (Phase 13), a real e-invoicing submission integration, and cross-border/construction-specific tax logic — these are called out explicitly below as NOT IMPLEMENTED, not silently skipped.

**Default assumption per your instruction: NOT PRODUCTION READY unless the evidence says otherwise.** It does not say otherwise. See §37.

---

## 1. Reconstructing the actual system

```
db/schema.ts
  compliance_rule_versions, company_compliance_profiles,
  company_tax_overrides, compliance_audit_events, company_tax_identifiers
  + nullable taxCategory/ruleVersionId/overrideReference on invoices & quotes
        ↓
lib/compliance/packs/{saudiArabia,uae,qatar,kuwait,bahrain,oman,morocco}.ts
  — 7 registered adapters, each: getSeedRules() + getSeedVersionMeta()
        ↓
lib/compliance/packs/index.ts  — registry, Map<CountryCode, Adapter>
        ↓
lib/compliance/publish.ts  — ensureInitialRuleVersion (auto), publishNewRuleVersion (manual, unused by any route)
        ↓
lib/compliance/profile.ts  — createOrReplaceComplianceProfile, getComplianceProfile
        ↓
lib/compliance/engine.ts  — resolveEffectiveRuleVersion, getEffectiveSettingValue,
                              calculateTax, getZakatStatus, getWithholdingRate
        ↓
lib/compliance/overrides.ts  — createOverride, resetOverride, listActiveOverrides, listOverrideHistory
        ↓
lib/compliance/audit.ts  — recordAuditEvent (append-only, no update/delete exposed anywhere)
        ↓
routes/compliance.ts  — GET/POST profile, GET rules/status, GET/POST overrides, POST reset, GET history
        ↓
routes/invoices.ts, routes/quotes.ts  — call calculateTax() at creation, freeze the result
        ↓
UI: NOT BUILT.  AI research pipeline: NOT BUILT (only the safe publish primitive exists).
```

| Claimed feature | Status |
|---|---|
| Global compliance core, no scattered `if (country === ...)` | **IMPLEMENTED** — verified, see §2 |
| Official default / company override / effective value | **IMPLEMENTED**, but **VAT-rate-only** — see §3, §6 |
| Effective dates | **IMPLEMENTED for overrides; UNTESTED for rule-version boundaries** (no second version of any country has ever been published) — see §8 |
| Versioned, immutable rule packs | **IMPLEMENTED** (no route can mutate a published version) — see §9 |
| Historical immutability | **IMPLEMENTED and confirmed**, with one real exception — see §7 |
| Audit trail | **IMPLEMENTED for the override lifecycle; NOT IMPLEMENTED for the invoice/quote explicit-rate escape hatch** — see §18, Finding TC-04 |
| Multi-currency / multi-country tax engine | **IMPLEMENTED**, single source of truth for the *rate* — **NOT fully consistent for the *display*** — see Finding TC-01 (P0) |
| RBAC on compliance settings | **IMPLEMENTED for the compliance API; NOT IMPLEMENTED for invoice/quote creation itself** — see Finding TC-02 (P0) |
| Concurrency safety | **NOT IMPLEMENTED / CONFIRMED BROKEN** — see Findings TC-05, TC-06 (P0)|
| Zakat/withholding/e-invoicing modeling | **PARTIALLY IMPLEMENTED** (data modeled, not wired into any workflow) — see §20, §21 |
| Cross-border logic | **NOT IMPLEMENTED** — see §19 |
| Compliance Center UI | **NOT IMPLEMENTED** |
| AI regulatory-research pipeline | **NOT IMPLEMENTED** (only the manual-publish primitive exists) |

---

## 2. Architecture audit — country-conditional leakage

`grep -rn 'countryCode ===\|country ===\|=== "SA"\|=== "AE"\|=== "QA"\|=== "KW"\|=== "BH"\|=== "OM"\|=== "MA"' server/src` returns exactly two matches, both **inside comments explaining the architecture principle**, zero inside executable code. **VERIFIED: no country-conditional business logic exists outside the pack files.** The registry (`packs/index.ts`) is the single switch point, exactly as specified.

---

## 3. Country pack completeness matrices

Legend: ✅ modeled · ⚠️ partially/narrowly modeled · ❌ not modeled · N/A genuinely not applicable to that country today.

Every country's `verificationStatus` is honestly recorded as **`unverified`** in the data itself — this environment's network egress policy blocked directly fetching every government tax-authority domain tried (zatca.gov.sa, mof.gov.ae, dhareeba.gov.qa, mof.gov.kw, nbr.gov.bh, tms.taxoman.gov.om, tax.gov.ma). All figures below come from cross-corroborated third-party professional tax-advisory sources (Tier 3), not directly-read Tier 1 government text. **No figure in any pack should be relied on for a real filing without a human independently confirming it against the primary source.**

### 🇸🇦 Saudi Arabia (SA)

| Area | Modeled | Value/Note | Confidence |
|---|---|---|---|
| VAT | ✅ | 15%, standard/zero-rated/exempt | Unverified, well-corroborated |
| VAT registration threshold | ❌ | Not modeled anywhere (SAR 375k/187.5k researched but not stored) | — |
| Zero-rated | ⚠️ | Category exists, specific items (exports, medicines, metals) not enumerated | Unverified |
| Exempt | ⚠️ | Category exists, specific items not enumerated | Unverified |
| Out of scope | ❌ | No category | — |
| Withholding | ⚠️ | 4 of ~6+ real categories (dividends/interest/royalties/mgmt fees); "technical services" deliberately omitted due to conflicting sources | Unverified, honestly incomplete |
| Corporate tax | ❌ | Out of scope by design (annual, not per-transaction) | — |
| Zakat | ⚠️ | Correctly flagged `reviewRequired: true`, not calculated | N/A by design |
| E-invoicing | ⚠️ | Profile string + notes only; no submission integration | Not implemented |
| Invoice requirements | ⚠️ | 2 required fields listed, not enforced anywhere in invoice creation | Unverified |
| Tax IDs | ✅ | VAT number, commercial registration (types only, no format validation) | Unverified |
| Reporting | ❌ | No VAT-summary/output-tax report exists | — |
| Construction-specific | ❌ | None | — |
| Cross-border | ❌ | None | — |
| Localization | ✅ | SAR/ar/rtl | — |

### 🇦🇪 UAE (AE)

Same completeness shape as SA. VAT 5%. Withholding correctly modeled as `applicable: false` (a real, sourced 0% fact, not an omission). E-invoicing: Peppol PINT-AE profile noted, phased mandate dates recorded, no submission integration. No VAT registration threshold, no reporting, no construction-specific, no cross-border. Zakat correctly `applicable: false, reviewRequired: false` (not a Zakat jurisdiction in the UAE-federal sense).

### 🇶🇦 Qatar (QA)

**VAT correctly modeled as NOT YET IMPLEMENTED in the country** (`applicable: false`, `standardRatePercent: 0`) — this is a confirmed, well-corroborated fact for the research date, not a gap. Withholding modeled (5%/7% by category). Zero identifiers, zero invoice requirements, zero reporting. E-invoicing: draft law noted as not yet in force.

### 🇰🇼 Kuwait (KW)

**VAT correctly modeled as NOT IMPLEMENTED**, explicitly noted as *ruled out* for the current government term (stronger certainty than Qatar's "not yet"). The one distinctive, product-relevant fact captured: a 5% mandatory "tax retention" on contract payments to incorporated bodies — directly relevant to a construction SaaS, but modeled only as a generic withholding rule, **not wired into any contractor/subcontractor-payment workflow** (no such workflow exists in the app — see §20). Zero identifiers, zero invoice requirements.

### 🇧🇭 Bahrain (BH)

VAT 10% modeled with standard/zero-rated/exempt. The zero-rated note explicitly flags **construction** as a reported zero-rated category — directly relevant, correctly caveated as needing the contractor's own professional confirmation rather than presented as settled fact. Withholding correctly `applicable: false` (current real state; a draft CIT law with possible future non-resident WHT was found but explicitly not modeled since it isn't in force). E-invoicing not yet mandated.

### 🇴🇲 Oman (OM)

VAT 5%. Withholding modeled with the real 2023 Royal Directive nuance (dividends/interest suspended to 0%, royalties/mgmt/services still 10%) — this is a genuinely well-researched, non-trivial distinction, correctly captured rather than flattened to one number. No e-invoicing mandate found.

### 🇲🇦 Morocco (MA)

TVA 20%/10% (post-2026 two-rate reform correctly reflects the *current* simplified structure, with an honest note that the 10% bracket's further deductible/non-deductible sub-split is **not** enumerated). Withholding captures the **scheduled 2027 rate change** (11.25% → 10%) as a note rather than silently locking in a rate that's already known to expire — good practice, but also means **this pack will need a real Phase-2027 update, which the architecture supports (`publishNewRuleVersion`) but which is not automated in any way.** The new July 2026 5% services withholding (directly relevant — subcontractor payments) is modeled. Bilingual (fr/ar) invoice requirement correctly set. Localization defaults to French, matching how Moroccan business actually operates, not silently reusing the Arabic-first GCC default.

**Cross-cutting completeness gap, all 7 countries:** the **override system only supports 2 of the ~15+ settings** each pack actually models (`vat.standardRatePercent`, `vat.applicable` — see `lib/compliance/rules.ts` `OVERRIDABLE_SETTING_KEYS`). Withholding rates, Zakat flags, e-invoicing profile, identifiers, and invoice requirements are **read-only** from the pack — a customer cannot override any of them today, regardless of what the UI (not yet built) might eventually suggest. This should be stated plainly to any customer-facing documentation: "customer override" currently means "VAT rate override," nothing else.

---

## 4–5. Source verification & hard-coded values

Every pack file documents its own `sourceUrl`/`sourceType`/`verificationStatus` inline (see §3). All 7 are `verificationStatus: "unverified"` for the same reason: government domains are not reachable from this environment. **No value was silently converted from "unverified" to an implied "verified" anywhere in the code or API responses** — `GET /compliance/rules` returns the rule document as-is, including nothing that overstates confidence; the report file itself has never claimed "compliant" (see §22).

`grep` for hard-coded numeric rates outside the pack files and `lib/money.ts`: none found in `engine.ts`, `overrides.ts`, `profile.ts`, `routes/compliance.ts`, or `routes/invoices.ts`/`quotes.ts` — every rate flows through a pack file or a stored override row. **VERIFIED clean.**

---

## 6–9. Override system, historical immutability, effective dates, rule versioning — red-team results

### 🔴 Finding TC-01 — P0 — Quote tax display is inconsistent across three read paths, none of which use the quote's own correctly-computed tax

- **Location:** `server/src/routes/quotes.ts` — list endpoint line 28, public view line 193, `buildQuotePdf` line 164.
- **Root cause:** the write path (`POST /quotes`, lines 62–78) was correctly updated to call `calculateTax()` and freeze `taxRatePercent`/`taxCategory`/`ruleVersionId` onto the quote row. **The three read paths were never updated to use these new fields.** The list endpoint and public view both still call `computeTotals(items, 0)` — a hard-coded 0% — and the PDF builder still reads `company!.defaultTaxRatePercent` (the pre-engine, largely-vestigial flat company field, never touched by country selection).
- **Reproduction (CONFIRMED, live server):**
  ```
  Company selects Saudi Arabia. Creates a quote with taxCategory: "standard_rate".
  Stored: quote.taxRatePercent = "15.00", quote.taxCategory = "standard_rate"

  GET /quotes            → { subtotal: 1000 }                    (no tax fields at all — silently 0%)
  GET /public/quotes/:t  → { total: 1000 }                        (client sees NO tax added — expected 1150)
  GET /quotes/:id/pdf    → uses company.defaultTaxRatePercent      (not the quote's own 15%)
  ```
- **Business impact:** A GCC contractor using the Saudi pack creates a quote, the system correctly computes and stores 15% VAT — and then shows the client a total that is **13% lower than what will actually be invoiced**. If the client accepts based on the public quote total and is later invoiced at the correct tax-inclusive amount, this is a direct, visible discrepancy a real customer would notice and be upset about.
- **Financial impact:** every quote that opts into tax via `taxCategory` is displayed wrong everywhere except the raw `GET /quotes/:id` row (which returns the correct stored field but never computes subtotal/tax/total for display).
- **Proof:** `tax-audit-dynamic.mjs`, section "QUOTE TAX-DISPLAY CONSISTENCY" — both assertions failed as reproduced above.
- **Regression test required:** an integration test creating a Saudi-configured quote with `taxCategory: "standard_rate"` and asserting the list, public, and PDF-implied totals all reflect 15% tax — this test does not currently exist (`compliance.test.ts` only asserts the *invoice* path, never the quote read paths).

### 🔴 Finding TC-02 — P0 — Invoice and quote *creation* has no RBAC gate, so a member can set an arbitrary explicit tax rate that completely bypasses the compliance engine, with zero audit trail

- **Location:** `server/src/routes/invoices.ts` line 66 (`invoicesRouter.post("/", async ...)` — no `requirePermission` call), `server/src/routes/quotes.ts` line 53 (same).
- **Root cause:** the previous remediation phase gated `send`/`mark-paid`/`quote.send` to owner-only, but deliberately left *creation* (drafting) open to members — a reasonable call at the time, when the only tax value available was one flat company-wide default. The tax engine's `taxRatePercent` request field (kept for backward compatibility, `invoices.ts` line 57: `z.coerce.number().min(0).max(100).optional()`) is still accepted from **any authenticated member**, takes priority over the engine (line 90–111), and — critically — **is not routed through `createOverride()` at all**, so it produces **zero `compliance_audit_events` row**.
- **Reproduction (CONFIRMED, live server):** a plain member of a Saudi-configured company created an invoice with `taxRatePercent: 0` on a SAR 100,000 line item — **HTTP 201**, invoice stored with 0% tax, no owner approval, no confirmation prompt (the confirmation-required flow in `routes/compliance.ts` only guards the `POST /compliance/overrides` path, which this request never touches). The company's audit history after this action contained only its earlier `profile.created` event — the tax-rate bypass itself is invisible in the compliance audit trail.
- **Business impact:** the entire override/audit/RBAC system built in this phase can be silently routed around by any team member on a per-invoice basis, with no record. A company relying on the Compliance Center (once built) to represent "what tax configuration is in effect" would have no way of knowing individual invoices were issued at a different, unaudited rate.
- **Regulatory impact:** for a jurisdiction with real e-invoicing/audit requirements (Saudi ZATCA, eventual Morocco DGI), an invoice issued at a self-selected, unaudited tax rate by a non-owner employee is exactly the kind of gap a tax authority audit would flag.
- **Recommended remediation (not implemented, per audit-only mode):** either (a) gate the explicit-`taxRatePercent` code path behind `requirePermission("invoice.send")`-equivalent, or (b) route every explicit override through `createOverride()`-equivalent logic so it is audited even when ad hoc, or (c) require owner role specifically when `taxRatePercent` is present in the request body (member creation without an explicit override, i.e. engine-computed, could remain unrestricted).

### 🔴 Finding TC-03 — P0 — Concurrent override creation for the same setting can produce multiple simultaneously-"active" rows, making the effective tax rate non-deterministic

- **Location:** `server/src/lib/compliance/overrides.ts`, `createOverride()`, lines ~48–66 (the `priorActive` SELECT-then-conditional-UPDATE, inside `db.transaction()`).
- **Root cause:** the function reads whether a prior active override exists via a plain `SELECT` (no `FOR UPDATE` row lock, no unique constraint at the database level enforcing "at most one active override per company+settingKey"). Under concurrent requests, multiple transactions can each see "no prior active override" (or the same one) and each successfully `INSERT` a new row with `status: 'active'`.
- **Reproduction (CONFIRMED, live server, direct query verification):** 5 concurrent `POST /compliance/overrides` calls for the same `settingKey`/`effectiveFrom` on one company **all returned 201**. A subsequent `GET /compliance/overrides` showed **4 rows simultaneously `status: "active"`** for the identical setting key and effective date (values 21, 22, 23, 24 all active at once; only the oldest had correctly had its window closed by the newest).
- **Consequence — this is the severe part:** `getEffectiveSettingValue()` resolves ties via `ORDER BY effectiveFrom DESC LIMIT 1`, which does **not** disambiguate rows sharing the same `effectiveFrom` — Postgres does not guarantee tie-break order without an explicit secondary sort key. In the specific run tested, 5 sequential invoice creations all happened to resolve to the same value (22%) — but this is an accident of the query planner/physical row order in this one session, **not a guarantee**, and violates the mission's own required invariant ("same transaction + same rule version = same tax result").
- **Direct parallel to the prior remediation:** this is the exact class of defect (`changeOrders.ts` BLOCKER-01) that the previous remediation phase specifically fixed elsewhere in this codebase using a conditional `UPDATE ... WHERE status = 'pending'` — that pattern was **not applied here**, in brand-new code written after the fix was established.
- **Regression test required:** a concurrency test asserting N concurrent override creations for the same key leave exactly one `active` row — does not currently exist in `compliance.test.ts`.

### 🔴 Finding TC-04 — P0 — Concurrent override reset is not atomic; can produce duplicate resets and duplicate audit events

- **Location:** `server/src/lib/compliance/overrides.ts`, `resetOverride()`, lines ~118–147.
- **Root cause:** identical shape to TC-03 — `SELECT ... WHERE status = 'active'` followed by an **unconditional** `UPDATE ... SET status = 'reset' WHERE id = $id` (no `AND status = 'active'` guard on the UPDATE itself). Unlike `changeOrders.ts`'s decision route (which does apply this guard, established in the previous remediation), this function does not.
- **Reproduction (CONFIRMED, live server, reproduced 2 of 5 clean trials plus the original structured test run):**
  - Trial 3 of 4 clean isolated re-runs: `[200, 200, 404, 404, 404]` — **two** concurrent resets both succeeded, and the audit trail recorded **two** `override.reset` events for one logical user action.
  - The original structured red-team script (`tax-audit-dynamic.mjs`) caught an even tighter race: **5 of 5** concurrent resets returned 200.
  - Two more isolated trials came back clean (1 success, 4 correctly-rejected 404s) — **confirming this is timing-dependent, not deterministic**, exactly matching how the original platform audit characterized the (pre-fix) password-reset race: safe under some timing, broken under tighter timing, and therefore a real defect regardless of how often a given trial happens to look safe.
- **Business impact:** a duplicate reset event doesn't corrupt the final `overrideValue` state (idempotent in that narrow sense), but it does pollute the audit trail with duplicate/contradictory entries attributing the same action to potentially different actors if two different users raced the same reset — directly undermining the audit trail's role as the source of truth for "who changed what, when."

---

### Historical immutability (§7) — CONFIRMED holding, one caveat

Re-verified live: an invoice created while a 15%/8%/6% VAT rate was in effect kept its original stored `taxRatePercent` after a later override changed the active rate — confirmed across 3 separate live trials. **This invariant holds for invoices.** It could not be independently re-verified for **quotes**' *displayed* total, because of Finding TC-01 above (the quote's stored field is correct and immutable; its *display* is not derived from that field at all in two of three read paths, so "does the display stay correct historically" is not a meaningful question until TC-01 is fixed — the stored data itself is safe).

### Effective-date boundary testing (§8) — PARTIALLY VERIFIED

- **Override-level effective dates: CONFIRMED working.** An override with a past `effectiveFrom` correctly applied; a far-future (`2099-01-01`) `effectiveFrom` correctly did not apply to an invoice dated today.
- **Rule-version-level effective dates (old published version vs. a newly published version, the literal 2026-12-31 / 2027-01-01 boundary scenario your mission specifies): UNTESTED.** No country pack in this system has ever had a second version published — `publishNewRuleVersion()` exists and is unit-testable in isolation, but **no API route calls it**, so there is no way to exercise this boundary through the live system at all right now. This is not a confirmed bug; it is an **untested code path with no current attack surface**, which should not be reported as either PASS or FAIL — reported here as **UNVERIFIED**.
- **Timezone handling:** all dates in this system are plain `YYYY-MM-DD` strings compared as Postgres `date` columns — there is no timestamp/timezone dimension to the effective-date logic at all (invoice `issueDate` is `new Date().toISOString().slice(0,10)`, i.e., always UTC-calendar-date). This sidesteps timezone-boundary bugs by construction rather than by design decision — worth noting as UNVERIFIED-BY-INTENT rather than a gap, since no per-company timezone concept exists anywhere in this application.

### Rule versioning immutability (§9) — CONFIRMED safe, but only by absence of an attack surface

No route allows updating, deleting, or otherwise mutating a `compliance_rule_versions` row. The only way to change one is `publishNewRuleVersion()`, callable only from server-side code, not exposed via any HTTP endpoint. **This is safe today because nothing can reach it — not because of an enforced authorization check on a reachable endpoint.** Once an admin/publish UI or AI-pipeline route is built (Phase 13), this needs its own dedicated authorization review; it has none today because it doesn't need one yet.

---

## 10–11. Tax calculation & money-precision red-team

Tested via `compliance.test.ts` and live requests: 0, 0.01, 100%, negative (rejected), >100% (rejected), non-numeric (rejected), the exact large/fractional multi-line-item edge case from the original platform audit (still exactly 2-decimal precise through the engine). **`lib/money.ts`'s cents-based arithmetic is used exclusively — confirmed via grep, no `parseFloat`/raw-float tax math found in `lib/compliance/` or the invoice/quote tax-freezing code paths.**

**Discount handling: NOT IMPLEMENTED.** No `discount` field exists anywhere in the schema (quotes, invoices, or budget items) — "discount before/after VAT" and "tax on tax" scenarios your mission asks to test **do not have a code path to exercise**, because line-item discounts are not a feature of this application at all, pre- or post-tax-engine. This is not a defect introduced by the tax engine; it is a pre-existing absence, correctly out of scope to fabricate a test for.

**Withholding-after-VAT / VAT-after-withholding ordering: NOT IMPLEMENTED.** `getWithholdingRate()` exists as an engine capability but is not called from any route — there is no vendor-payment or subcontractor-payment workflow in this application for withholding to apply to. See §20.

**Malformed date crashes a request with a raw 500, not a validated 400** — see Finding TC-05 below.

### 🟠 Finding TC-05 — P1 — Unvalidated date strings crash compliance requests with a raw 500 instead of a clean validation error

- **Location:** `server/src/routes/compliance.ts` — `createOverrideSchema` (`effectiveFrom: z.string()`, no date-format refinement) feeding directly into `engine.ts`'s Postgres date comparisons; also `GET /compliance/rules?asOf=`, which passes the raw query string with no validation at all.
- **Reproduction (CONFIRMED, server log):**
  ```
  POST /compliance/overrides { effectiveFrom: "not-a-date", ... } → HTTP 500
  GET  /compliance/rules?asOf=not-a-date (company WITH a profile) → HTTP 500
  POST /compliance/overrides/not-a-uuid/reset                     → HTTP 500
  ```
  Server log: `"invalid input syntax for type date: \"not-a-date\""`, `express-async-errors` correctly prevents a process crash (matches the prior remediation's fix), but the client gets a generic, non-actionable 500 instead of a 400 explaining the input was malformed.
- **Severity note:** the malformed-UUID case matches an already-known, pre-existing, app-wide pattern (every route in this codebase has this characteristic for non-UUID path params, confirmed in the original platform audit) — not a new regression, graded P3 on its own. The **malformed-date case is new** to the compliance routes specifically (no other part of this application accepts a user-supplied date into a raw comparison the way `asOf`/`effectiveFrom` do) and is graded P1 for that reason: it's a genuinely new, not-yet-hardened input surface.

---

## 12. Tax engine consistency — mixed result

`calculateTax()` is the **only** place a tax *rate* is ever determined for a new transaction — confirmed by grep, no duplicate rate-determination logic exists elsewhere. `computeTotals()` is the **only** place a rate is combined with amounts into subtotal/tax/total — this two-function split (determine rate once at creation, recompute totals from the frozen rate on every read) is the *correct* design for historical immutability. **However, Finding TC-01 shows the read side was not fully wired to this design for quotes** — the correct architecture exists, but its application to quotes is incomplete.

---

## 13–15. RBAC, tenant isolation, mass assignment — red-team results

- **RBAC on the compliance API itself: CONFIRMED correct.** Member blocked (403) from country selection, override creation, override reset. Owner confirmed able to perform all three (positive control). Member confirmed still able to read `/compliance/status` (read routes correctly ungated).
- **RBAC on invoice/quote creation: BROKEN — see Finding TC-02 (P0) above.**
- **Roles named in your mission that do not exist in this application: `admin`, `finance manager`, `accountant`.** The schema (`db/schema.ts` `userRoleEnum`) and the permission matrix (`lib/permissions.ts` `Role` type) define exactly two roles: `owner`, `member`. These cannot be dynamically tested because there is no code path that recognizes them — reported as **NOT IMPLEMENTED**, not silently assumed equivalent to `owner`/`member`.
- **Tenant isolation: CONFIRMED, re-verified fresh.** Company B cannot read Company A's compliance profile, rules, overrides, or audit history (404s, empty lists, no leakage in JSON payloads). Re-confirmed for invoices specifically in this audit (cross-company invoice read → 404).
- **Mass assignment / ID injection: CONFIRMED safe.** Attempts to inject another tenant's `overrideReference`, a foreign `companyId`, a self-assigned override `id`, or a forged `createdBy` into request bodies were all silently ignored — Zod schemas strip unknown fields, and every write derives ownership from `req.companyId`/`req.userId` (the authenticated context), never from client-supplied values. This is correctly implemented everywhere it was tested.

---

## 16–17. Concurrency & transaction audit

Covered in depth in §6–9 (Findings TC-03, TC-04 — both **CONFIRMED**, both **P0**). One additional, lower-severity observation:

- **`POST /invoices`'s own insert is not transactional**: the invoice row and its `invoiceItems` rows are two separate `db.insert()` calls with no `db.transaction()` wrapper (`routes/invoices.ts` lines 113–139). A failure between the two would leave an invoice with zero line items. This is **pre-existing** (present before the tax engine work, confirmed by reading the same code pattern in `quotes.ts`) and not something this phase introduced — noted for completeness per your instruction to trace every multi-step financial mutation, graded P2 (should fix, not a new regression from this phase).
- The **override creation + audit event IS correctly atomic** (`overrides.ts` wraps both in one `db.transaction()`) — this part of §17's requirement is met.

---

## 18. Audit trail attack

- No route anywhere exposes update or delete against `compliance_audit_events` — confirmed by reading every route in `routes/compliance.ts`. **Append-only by construction, not just by convention.**
- Content fields verified present on a real recorded event: actor (`changedBy`), tenant (`companyId`), old/new value, official default at time, effective dates, rule version, reason, timestamp. **Complete, matches spec.**
- **Gap: the invoice/quote explicit-tax-rate escape hatch produces no audit event at all** (Finding TC-02) — the audit trail is complete for everything that goes through the override system, and silent for everything that doesn't.

---

## 19. Cross-border audit

**NOT IMPLEMENTED.** `calculateTax()` takes only `companyId` (the seller's own tenant) — there is no buyer-country, place-of-supply, or transaction-type parameter anywhere in the engine's interface. Every calculation implicitly assumes seller-country tax treatment applies, which is exactly the naive assumption your mission explicitly warns against ("never assume company country = tax treatment"). This is not a bug relative to what was built — no cross-border feature was attempted this phase — but it is a real, currently-live gap: **a Saudi company invoicing a UAE client today gets Saudi VAT applied with no flag, no review-required state, and no way to indicate the transaction crosses a border.** Reported honestly as NOT IMPLEMENTED, not glossed over as "future architecture only," because the *invoice-creation path is live today* and silently produces a treatment that has not been validated for cross-border correctness.

---

## 20. Construction-specific audit

| Concept | Status |
|---|---|
| Main contractor / subcontractor / supplier / consultant distinction | ❌ NOT IMPLEMENTED — no vendor-type field exists on `expenses` or anywhere else |
| Retention | ❌ NOT IMPLEMENTED — Kuwait's 5% contract retention was researched and modeled as a generic withholding rule, but nothing in `budget.ts`/`expenses` schema represents "amount retained pending a clearance certificate" |
| Advance payment / mobilization | ❌ NOT IMPLEMENTED |
| Progress invoice | ⚠️ PARTIALLY — invoices can be created per-project already (pre-existing), but nothing ties an invoice's tax treatment to a % of contract completion |
| Variation order / change order | ✅ pre-existing feature (`changeOrders.ts`), **not tax-aware** — a change order's `amountDelta` has no tax category or rate of its own |
| Credit note / debit note | ❌ NOT IMPLEMENTED — no such document type exists |
| Withholding on subcontractor payment | ⚠️ engine capability exists (`getWithholdingRate`), **zero integration** — `budget.ts`'s expense-recording flow has no vendor-type field to call it with |

**Honest summary: the tax engine is a generic invoice/quote VAT calculator. None of the construction-specific mechanisms your mission asks about are modeled as first-class concepts anywhere in this phase's work**, beyond the pre-existing, tax-unaware change-order feature.

---

## 21. E-invoicing audit

**Confirmed NOT a compliant e-invoice submission system, and the packs say so themselves.** Every pack's `eInvoicing.notes` field explicitly states the PDF generator is not a compliant submission (verified by reading all 7 pack files). No structured-XML generation, no signing, no ASP/clearance-platform integration, no submission/retry/failure state exists anywhere in the codebase. `eInvoicing.profile` is an inert string (`"zatca_fatoora_phase2"`, `"uae_peppol_pint_ae"`, `"morocco_dgi_clearance"`) with no code that reads it. **Correctly self-disclosed as a gap in the data; correctly absent as a feature in the code.**

---

## 22. Compliance status audit

`GET /compliance/status` returns `status: "configured" | "partially_configured" | "review_required"` — it does **not** use the word "compliant" anywhere in the API response, and no UI exists yet to mislabel it (Phase 11 not built). **No live risk of the "COMPLIANT" mislabeling your mission warns about, because the surface that could do it does not exist yet.** This must be re-audited once the Compliance Center UI is built.

---

## 23. AI regulatory intelligence audit

**NOT IMPLEMENTED.** The only piece of this that exists is `publishNewRuleVersion()` — a safe primitive (supersedes the old version, never mutates it, requires an explicit `publishedBy`) that **nothing calls**. There is no source-collection, no rule-extraction, no comparison, no human-review queue, no AI integration of any kind. This satisfies the mission's hard requirement ("AI must NEVER silently change active financial rules") **trivially, by not existing yet** — not because a safety mechanism was built and verified. Report this distinction honestly rather than claiming the safety property was "tested."

---

## 24–25. UI/UX and API red-team

**UI: NOT IMPLEMENTED.** No Compliance Center, no country picker, no override dashboard exists in `client/src/` — confirmed by directory listing.

**API red-team (what does exist):**
- Malformed/extra/unknown fields: Zod `safeParse` correctly rejects or strips them everywhere tested.
- Wrong types (boolean for a rate, null): correctly rejected with 400.
- Huge numbers (`1e308`): correctly rejected with 400 (fails the `<= 100` bound).
- Invalid UUIDs, malformed dates: **500, not 400 — Finding TC-05.**
- Missing required fields: correctly rejected with 400.
- Unauthenticated access: correctly rejected with 401.

---

## 26–30. Error handling, backward compatibility, migration, performance, security headers

- **Error handling:** no stack traces, no SQL, no internal IDs observed in any error response body during this audit — all compliance errors return the same generic Arabic message pattern already established app-wide. Consistent, safe.
- **Backward compatibility: CONFIRMED.** A company with no compliance profile creates invoices exactly as before (flat company default rate, no tax fields populated) — re-verified live in this audit.
- **Migration:** re-inspected `0006_dear_valkyrie.sql` — purely additive (new tables, new nullable columns), no drops, no destructive statements, matches the repository's existing no-down-migration convention. No new concerns found beyond what was already reported when this migration was authored.
- **Performance: UNVERIFIED, not measured.** `calculateTax()` adds 2 additional queries (`resolveEffectiveRuleVersion` + `getEffectiveSettingValue`) to every invoice/quote creation when a compliance profile exists — not benchmarked at the 10k/100k-record scale your mission asks about, and no index exists on `company_tax_overrides(company_id, setting_key, status)` or `compliance_rule_versions(country_code, status, effective_from)`, both of which are queried on every single tax calculation. At MVP scale this is invisible; flagged honestly as UNVERIFIED-AT-SCALE, consistent with how the original platform audit treated the pre-existing N+1 patterns.
- **Security headers/CORS:** unchanged from the original platform audit's findings (still permissive CORS, no Helmet) — the compliance routes inherit this, they do not add a new gap beyond what already existed and was already reported.

---

## 31–32. Test quality audit — "test the tests"

`compliance.test.ts` (20 tests) does exercise: onboarding, RBAC positive/negative, tenant isolation, override create/reset/history, effective-date future-vs-current, and one historical-immutability case. **Genuinely tests real business behavior, not just implementation details** — assertions check actual computed tax rates and HTTP status codes, not internal function calls.

**What it does NOT cover, confirmed by this audit finding real bugs in exactly these gaps:**
- **No concurrency test for override creation or reset** — this is precisely where TC-03 and TC-04 live; the existing suite would not have caught either.
- **No test of the quote list/public/PDF read paths with a configured tax category** — this is precisely where TC-01 lives; the existing suite only checks the *invoice* read paths, never the quote ones, despite quotes having their own (separately, incompletely wired) tax integration.
- **No test of the member-creates-invoice-with-explicit-rate path** — TC-02 was invisible to the existing suite because no test ever registered a member and had them call `POST /invoices` with an explicit `taxRatePercent`.
- **No malformed-date / malformed-UUID test against any compliance route** — TC-05 was invisible for the same reason.
- **No rule-version-boundary test** (two published versions, transaction on either side of the boundary) — genuinely can't be written yet against the live API since no route publishes a second version; this is an UNVERIFIED code path, not a false-confidence test.

**Verdict on test quality: the tests that exist are good-faith, real, and correctly written for what they cover — but their coverage has clear, identifiable blind spots, and every one of those blind spots is exactly where this audit found a confirmed defect.** This is the "82/82 passing" false-confidence pattern your mission warned about, made concrete: the number was true and the coverage was still insufficient.

---

## 33. Production readiness scoring

| Category | Score /10 | Basis |
|---|---|---|
| Architecture | 8 | Clean adapter pattern, zero conditional leakage, one real design gap (quote read-path wiring) |
| Security | 5 | Tenant isolation and mass-assignment resistance solid; TC-02's audit-trail bypass is a real gap |
| RBAC | 5 | Compliance API itself is correctly gated; invoice/quote creation is not (TC-02) |
| Tenant Isolation | 9 | Confirmed clean across every surface tested |
| Financial Precision | 8 | Cents-based arithmetic used consistently; no float-drift found in the engine itself |
| Tax Calculation | 4 | Correct where it's the only source of truth (invoices); confirmed wrong/inconsistent for quotes (TC-01) |
| Historical Integrity | 7 | Confirmed for invoices; the quote-side gap makes this unverifiable end-to-end for quotes |
| Rule Versioning | 6 | Correctly immutable, but the versioning *mechanism* has never been exercised beyond a single seed version |
| Effective Dates | 6 | Override-level confirmed; rule-version-level boundary UNVERIFIED (no attack surface yet) |
| Auditability | 5 | Real and complete for the override system; silently absent for the invoice/quote escape hatch |
| Country Coverage | 6 | All 7 GCC+Morocco packs exist with genuinely researched, differentiated data — but override support is VAT-rate-only across all of them |
| Regulatory Source Quality | 4 | Every source is honestly `unverified`; this is intellectually honest but means zero figures are production-trustworthy without independent human confirmation |
| E-invoicing | 2 | Data modeled, zero submission capability, correctly self-disclosed as such |
| Construction Fit | 2 | Generic invoice tax engine; none of the construction-specific mechanisms are modeled |
| Cross-border | 1 | Not implemented, not flagged as review-required at calculation time — a live gap, not just a missing feature |
| AI Regulatory Safety | 3 | Safe primitive exists; no pipeline exists to test the safety property against |
| API Quality | 6 | Good validation coverage; two confirmed crash-instead-of-400 cases (TC-05) |
| Testing | 6 | Real tests, real coverage gaps that map directly onto the confirmed defects found |
| Performance | 5 | Reasoned, not measured; no indexes added for the new query patterns |
| Operations | 5 | Inherits the platform's existing (already-reported) CI/logging posture; nothing new broken, nothing new hardened either |

**TOTAL: 101 / 200 → Production Readiness: 50.5%**

Not inflated: two P0 concurrency bugs in brand-new code, one P0 financial-display inconsistency, and one P0 RBAC/audit-trail gap are more than enough on their own to hold this at roughly the midpoint regardless of how well-architected the rest is.

---

## 34–36. Findings summary, classification, proof standard

| ID | Severity | Title | Proof standard |
|---|---|---|---|
| TC-01 | **P0** | Quote tax display inconsistent across list/public/PDF, none use the frozen correct rate | **CONFIRMED** — reproduced live, exact values captured |
| TC-02 | **P0** | Invoice/quote creation has no RBAC gate; explicit tax rate bypasses the entire audit trail | **CONFIRMED** — reproduced live as a plain member, audit trail checked and found empty of the bypass |
| TC-03 | **P0** | Concurrent override creation produces multiple simultaneously-active rows; effective rate becomes non-deterministic | **CONFIRMED** — reproduced live, 4 active rows for one key directly queried and shown |
| TC-04 | **P0** | Concurrent override reset is not atomic; duplicate resets and duplicate audit events | **CONFIRMED** — reproduced in 2 of 6 total trials across two separate script runs; timing-dependent, matching the platform's own established pattern for this class of bug |
| TC-05 | **P1** | Unvalidated date/UUID input crashes compliance routes with 500 instead of 400 | **CONFIRMED** — reproduced live, server log captured |
| — | UNVERIFIED | Rule-version effective-date boundary (old version vs. new version) | No live attack surface exists yet to test it — neither PASS nor FAIL, explicitly not claimed either way |
| — | NOT IMPLEMENTED | Cross-border tax treatment | Confirmed absent by reading `engine.ts`'s function signature — no buyer-country parameter exists |
| — | NOT IMPLEMENTED | Construction-specific tax concepts (retention, variation-order tax, subcontractor withholding integration) | Confirmed absent by reading `expenses`/`changeOrders` schema |
| — | NOT IMPLEMENTED | Compliance Center UI, AI regulatory pipeline, real e-invoicing submission | Confirmed absent by directory/code inspection |

---

## 37. Final red-team verdict

# NOT PRODUCTION READY

Two confirmed P0 concurrency defects in the override system, a confirmed P0 financial-display inconsistency on the quote path, and a confirmed P0 gap that lets any team member silently bypass the entire tax-audit trail are each independently sufficient to hold this verdict. None of these require an architectural rewrite — every one of them is a scoped, fixable bug in specific, identified functions, consistent with the mission's own framing that this is about proving what's broken, not declaring the architecture wrong.

---

## 38. Executive summary

**A. Confirmed blockers:** TC-01, TC-02, TC-03, TC-04 (all P0). TC-05 (P1).

**B. Financial integrity risks:** quote totals shown to real clients can silently omit tax that was correctly computed and stored (TC-01); concurrent override activity can make the tax rate applied to a new transaction non-deterministic (TC-03); an unaudited tax rate can be set on any invoice by any member (TC-02).

**C. Security risks:** none found in tenant isolation or mass-assignment resistance (both solid). The RBAC gap (TC-02) is real but is an authorization-*scope* gap (what a member can legitimately reach), not a tenant-isolation breach.

**D. Regulatory risks:** every country pack's data is `unverified` against its primary government source (network-access limitation, honestly disclosed, not hidden); withholding tables are deliberately incomplete where sources conflicted (a correct choice, still a completeness gap); no cross-border logic exists; no country pack's e-invoicing claim goes beyond a data note.

**E. Architecture risks:** none structural — the adapter pattern is clean and violation-free. The concurrency bugs are implementation gaps within an otherwise sound structure, not evidence the structure itself is wrong.

**F. Missing features, explicitly distinguished:**
- *Not implemented:* Compliance Center UI, AI regulatory-research pipeline, real e-invoicing submission, cross-border tax logic, construction-specific tax concepts (retention, variation-order tax, subcontractor withholding), discount/credit-note handling.
- *Partially implemented:* withholding and Zakat (data modeled, zero workflow integration); override system (VAT-rate-only, not the ~15 settings each pack actually models).
- *Future architecture only:* `publishNewRuleVersion()` (a safe, callable, but currently-unused primitive).

**G. Remediation priority (queue only — not implemented in this audit):**
- **P0 — before any further tax-engine work:** fix TC-01 (wire quote reads to the frozen tax fields), TC-02 (gate or audit the explicit-rate escape hatch), TC-03 and TC-04 (apply the same atomic-conditional-UPDATE pattern already used correctly in `changeOrders.ts` to `createOverride`/`resetOverride`).
- **P1 — before commercial use of this engine:** TC-05 (validate dates/UUIDs at the Zod layer before they reach Postgres); add the concurrency and quote-read-path regression tests identified in §31 so these specific defect classes cannot silently regress.
- **P2 — before scale:** add indexes on `company_tax_overrides(company_id, setting_key, status)` and `compliance_rule_versions(country_code, status, effective_from)`; wrap invoice/quote item inserts in a transaction with their parent row.
- **P3 — before claiming broader country/feature completeness:** enumerate zero-rated/exempt items per country rather than leaving the category empty; extend override support beyond VAT rate; add VAT registration thresholds and basic reporting.
- **P4 — future phases, as originally scoped:** Compliance Center UI, AI regulatory pipeline, real e-invoicing submission, cross-border logic, construction-specific tax modeling.

---

## 39. Stop condition

This audit is complete. Per your instruction: **no remediation was implemented, no file was modified, nothing was committed or pushed.** Awaiting explicit authorization before any fix is attempted.
