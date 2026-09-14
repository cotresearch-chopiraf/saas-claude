import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { companies, companyComplianceProfiles, companyTaxOverrides, users } from "../src/db/schema.js";
import { calculateTax } from "../src/lib/compliance/engine.js";

vi.mock("../src/lib/mailer.js", () => ({ sendMail: vi.fn() }));
import { sendMail } from "../src/lib/mailer.js";

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

async function registerOwner(companyName = "Compliance Co") {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ companyName, name: "Owner", email: uniqueEmail("compliance"), password: "password123" });
  return res.body.token as string;
}

async function inviteAndAcceptMember(ownerToken: string) {
  const inviteRes = await request(app)
    .post("/api/company/invites")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ email: uniqueEmail("compliance-member"), role: "member" });
  expect(inviteRes.status).toBe(201);
  const mailCall = (sendMail as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
  const inviteToken = (mailCall[2] as string).match(/token=([a-f0-9]{64})/)![1];
  const accept = await request(app)
    .post("/api/auth/accept-invite")
    .send({ token: inviteToken, name: "Member", password: "memberpass123" });
  expect(accept.status).toBe(201);
  return accept.body.token as string;
}

// One shared company drives every "happy path" test in this describe block,
// in declaration order (register is rate-limited — a real user only
// registers once, so these tests share one company the same way the
// authorization/concurrency regression suites do). Tests that genuinely
// need a second company (tenant isolation, member-vs-owner) get their own
// small describe block below with its own beforeAll.
describe("compliance: country onboarding, tax calculation, overrides, effective dates", () => {
  let token: string;

  beforeAll(async () => {
    await resetDb();
    token = await registerOwner();
  });

  it("lists Saudi Arabia as a supported country", async () => {
    const res = await request(app).get("/api/compliance/countries").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.some((c: { countryCode: string }) => c.countryCode === "SA")).toBe(true);
  });

  it("before onboarding: no profile (404), rules are review_required", async () => {
    const profile = await request(app).get("/api/compliance/profile").set("Authorization", `Bearer ${token}`);
    expect(profile.status).toBe(404);

    const rules = await request(app).get("/api/compliance/rules").set("Authorization", `Bearer ${token}`);
    expect(rules.status).toBe(200);
    expect(rules.body.status).toBe("review_required");
  });

  it("an invoice for a company with NO compliance profile still works exactly as before (backward compatible)", async () => {
    const invoice = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientName: "No Profile Client", items: [{ description: "x", amount: 100 }] });
    expect(invoice.status).toBe(201);
    expect(Number(invoice.body.taxRatePercent)).toBe(0); // company.defaultTaxRatePercent default
    expect(invoice.body.taxCategory).toBeNull();
    expect(invoice.body.ruleVersionId).toBeNull();
  });

  it("selecting Saudi Arabia auto-configures VAT 15% with no manual setup", async () => {
    const res = await request(app)
      .post("/api/compliance/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ countryCode: "SA", legalEntityType: "llc" });
    expect(res.status).toBe(201);
    expect(res.body.countryCode).toBe("SA");
    // Zakat applicability is genuinely undetermined for a fresh SA profile
    // (see saudiArabia.ts) — this MUST surface as review_required, not be
    // silently assumed "configured".
    expect(res.body.status).toBe("review_required");

    const rules = await request(app).get("/api/compliance/rules").set("Authorization", `Bearer ${token}`);
    expect(rules.body.status).toBe("resolved");
    expect(rules.body.rules.vat.standardRatePercent).toBe(15);
  });

  it("an invoice created after selecting Saudi Arabia is taxed at 15% automatically", async () => {
    const invoice = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientName: "KSA Client", items: [{ description: "Renovation work", amount: 1000 }] });
    expect(invoice.status).toBe(201);
    expect(Number(invoice.body.taxRatePercent)).toBe(15);
    expect(invoice.body.taxCategory).toBe("standard_rate");
    expect(invoice.body.ruleVersionId).toBeTruthy();

    const list = await request(app).get("/api/invoices").set("Authorization", `Bearer ${token}`);
    const row = list.body.invoices.find((r: { id: string }) => r.id === invoice.body.id);
    expect(row.taxAmount).toBe(150);
    expect(row.total).toBe(1150);
  });

  it("an explicit taxRatePercent in the request still overrides the engine (preserves the old escape hatch)", async () => {
    const invoice = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientName: "Explicit Client", taxRatePercent: 7, items: [{ description: "x", amount: 100 }] });
    expect(Number(invoice.body.taxRatePercent)).toBe(7);
    expect(invoice.body.taxCategory).toBeNull();
  });

  it("zero_rated invoices are taxed at 0%, not the standard rate", async () => {
    const invoice = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientName: "Export Client", taxCategory: "zero_rated", items: [{ description: "export", amount: 1000 }] });
    expect(Number(invoice.body.taxRatePercent)).toBe(0);
    expect(invoice.body.taxCategory).toBe("zero_rated");
  });

  it("rejects an override on an unknown/non-allowlisted setting key", async () => {
    const res = await request(app)
      .post("/api/compliance/overrides")
      .set("Authorization", `Bearer ${token}`)
      .send({ settingKey: "identifiers.secretBackdoor", value: "hacked", effectiveFrom: "2026-01-01", confirmed: true });
    expect(res.status).toBe(400);
  });

  it("rejects a technically invalid override value (VAT rate out of 0-100 bounds)", async () => {
    const res = await request(app)
      .post("/api/compliance/overrides")
      .set("Authorization", `Bearer ${token}`)
      .send({ settingKey: "vat.standardRatePercent", value: -5, effectiveFrom: "2026-01-01", confirmed: true });
    expect(res.status).toBe(400);
  });

  it("creating an override requires confirmation for a significant deviation, then applies it", async () => {
    const attempt = await request(app)
      .post("/api/compliance/overrides")
      .set("Authorization", `Bearer ${token}`)
      .send({ settingKey: "vat.standardRatePercent", value: 10, effectiveFrom: "2026-01-01" });
    expect(attempt.status).toBe(200);
    expect(attempt.body.status).toBe("confirmation_required");
    expect(attempt.body.officialDefault).toBe(15);

    const confirmed = await request(app)
      .post("/api/compliance/overrides")
      .set("Authorization", `Bearer ${token}`)
      .send({ settingKey: "vat.standardRatePercent", value: 10, effectiveFrom: "2026-01-01", confirmed: true });
    expect(confirmed.status).toBe(201);

    const invoice = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientName: "Override Client", items: [{ description: "x", amount: 100 }] });
    expect(Number(invoice.body.taxRatePercent)).toBe(10);
    expect(invoice.body.overrideReference).toBeTruthy();
  });

  it("historical immutability: an already-finalized invoice's frozen tax rate is untouched by a LATER override change", async () => {
    // The 15% invoice from the "auto-configures VAT 15%" test above,
    // created BEFORE the override to 10% just above, must still read 15%.
    const list = await request(app).get("/api/invoices").set("Authorization", `Bearer ${token}`);
    const kasInvoice = list.body.invoices.find((r: { clientName: string }) => r.clientName === "KSA Client");
    expect(Number(kasInvoice.taxRatePercent)).toBe(15);

    const reread = await request(app).get(`/api/invoices/${kasInvoice.id}`).set("Authorization", `Bearer ${token}`);
    expect(Number(reread.body.taxRatePercent)).toBe(15);
  });

  it("an override with a FUTURE effectiveFrom does not apply to a transaction dated today", async () => {
    const farFuture = "2099-01-01";
    await request(app)
      .post("/api/compliance/overrides")
      .set("Authorization", `Bearer ${token}`)
      .send({ settingKey: "vat.standardRatePercent", value: 3, effectiveFrom: farFuture, confirmed: true });

    const invoice = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientName: "Still Current Rate", items: [{ description: "x", amount: 100 }] });
    // The active (non-future) override is still the 10% one from two tests
    // ago — the far-future override must not apply yet.
    expect(Number(invoice.body.taxRatePercent)).toBe(10);
  });

  it("resetting the active override restores the country default and is itself audited", async () => {
    const active = await request(app).get("/api/compliance/overrides").set("Authorization", `Bearer ${token}`);
    const currentOverride = active.body.find((o: { effectiveFrom: string }) => o.effectiveFrom !== "2099-01-01");
    expect(currentOverride).toBeTruthy();

    const reset = await request(app)
      .post(`/api/compliance/overrides/${currentOverride.id}/reset`)
      .set("Authorization", `Bearer ${token}`);
    expect(reset.status).toBe(200);
    expect(reset.body.status).toBe("reset");

    const historyAfterReset = await request(app).get("/api/compliance/overrides/history").set("Authorization", `Bearer ${token}`);
    const resetRow = historyAfterReset.body.find((o: { id: string }) => o.id === currentOverride.id);
    expect(resetRow.status).toBe("reset"); // row still exists, not deleted

    const auditTrail = await request(app).get("/api/compliance/history").set("Authorization", `Bearer ${token}`);
    // Field is `action` now, not `eventType` — the audit trail was migrated
    // onto the canonical audit_events table (Phase 1 Foundation), which
    // every domain writes to via the same shape.
    const actions = auditTrail.body.map((e: { action: string }) => e.action);
    expect(actions).toContain("override.created");
    expect(actions).toContain("override.reset");
  });
});

