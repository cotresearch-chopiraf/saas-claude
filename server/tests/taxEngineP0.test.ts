import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";

// Regression tests for the 4 confirmed P0 findings in
// TAX_COMPLIANCE_RED_TEAM_AUDIT.md (TC-01 through TC-04). TC-05 was graded
// P1 and is explicitly out of scope per the approved Phase 1 plan.

vi.mock("../src/lib/mailer.js", () => ({ sendMail: vi.fn() }));
import { sendMail } from "../src/lib/mailer.js";

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

let ownerToken: string;
let memberToken: string;

beforeAll(async () => {
  await resetDb();

  const ownerRes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Tax P0 Co", name: "Owner", email: uniqueEmail("taxp0-owner"), password: "password123" });
  expect(ownerRes.status).toBe(201);
  ownerToken = ownerRes.body.token;

  const profileRes = await request(app)
    .post("/api/compliance/profile")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ countryCode: "SA" });
  expect(profileRes.status).toBe(201);

  const inviteRes = await request(app)
    .post("/api/company/invites")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ email: uniqueEmail("taxp0-member"), role: "member" });
  expect(inviteRes.status).toBe(201);
  const mailCall = (sendMail as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
  const inviteToken = (mailCall[2] as string).match(/token=([a-f0-9]{64})/)![1];
  const acceptRes = await request(app)
    .post("/api/auth/accept-invite")
    .send({ token: inviteToken, name: "Member", password: "memberpass123" });
  expect(acceptRes.status).toBe(201);
  memberToken = acceptRes.body.token;
});

describe("TC-01: a quote's own frozen tax snapshot is used consistently on list, public view, and PDF", () => {
  it("a taxed quote's list-endpoint totals reflect its own taxRatePercent, not a hardcoded 0", async () => {
    const createRes = await request(app)
      .post("/api/quotes")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        clientName: "KSA Quote Client",
        projectName: "KSA Job",
        taxCategory: "standard_rate",
        items: [{ description: "Renovation work", amount: 1000 }],
      });
    expect(createRes.status).toBe(201);
    expect(Number(createRes.body.taxRatePercent)).toBe(15);

    const listRes = await request(app).get("/api/quotes").set("Authorization", `Bearer ${ownerToken}`);
    const row = listRes.body.quotes.find((r: { id: string }) => r.id === createRes.body.id);
    expect(row.taxAmount).toBe(150);
    expect(row.total).toBe(1150);
  });

  it("the public quote view exposes the frozen tax total once sent, not the untaxed subtotal", async () => {
    const createRes = await request(app)
      .post("/api/quotes")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        clientName: "Public Tax Client",
        projectName: "Public Job",
        taxCategory: "standard_rate",
        items: [{ description: "Work", amount: 2000 }],
      });
    await request(app)
      .patch(`/api/quotes/${createRes.body.id}/send`)
      .set("Authorization", `Bearer ${ownerToken}`);

    const publicRes = await request(app).get(`/api/public/quotes/${createRes.body.publicToken}`);
    expect(publicRes.status).toBe(200);
    expect(publicRes.body.taxRatePercent).toBe(15);
    expect(publicRes.body.total).toBe(2300);
  });

  it("an untaxed quote (no taxCategory) still shows a plain sum everywhere — backward compatible", async () => {
    const createRes = await request(app)
      .post("/api/quotes")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ clientName: "No Tax Client", projectName: "Plain Job", items: [{ description: "Work", amount: 500 }] });
    expect(createRes.body.taxRatePercent).toBeNull();

    const listRes = await request(app).get("/api/quotes").set("Authorization", `Bearer ${ownerToken}`);
    const row = listRes.body.quotes.find((r: { id: string }) => r.id === createRes.body.id);
    expect(row.taxAmount).toBe(0);
    expect(row.total).toBe(500);
  });

  it("PDF generation still succeeds for a taxed quote after the fix", async () => {
    const createRes = await request(app)
      .post("/api/quotes")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        clientName: "PDF Client",
        projectName: "PDF Job",
        taxCategory: "standard_rate",
        items: [{ description: "Work", amount: 100 }],
      });
    const pdfRes = await request(app)
      .get(`/api/quotes/${createRes.body.id}/pdf`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(pdfRes.status).toBe(200);
    expect(pdfRes.headers["content-type"]).toBe("application/pdf");
  });
});

