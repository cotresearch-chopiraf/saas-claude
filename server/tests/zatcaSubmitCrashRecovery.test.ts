import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";

// 18-phase internal remediation, Phase 10 — audit finding: routes/zatca.ts's
// /submit handler used to `throw err` for any exception that wasn't a
// ZatcaError, leaving the submission row permanently stuck in "submitting"
// (claimSubmissionForSubmit's own claimed state) since no other code path
// ever calls recordSubmissionOutcome for that case. This file proves the
// fix: an unexpected (non-ZatcaError) exception during signing now still
// moves the row to "retry_required", so a later /submit call can actually
// retry instead of getting `alreadyAttempted: true` forever.
//
// Own file (not added to zatcaPrepareSubmit.test.ts) because it needs to
// mock the signer module itself to inject a non-ZatcaError crash — that
// mock would otherwise interfere with zatcaPrepareSubmit.test.ts's own
// signer-failure-category assertions, which rely on the REAL
// XadesZatcaSigner's honest ZatcaConfigurationError behavior.
vi.mock("../src/lib/mailer.js", () => ({ sendMail: vi.fn() }));
const signMock = vi.fn();
vi.mock("../src/lib/zatca/signer/index.js", () => ({
  getZatcaSigner: () => ({ sign: signMock }),
}));

const { buildApp } = await import("../src/app.js");
const { resetDb } = await import("./setup.js");
const { db } = await import("../src/db/client.js");
const { zatcaSubmissions } = await import("../src/db/schema.js");

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

let token: string;

beforeAll(async () => {
  await resetDb();
  const res = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "ZATCA Crash Co", name: "Owner", email: uniqueEmail("zatca-crash-owner"), password: "password123" });
  token = res.body.token;

  await request(app)
    .patch("/api/zatca/config")
    .set("Authorization", `Bearer ${token}`)
    .send({ vatNumber: "300000000000003", commercialRegistration: "1010101010" });
});

async function prepareSubmission() {
  const egsUnit = await request(app)
    .post("/api/zatca/egs-units")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: "Crash Test Unit", environment: "simulation" });
  const egsUnitId = egsUnit.body.id as string;

  await request(app)
    .post(`/api/zatca/egs-units/${egsUnitId}/credential`)
    .set("Authorization", `Bearer ${token}`)
    .send({ binarySecurityToken: "tok", secret: "sec" });

  const invoice = await request(app)
    .post("/api/invoices")
    .set("Authorization", `Bearer ${token}`)
    .send({ clientName: "Crash Test Client", clientTaxId: "310000000000003", items: [{ description: "Work", amount: 200 }] });
  const invoiceId = invoice.body.id as string;

  const prepared = await request(app)
    .post(`/api/zatca/egs-units/${egsUnitId}/invoices/${invoiceId}/prepare`)
    .set("Authorization", `Bearer ${token}`);
  return prepared.body.submission.id as string;
}

describe("POST /api/zatca/submissions/:id/submit — crash-window recovery (non-ZatcaError exception)", () => {
  it("an unexpected exception during signing moves the submission to retry_required, not a permanently stuck 'submitting'", async () => {
    signMock.mockRejectedValueOnce(new TypeError("simulated unexpected crash — not a ZatcaError"));
    const submissionId = await prepareSubmission();

    const res = await request(app).post(`/api/zatca/submissions/${submissionId}/submit`).set("Authorization", `Bearer ${token}`);
    // The route rethrows the unexpected error — the global error handler's
    // sanitized generic 500 is the expected client-facing response.
    expect(res.status).toBe(500);

    const row = await db.query.zatcaSubmissions.findFirst({ where: eq(zatcaSubmissions.id, submissionId) });
    expect(row!.state).toBe("retry_required");
    expect(row!.state).not.toBe("submitting");
    expect(row!.retryCount).toBe(1);
  });

  it("a retry after the crash actually retries (does not report alreadyAttempted forever)", async () => {
    signMock.mockRejectedValueOnce(new TypeError("simulated unexpected crash — not a ZatcaError"));
    const submissionId = await prepareSubmission();

    const first = await request(app).post(`/api/zatca/submissions/${submissionId}/submit`).set("Authorization", `Bearer ${token}`);
    expect(first.status).toBe(500);

    // Second attempt: let signing succeed this time (simulating the
    // transient/crash condition having cleared) — the honest next failure
    // is the missing-private-key ZatcaConfigurationError from the real
    // downstream path once signing itself no longer throws, but the point
    // being proven is narrower: this call must reach real signing logic
    // again at all, not be short-circuited as already-attempted.
    signMock.mockRejectedValueOnce(new Error("configuration: no private key"));
    const second = await request(app).post(`/api/zatca/submissions/${submissionId}/submit`).set("Authorization", `Bearer ${token}`);
    // A 500 here (real signing was attempted again and crashed again) —
    // not a 200 with alreadyAttempted:true — is the proof the retry
    // actually reached the signer a second time, rather than being
    // short-circuited by SUBMISSION_TERMINAL_OR_INFLIGHT_STATES the way a
    // still-"submitting" row would be.
    expect(second.status).toBe(500);

    const row = await db.query.zatcaSubmissions.findFirst({ where: eq(zatcaSubmissions.id, submissionId) });
    expect(row!.retryCount).toBe(2);
  });
});