describe("compliance: authorization — member cannot manage compliance settings", () => {
  let ownerToken: string;
  let memberToken: string;

  beforeAll(async () => {
    ownerToken = await registerOwner("Authz Compliance Co");
    memberToken = await inviteAndAcceptMember(ownerToken);
  });

  it("member cannot select a country", async () => {
    const res = await request(app)
      .post("/api/compliance/profile")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ countryCode: "SA" });
    expect(res.status).toBe(403);
  });

  it("owner CAN select a country (positive control)", async () => {
    const res = await request(app)
      .post("/api/compliance/profile")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ countryCode: "SA" });
    expect(res.status).toBe(201);
  });

  it("member cannot create an override", async () => {
    const res = await request(app)
      .post("/api/compliance/overrides")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ settingKey: "vat.standardRatePercent", value: 10, effectiveFrom: "2026-01-01", confirmed: true });
    expect(res.status).toBe(403);
  });

  it("member cannot reset an override (owner creates one, member is denied resetting it)", async () => {
    const created = await request(app)
      .post("/api/compliance/overrides")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ settingKey: "vat.standardRatePercent", value: 12, effectiveFrom: "2026-01-01", confirmed: true });
    expect(created.status).toBe(201);

    const res = await request(app)
      .post(`/api/compliance/overrides/${created.body.override.id}/reset`)
      .set("Authorization", `Bearer ${memberToken}`);
    expect(res.status).toBe(403);
  });

  it("member CAN still read compliance status (read-only routes are not owner-gated)", async () => {
    const res = await request(app).get("/api/compliance/status").set("Authorization", `Bearer ${memberToken}`);
    expect(res.status).toBe(200);
  });
});

