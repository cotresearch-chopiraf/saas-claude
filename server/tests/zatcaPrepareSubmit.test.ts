import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { invoices } from "../src/db/schema.js";
import { eq } from "drizzle-orm";

// MIDAD ZATCA Slice 4 — /api/zatca/*/prepare and /submit route tests:
// idempotency, tenant isolation, authorization, and the honest
// (never-fabricated) submit outcome given the signing boundary is
// unimplemented in this environment (see lib/zatca/signer/).

vi.mock("../src/lib/mailer.js", () => ({ sendMail: vi.fn() }));
import { sendMail } from "../src/lib/mailer.js";

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

function extractToken(mailBody: string): string {
  const match = mailBody.match(/token=([a-f0-9]{64})/);
  if (!match) throw new Error(`no token found in mail body: ${mailBody}`);
  return match[1];
}

let companyA: string;
let tokenA: string;
let companyB: string;
let tokenB: string;
let memberTokenA: string;

beforeAll(async () => {
  await resetDb();

  const resA = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "ZATCA Submit Co A", name: "Owner A", email: uniqueEmail("zatca-submit-a"), password: "password123" });
  companyA = resA.body.company.id;
  tokenA = resA.body.token;

  const resB = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "ZATCA Submit Co B", name: "Owner B", email: uniqueEmail("zatca-submit-b"), password: "password123" });
  companyB = resB.body.company.id;
  tokenB = resB.body.token;

  const inviteRes = await request(app)
    .post("/api/company/invites")
    .set("Authorization", `Bearer ${tokenA}`)
    .send({ email: uniqueEmail("zatca-submit-member-a"), role: "member" });
  const mailCall = (sendMail as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
  const inviteToken = extractToken(mailCall[2] as string);
  const acceptRes = await request(app)
    .post("/api/auth/accept-invite")
    .send({ token: inviteToken, name: "Member A", password: "memberpass123" });
  memberTokenA = acceptRes.body.token;

  // Company A: complete identity, ready to prepare.
  await request(app)
    .patch("/api/zatca/config")
    .set("Authorization", `Bearer ${tokenA}`)
    .send({ vatNumber: "300000000000003", commercialRegistration: "1010101010" });
});

async function createInvoice(token: string): Promise<string> {
  const res = await request(app)
    .post("/api/invoices")
    .set("Authorization", `Bearer ${token}`)
    .send({ clientName: "Prepare Test Client", clientTaxId: "310000000000003", items: [{ description: "Work", amount: 200 }] });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function createEgsUnit(token: string): Promise<string> {
  const res = await request(app)
    .post("/api/zatca/egs-units")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: "Prepare Test Unit", environment: "simulation" });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