describe("TC-02: only an owner may set an explicit taxRatePercent on invoice creation", () => {
  it("a member is rejected when passing an explicit taxRatePercent", async () => {
    const res = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ clientName: "Member Override Attempt", taxRatePercent: 1, items: [{ description: "x", amount: 100 }] });
    expect(res.status).toBe(403);
  });

  it("a member CAN still create an invoice via the engine-computed path (no explicit rate)", async () => {
    const res = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ clientName: "Member Engine Path", items: [{ description: "x", amount: 100 }] });
    expect(res.status).toBe(201);
    expect(Number(res.body.taxRatePercent)).toBe(15);
    expect(res.body.taxCategory).toBe("standard_rate");
  });

  it("an owner CAN still set an explicit taxRatePercent (the old escape hatch, now gated)", async () => {
    const res = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ clientName: "Owner Override", taxRatePercent: 7, items: [{ description: "x", amount: 100 }] });
    expect(res.status).toBe(201);
    expect(Number(res.body.taxRatePercent)).toBe(7);
  });
});

describe("TC-03: concurrent creates for the same setting never leave more than one open-ended active override", () => {
  // Note: it is legitimate for MORE THAN ONE of N concurrent creates to
  // succeed (201) — a create that runs after an earlier one has already
  // committed correctly closes it and inserts the new "current" value,
  // exactly like two sequential creates would (see createOverride()'s
  // "prior active" handling). What must NEVER happen — the actual TC-03
  // bug, reproduced live in the audit as 4 simultaneously open-ended
  // active rows for one setting key — is more than one row ending up with
  // status='active' AND effectiveTo=null at the same time. That's the
  // invariant this test checks directly against the database, not the
  // HTTP success count.
  it("2x: N concurrent creates for the same settingKey never leave 0 or 2+ open-ended active rows", async () => {
    for (let trial = 0; trial < 2; trial++) {
      const settingKey = "vat.standardRatePercent";
      const body = { settingKey, value: 16, effectiveFrom: "2026-01-01", reason: `race trial ${trial}` };

      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          request(app).post("/api/compliance/overrides").set("Authorization", `Bearer ${ownerToken}`).send(body),
        ),
      );
      const successes = results.filter((r) => r.status === 201);
      const conflicts = results.filter((r) => r.status === 409);
      // Every one of the 4 concurrent requests must resolve to exactly one
      // of these two outcomes — never a 5xx crash, never something else.
      expect(successes.length + conflicts.length).toBe(4);
      expect(successes.length).toBeGreaterThanOrEqual(1);

      const openRows = await db.query.companyTaxOverrides.findMany({
        where: (o, { and: a, eq: e, isNull: n }) => a(e(o.settingKey, settingKey), e(o.status, "active"), n(o.effectiveTo)),
      });
      expect(openRows).toHaveLength(1);

      // Clean up: reset the one row left open, so the next trial (and
      // TC-04 below) starts from a clean "no open-ended active override" state.
      await request(app)
        .post(`/api/compliance/overrides/${openRows[0].id}/reset`)
        .set("Authorization", `Bearer ${ownerToken}`);
    }
  });
});

describe("TC-04: resetting the same override concurrently never double-applies the reset", () => {
  it("two simultaneous reset calls on the same override: exactly one succeeds", async () => {
    // A fresh company, isolated from the shared ownerToken's state above —
    // this test only cares about one override's own reset race, not
    // anything about what TC-03's trials left behind.
    const ownerRes = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "Tax P0 TC04 Co", name: "Owner", email: uniqueEmail("taxp0-tc04"), password: "password123" });
    expect(ownerRes.status).toBe(201);
    const tc04Token = ownerRes.body.token as string;
    const profileRes = await request(app)
      .post("/api/compliance/profile")
      .set("Authorization", `Bearer ${tc04Token}`)
      .send({ countryCode: "SA" });
    expect(profileRes.status).toBe(201);

    const createRes = await request(app)
      .post("/api/compliance/overrides")
      .set("Authorization", `Bearer ${tc04Token}`)
      .send({ settingKey: "vat.standardRatePercent", value: 12, effectiveFrom: "2026-02-01", reason: "TC-04 setup" });
    expect(createRes.status).toBe(201);
    const overrideId = createRes.body.override.id as string;

    const reset = () =>
      request(app).post(`/api/compliance/overrides/${overrideId}/reset`).set("Authorization", `Bearer ${tc04Token}`);

    const [r1, r2] = await Promise.all([reset(), reset()]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 404]);
  });
});