describe("compliance: tenant isolation", () => {
  let tokenA: string;
  let tokenB: string;
  let overrideIdA: string;

  beforeAll(async () => {
    tokenA = await registerOwner("Tenant Co A");
    tokenB = await registerOwner("Tenant Co B");
    await request(app).post("/api/compliance/profile").set("Authorization", `Bearer ${tokenA}`).send({ countryCode: "SA" });
    const created = await request(app)
      .post("/api/compliance/overrides")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ settingKey: "vat.standardRatePercent", value: 9, effectiveFrom: "2026-01-01", confirmed: true });
    overrideIdA = created.body.override.id;
  });

  it("Company B cannot read Company A's compliance profile, rules, overrides, or audit history", async () => {
    const profileB = await request(app).get("/api/compliance/profile").set("Authorization", `Bearer ${tokenB}`);
    expect(profileB.status).toBe(404); // B has no profile of its own — never A's

    const rulesB = await request(app).get("/api/compliance/rules").set("Authorization", `Bearer ${tokenB}`);
    expect(rulesB.body.status).toBe("review_required"); // NOT Company A's Saudi 15%-minus-override

    const overridesB = await request(app).get("/api/compliance/overrides").set("Authorization", `Bearer ${tokenB}`);
    expect(overridesB.body).toHaveLength(0);

    const historyB = await request(app).get("/api/compliance/history").set("Authorization", `Bearer ${tokenB}`);
    expect(historyB.body).toHaveLength(0);
  });

  it("Company B cannot reset Company A's override by guessing its ID", async () => {
    const resetAttempt = await request(app)
      .post(`/api/compliance/overrides/${overrideIdA}/reset`)
      .set("Authorization", `Bearer ${tokenB}`);
    expect(resetAttempt.status).toBe(404);

    const stillActive = await request(app).get("/api/compliance/overrides").set("Authorization", `Bearer ${tokenA}`);
    expect(stillActive.body.find((o: { id: string }) => o.id === overrideIdA)?.status).toBe("active");
  });
});