describe("GET /api/zatca/onboarding-status", () => {
  it("a fresh company (no identity, no EGS units) is not_configured", async () => {
    const res = await request(app).get("/api/zatca/onboarding-status").set("Authorization", `Bearer ${tokenB}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("not_configured");
    expect(res.body.identityComplete).toBe(false);
  });

  it("identity complete but no EGS unit is configuration_incomplete", async () => {
    const res = await request(app).get("/api/zatca/onboarding-status").set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.identityComplete).toBe(true);
    expect(res.body.status).toBe("configuration_incomplete");
  });
});

describe("POST /api/zatca/egs-units/:id/invoices/:invoiceId/prepare", () => {
  it("AUTHORIZATION: a member cannot prepare a submission", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const invoiceId = await createInvoice(tokenA);
    const res = await request(app)
      .post(`/api/zatca/egs-units/${egsUnitId}/invoices/${invoiceId}/prepare`)
      .set("Authorization", `Bearer ${memberTokenA}`);
    expect(res.status).toBe(403);
  });

  it("400s with category configuration when the tenant identity is incomplete", async () => {
    const egsUnitId = await createEgsUnit(tokenB);
    const invoiceId = await createInvoice(tokenB);
    const res = await request(app)
      .post(`/api/zatca/egs-units/${egsUnitId}/invoices/${invoiceId}/prepare`)
      .set("Authorization", `Bearer ${tokenB}`);
    expect(res.status).toBe(400);
    expect(res.body.category).toBe("configuration");
  });

  it("TENANT ISOLATION: company B cannot prepare against company A's EGS unit", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const invoiceId = await createInvoice(tokenA);
    const res = await request(app)
      .post(`/api/zatca/egs-units/${egsUnitId}/invoices/${invoiceId}/prepare`)
      .set("Authorization", `Bearer ${tokenB}`);
    expect(res.status).toBe(404);
  });

  it("TENANT ISOLATION: company A's EGS unit cannot prepare company B's invoice", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const foreignInvoiceId = await createInvoice(tokenB);
    const res = await request(app)
      .post(`/api/zatca/egs-units/${egsUnitId}/invoices/${foreignInvoiceId}/prepare`)
      .set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(404);
  });

  it("builds a real submission with a real ICV/PIH/hash and a safe validation result", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const invoiceId = await createInvoice(tokenA);

    const res = await request(app)
      .post(`/api/zatca/egs-units/${egsUnitId}/invoices/${invoiceId}/prepare`)
      .set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(201);
    expect(res.body.alreadyExists).toBe(false);
    expect(res.body.submission.state).toBe("ready_for_submission");
    expect(res.body.submission.icv).toBeGreaterThanOrEqual(1);
    expect(res.body.submission.documentHash).toBeTruthy();
    expect(res.body.submission.subtype).toBe("standard"); // has a clientTaxId
    expect(res.body.validation.valid).toBe(true);
    expect(res.body.validation.sdkVerified).toBe(false); // never fabricated
  });

  it("IDEMPOTENCY: a repeated prepare call for the same (EGS, invoice) returns the SAME submission, never claiming a second ICV", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const invoiceId = await createInvoice(tokenA);

    const first = await request(app)
      .post(`/api/zatca/egs-units/${egsUnitId}/invoices/${invoiceId}/prepare`)
      .set("Authorization", `Bearer ${tokenA}`);
    const second = await request(app)
      .post(`/api/zatca/egs-units/${egsUnitId}/invoices/${invoiceId}/prepare`)
      .set("Authorization", `Bearer ${tokenA}`);

    expect(second.status).toBe(200);
    expect(second.body.alreadyExists).toBe(true);
    expect(second.body.submission.id).toBe(first.body.submission.id);
    expect(second.body.submission.icv).toBe(first.body.submission.icv);
  });

  it("a DIFFERENT invoice on the same EGS unit claims the NEXT ICV value, never reusing one", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const invoiceId1 = await createInvoice(tokenA);
    const invoiceId2 = await createInvoice(tokenA);

    const first = await request(app)
      .post(`/api/zatca/egs-units/${egsUnitId}/invoices/${invoiceId1}/prepare`)
      .set("Authorization", `Bearer ${tokenA}`);
    const second = await request(app)
      .post(`/api/zatca/egs-units/${egsUnitId}/invoices/${invoiceId2}/prepare`)
      .set("Authorization", `Bearer ${tokenA}`);

    expect(second.body.submission.icv).toBe(first.body.submission.icv + 1);
    expect(second.body.submission.pih).toBe(first.body.submission.documentHash);
  });
});

describe("POST /api/zatca/submissions/:id/submit", () => {
  async function prepareSubmission() {
    const egsUnitId = await createEgsUnit(tokenA);
    const invoiceId = await createInvoice(tokenA);
    const prepared = await request(app)
      .post(`/api/zatca/egs-units/${egsUnitId}/invoices/${invoiceId}/prepare`)
      .set("Authorization", `Bearer ${tokenA}`);
    return { egsUnitId, invoiceId, submissionId: prepared.body.submission.id as string };
  }

  it("AUTHORIZATION: a member cannot submit", async () => {
    const { submissionId } = await prepareSubmission();
    const res = await request(app)
      .post(`/api/zatca/submissions/${submissionId}/submit`)
      .set("Authorization", `Bearer ${memberTokenA}`);
    expect(res.status).toBe(403);
  });

  it("TENANT ISOLATION: company B cannot submit company A's submission", async () => {
    const { submissionId } = await prepareSubmission();
    const res = await request(app).post(`/api/zatca/submissions/${submissionId}/submit`).set("Authorization", `Bearer ${tokenB}`);
    expect(res.status).toBe(404);
  });

  it("400s with category configuration when no credential is connected yet", async () => {
    const { submissionId } = await prepareSubmission();
    const res = await request(app).post(`/api/zatca/submissions/${submissionId}/submit`).set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(400);
    expect(res.body.category).toBe("configuration");
  });

  it("NEVER FABRICATES SUCCESS: with a credential connected, submit honestly fails at the signing boundary (not_implemented), never a fake accepted/cleared state", async () => {
    const { egsUnitId, submissionId } = await prepareSubmission();
    await request(app)
      .post(`/api/zatca/egs-units/${egsUnitId}/credential`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ binarySecurityToken: "tok", secret: "sec" });

    const res = await request(app).post(`/api/zatca/submissions/${submissionId}/submit`).set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(501);
    expect(res.body.category).toBe("not_implemented");
    expect(res.body.submission.state).toBe("compliance_failed");
    expect(["cleared", "reported", "accepted", "submitted"]).not.toContain(res.body.submission.state);
  });

  it("RETRY: a second submit attempt on the same submission retries honestly (retryCount increments, no duplicate submission row created)", async () => {
    const { egsUnitId, submissionId } = await prepareSubmission();
    await request(app)
      .post(`/api/zatca/egs-units/${egsUnitId}/credential`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ binarySecurityToken: "tok", secret: "sec" });

    const first = await request(app).post(`/api/zatca/submissions/${submissionId}/submit`).set("Authorization", `Bearer ${tokenA}`);
    const second = await request(app).post(`/api/zatca/submissions/${submissionId}/submit`).set("Authorization", `Bearer ${tokenA}`);

    expect(first.body.submission.id).toBe(submissionId);
    expect(second.body.submission.id).toBe(submissionId);
    expect(second.body.submission.retryCount).toBe(first.body.submission.retryCount + 1);
  });

  it("INTEGRITY: if the underlying invoice changes after prepare, submit refuses rather than sending stale content", async () => {
    const { egsUnitId, invoiceId, submissionId } = await prepareSubmission();
    await request(app)
      .post(`/api/zatca/egs-units/${egsUnitId}/credential`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ binarySecurityToken: "tok", secret: "sec" });

    // Simulate drift between prepare and submit -- directly mutate the
    // invoice's tax rate (never done through a real UI action here, just
    // proving the safety check exists).
    await db.update(invoices).set({ taxRatePercent: "5.00" }).where(eq(invoices.id, invoiceId));

    const res = await request(app).post(`/api/zatca/submissions/${submissionId}/submit`).set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(409);
    expect(res.body.submission.state).toBe("compliance_failed");
  });

  it("secrets never appear in the submit response or audit trail", async () => {
    const { egsUnitId, submissionId } = await prepareSubmission();
    const rawSecret = "SUBMIT-TEST-RAW-SECRET-VALUE";
    await request(app)
      .post(`/api/zatca/egs-units/${egsUnitId}/credential`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ binarySecurityToken: "tok", secret: rawSecret });

    const res = await request(app).post(`/api/zatca/submissions/${submissionId}/submit`).set("Authorization", `Bearer ${tokenA}`);
    expect(JSON.stringify(res.body)).not.toContain(rawSecret);

    const auditRes = await request(app).get("/api/audit-events").set("Authorization", `Bearer ${tokenA}`);
    expect(JSON.stringify(auditRes.body)).not.toContain(rawSecret);
  });
});

describe("GET /api/zatca/submissions (company-wide history)", () => {
  it("TENANT ISOLATION: company B's submission list never includes company A's submissions", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const invoiceId = await createInvoice(tokenA);
    await request(app)
      .post(`/api/zatca/egs-units/${egsUnitId}/invoices/${invoiceId}/prepare`)
      .set("Authorization", `Bearer ${tokenA}`);

    const listA = await request(app).get("/api/zatca/submissions").set("Authorization", `Bearer ${tokenA}`);
    const listB = await request(app).get("/api/zatca/submissions").set("Authorization", `Bearer ${tokenB}`);

    expect(listA.body.some((s: { egsUnitId: string }) => s.egsUnitId === egsUnitId)).toBe(true);
    expect(listB.body.some((s: { egsUnitId: string }) => s.egsUnitId === egsUnitId)).toBe(false);
  });
});