// Red-Team Production Readiness Audit, Wave 1A — country override
// isolation. Before this fix, getEffectiveSettingValue (engine.ts) matched
// an active override by companyId + settingKey alone, with no check that
// the override's own country still matched the company's CURRENT country
// — a Saudi-era override survived a switch to Morocco and kept being
// applied there. The fix reads the override's existing ruleVersionId (via
// its ruleVersion relation) and only applies it when that rule version's
// countryCode matches the currently-resolved country — no schema change,
// no data deleted, no override ever reset/closed by a country switch.
describe("compliance: country override isolation (Wave 1A fix)", () => {
  let token: string;
  let saInvoiceId: string;
  let saOverrideId: string;

  beforeAll(async () => {
    token = await registerOwner("Country Switch Co");
    const profile = await request(app)
      .post("/api/compliance/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ countryCode: "SA" });
    expect(profile.status).toBe(201);
  });

  it("Saudi company + Saudi override: invoice uses the Saudi override rate, not the 15% default", async () => {
    const created = await request(app)
      .post("/api/compliance/overrides")
      .set("Authorization", `Bearer ${token}`)
      .send({ settingKey: "vat.standardRatePercent", value: 10, effectiveFrom: "2026-01-01", confirmed: true });
    expect(created.status).toBe(201);
    saOverrideId = created.body.override.id;

    const invoice = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientName: "SA Client", items: [{ description: "x", amount: 100 }] });
    expect(invoice.status).toBe(201);
    expect(Number(invoice.body.taxRatePercent)).toBe(10);
    saInvoiceId = invoice.body.id;
  });

  it("switching the company to Morocco: the Saudi override can no longer affect Morocco calculations", async () => {
    const switchRes = await request(app)
      .post("/api/compliance/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ countryCode: "MA" });
    expect(switchRes.status).toBe(201);
    expect(switchRes.body.countryCode).toBe("MA");

    const invoice = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientName: "Morocco Client", items: [{ description: "x", amount: 100 }] });
    expect(invoice.status).toBe(201);
    // Morocco's own official default (20%) — never the leaked Saudi 10% override.
    expect(Number(invoice.body.taxRatePercent)).toBe(20);
  });

  it("the stale Saudi override is no longer listed as currently active once on Morocco", async () => {
    const overrides = await request(app).get("/api/compliance/overrides").set("Authorization", `Bearer ${token}`);
    expect(overrides.status).toBe(200);
    expect(overrides.body.find((o: { id: string }) => o.id === saOverrideId)).toBeUndefined();
  });

  it("a Morocco override only applies to Morocco, and does not leak back to Saudi after switching again", async () => {
    const maOverride = await request(app)
      .post("/api/compliance/overrides")
      .set("Authorization", `Bearer ${token}`)
      .send({ settingKey: "vat.standardRatePercent", value: 15, effectiveFrom: "2026-01-01", confirmed: true });
    expect(maOverride.status).toBe(201);

    const maInvoice = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientName: "Morocco Override Client", items: [{ description: "x", amount: 100 }] });
    expect(Number(maInvoice.body.taxRatePercent)).toBe(15);

    const switchBack = await request(app)
      .post("/api/compliance/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ countryCode: "SA" });
    expect(switchBack.status).toBe(201);

    // The original Saudi override (10%) reapplies exactly as before — it
    // was never deleted or reset by either country switch — and the
    // Morocco-only override (15%) must not leak into this Saudi context.
    const saInvoiceAgain = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientName: "Back to Saudi Client", items: [{ description: "x", amount: 100 }] });
    expect(Number(saInvoiceAgain.body.taxRatePercent)).toBe(10);
  });

  it("historical invoice from before the country switch keeps its original frozen tax rate", async () => {
    const reread = await request(app).get(`/api/invoices/${saInvoiceId}`).set("Authorization", `Bearer ${token}`);
    expect(reread.status).toBe(200);
    expect(Number(reread.body.taxRatePercent)).toBe(10);
  });
});

// Red-Team Remediation Wave 1B: routes/invoices.ts's tax-fallback fix
// distinguishes calculateTax()'s reviewReason values, but two of them
// (unresolvable_vat_rate, no_published_rule_version_for_date) aren't
// reachable through any current legitimate HTTP path — every published
// country pack always defines a numeric standardRatePercent, and
// createOverride's own technical validation rejects a non-numeric
// override value, while invoice creation always uses today's date, which
// every pack's published rule version already covers. These two tests
// exercise calculateTax() directly instead of inventing an artificial
// HTTP scenario the application can't actually produce.
describe("compliance engine: reviewReasons not reachable via HTTP (Wave 1B coverage)", () => {
  beforeEach(resetDb);

  it("no_published_rule_version_for_date: a transaction dated before any published rule version", async () => {
    const token = await registerOwner("Old Date Co");
    const profileRes = await request(app)
      .post("/api/compliance/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ countryCode: "SA" });
    expect(profileRes.status).toBe(201);

    const company = await db.query.companies.findFirst({ where: eq(companies.name, "Old Date Co") });
    const result = await calculateTax({
      companyId: company!.id,
      transactionDate: "1900-01-01",
      taxCategory: "standard_rate",
      itemAmounts: [100],
    });
    expect(result.status).toBe("review_required");
    expect(result.reviewReason).toBe("no_published_rule_version_for_date");
  });

  it("unresolvable_vat_rate: an override whose value cannot be resolved to a number", async () => {
    const token = await registerOwner("Bad Override Co");
    const profileRes = await request(app)
      .post("/api/compliance/profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ countryCode: "SA" });
    expect(profileRes.status).toBe(201);

    const company = await db.query.companies.findFirst({ where: eq(companies.name, "Bad Override Co") });
    const profile = await db.query.companyComplianceProfiles.findFirst({
      where: eq(companyComplianceProfiles.companyId, company!.id),
    });
    const owner = await db.query.users.findFirst({ where: eq(users.companyId, company!.id) });

    // Bypasses the API entirely (createOverride's validateTechnical would
    // reject this) — the point is to prove the engine's own defensive
    // handling of a row that should never exist via the normal path, not
    // to exercise the override-creation API again.
    await db.insert(companyTaxOverrides).values({
      companyId: company!.id,
      settingKey: "vat.standardRatePercent",
      overrideValue: "not-a-number",
      officialDefaultSnapshot: 15,
      ruleVersionId: profile!.activeRuleVersionId,
      countryCode: "SA",
      status: "active",
      effectiveFrom: "2020-01-01",
      createdBy: owner!.id,
    });

    const result = await calculateTax({
      companyId: company!.id,
      transactionDate: "2026-01-01",
      taxCategory: "standard_rate",
      itemAmounts: [100],
    });
    expect(result.status).toBe("review_required");
    expect(result.reviewReason).toBe("unresolvable_vat_rate");
  });
});
