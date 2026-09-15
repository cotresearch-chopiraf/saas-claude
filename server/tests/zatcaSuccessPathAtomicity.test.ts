import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";

// Priority 2 (read-only-review follow-up) — routes/zatca.ts's /submit
// handler used to write recordSubmissionOutcome() and recordAuditEvent()
// as two separate, independently-committed statements for every branch
// (success, ZatcaError-failure, and the unexpected-exception catch-all).
// The read-only review caught a real consequence for the success branch
// specifically: if the real ZATCA provider call succeeded (an
// irreversible external side effect) but the SUBSEQUENT local write of
// that success (recordSubmissionOutcome) or its audit trail
// (recordAuditEvent) then failed, the exception fell through to the
// catch-all, which — before this fix — unconditionally overwrote
// whatever the row's state was with "retry_required", even if
// recordSubmissionOutcome had ALREADY correctly written "cleared"/
// "reported" moments earlier. A later retry of a row ZATCA had already
// accepted would then genuinely resubmit the same invoice to ZATCA.
//
// This file proves the fix: recordSubmissionOutcome + recordAuditEvent
// are now one local transaction per branch, so a failure in either half
// rolls back the whole pair — a "cleared" write can never land without
// its own audit trail, and can never be silently overwritten by the
// catch-all once it truly did land.
//
// Own file — mocks the signer, local verification, provider, and
// recordAuditEvent modules, none of which the sibling
// zatcaSubmitCrashRecovery.test.ts or zatcaPrepareSubmit.test.ts mock in
// this combination.
vi.mock("../src/lib/mailer.js", () => ({ sendMail: vi.fn() }));

vi.mock("../src/lib/zatca/signer/index.js", () => ({
  getZatcaSigner: () => ({ sign: async () => ({ signedXml: "<fake-signed-invoice/>" }) }),
}));
vi.mock("../src/lib/zatca/signer/verify.js", () => ({
  verifyZatcaSignature: async () => ({ valid: true }),
}));

const clearInvoiceMock = vi.fn();
const reportInvoiceMock = vi.fn();
vi.mock("../src/lib/zatca/provider/index.js", () => ({
  getZatcaProvider: () => ({ clearInvoice: clearInvoiceMock, reportInvoice: reportInvoiceMock }),
}));

// Only the /submit route's OWN two audit actions are ever made to fail
// here — NOT "zatca.submission.prepared" (written by /prepare, which
// prepareSubmission() below calls first on every test) or any other
// audit call in the app (invoice creation, etc.), all of which go
// through the real implementation unaffected.
const SUBMIT_ROUTE_AUDIT_ACTIONS = new Set(["zatca.submission.responseReceived", "zatca.submission.failed"]);
let auditFailuresRemaining = 0;
vi.mock("../src/lib/audit.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/audit.js")>("../src/lib/audit.js");
  return {
    ...actual,
    recordAuditEvent: vi.fn(async (dbOrTx: unknown, input: { action: string }) => {
      if (SUBMIT_ROUTE_AUDIT_ACTIONS.has(input.action) && auditFailuresRemaining > 0) {
        auditFailuresRemaining--;
        throw new Error("simulated audit insert failure");
      }
      return actual.recordAuditEvent(dbOrTx as never, input as never);
    }),
  };
});

const { buildApp } = await import("../src/app.js");
const { resetDb } = await import("./setup.js");
const { db } = await import("../src/db/client.js");
const { zatcaSubmissions, auditEvents } = await import("../src/db/schema.js");
const { and } = await import("drizzle-orm");

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

let token: string;

beforeEach(() => {
  clearInvoiceMock.mockClear();
  reportInvoiceMock.mockClear();
});

beforeAll(async () => {
  await resetDb();
  const res = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "ZATCA Atomicity Co", name: "Owner", email: uniqueEmail("zatca-atomicity-owner"), password: "password123" });
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
    .send({ name: "Atomicity Test Unit", environment: "simulation" });
  const egsUnitId = egsUnit.body.id as string;

  await request(app)
    .post(`/api/zatca/egs-units/${egsUnitId}/credential`)
    .set("Authorization", `Bearer ${token}`)
    .send({ binarySecurityToken: "tok", secret: "sec" });

  const invoice = await request(app)
    .post("/api/invoices")
    .set("Authorization", `Bearer ${token}`)
    .send({ clientName: "Atomicity Test Client", clientTaxId: "310000000000003", items: [{ description: "Work", amount: 200 }] });
  const invoiceId = invoice.body.id as string;

  const prepared = await request(app)
    .post(`/api/zatca/egs-units/${egsUnitId}/invoices/${invoiceId}/prepare`)
    .set("Authorization", `Bearer ${token}`);
  if (prepared.status !== 201) {
    throw new Error(`prepare failed unexpectedly: ${prepared.status} ${JSON.stringify(prepared.body)}`);
  }
  return prepared.body.submission.id as string;
}

function successResult(status: "cleared" | "reported") {
  return {
    status,
    correlationId: "corr-1",
    rawStatus: status.toUpperCase(),
    respondedAt: new Date(),
    clearedInvoiceXmlBase64: status === "cleared" ? Buffer.from("<cleared/>").toString("base64") : undefined,
  };
}

describe("POST /api/zatca/submissions/:id/submit — success-path atomicity (recordSubmissionOutcome + recordAuditEvent)", () => {
  it("provider returns success + local DB succeeds: state is the real outcome, audit trail exists, never a fake status", async () => {
    clearInvoiceMock.mockResolvedValueOnce(successResult("cleared"));
    auditFailuresRemaining = 0;
    const submissionId = await prepareSubmission();

    const res = await request(app).post(`/api/zatca/submissions/${submissionId}/submit`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.submission.state).toBe("cleared");
    expect(clearInvoiceMock).toHaveBeenCalledTimes(1);

    const row = await db.query.zatcaSubmissions.findFirst({ where: eq(zatcaSubmissions.id, submissionId) });
    expect(row!.state).toBe("cleared");

    const events = await db.query.auditEvents.findMany({
      where: and(eq(auditEvents.entityType, "zatca_submission"), eq(auditEvents.entityId, submissionId)),
    });
    expect(events.some((e) => e.action === "zatca.submission.responseReceived")).toBe(true);
  });

  it("CRITICAL: provider returns success but recordSubmissionOutcome/recordAuditEvent fails — the row is NEVER left claiming a fake 'cleared' status, and NEVER stuck in 'submitting' forever", async () => {
    clearInvoiceMock.mockResolvedValueOnce(successResult("cleared"));
    auditFailuresRemaining = 1; // fails exactly the success-path's own audit write, once
    const submissionId = await prepareSubmission();

    const res = await request(app).post(`/api/zatca/submissions/${submissionId}/submit`).set("Authorization", `Bearer ${token}`);
    // The success-path transaction rolled back (audit insert failed inside
    // it) — the exception is a plain Error, not a ZatcaError, so it falls
    // to the catch-all, which gets a sanitized 500.
    expect(res.status).toBe(500);
    expect(clearInvoiceMock).toHaveBeenCalledTimes(1); // the real provider call happened exactly once — this test cannot undo that

    const row = await db.query.zatcaSubmissions.findFirst({ where: eq(zatcaSubmissions.id, submissionId) });
    // The core guarantee: never "cleared" when the local write that was
    // supposed to record it actually failed — no fake success is ever
    // reported to the database.
    expect(row!.state).not.toBe("cleared");
    expect(row!.state).not.toBe("reported");
    // And not permanently stuck either — the catch-all's own (separately
    // successful, since auditFailuresRemaining was already spent) recovery
    // write moved it to retry_required.
    expect(row!.state).toBe("retry_required");

    const events = await db.query.auditEvents.findMany({
      where: and(eq(auditEvents.entityType, "zatca_submission"), eq(auditEvents.entityId, submissionId)),
    });
    // The failed success-path audit attempt never landed (rolled back);
    // the catch-all's own recovery audit call did.
    expect(events.some((e) => e.action === "zatca.submission.responseReceived")).toBe(false);
    expect(events.some((e) => e.action === "zatca.submission.failed")).toBe(true);
  });

  it("RETRY AFTER RECOVERY: a submission left in retry_required by the scenario above can be resubmitted, and a clean run now succeeds honestly", async () => {
    clearInvoiceMock.mockResolvedValueOnce(successResult("cleared"));
    auditFailuresRemaining = 1;
    const submissionId = await prepareSubmission();
    const first = await request(app).post(`/api/zatca/submissions/${submissionId}/submit`).set("Authorization", `Bearer ${token}`);
    expect(first.status).toBe(500);

    clearInvoiceMock.mockResolvedValueOnce(successResult("cleared"));
    auditFailuresRemaining = 0; // the transient condition has cleared
    const second = await request(app).post(`/api/zatca/submissions/${submissionId}/submit`).set("Authorization", `Bearer ${token}`);
    expect(second.status).toBe(200);
    expect(second.body.submission.state).toBe("cleared");
    expect(second.body.alreadyAttempted).toBe(false);
    expect(clearInvoiceMock).toHaveBeenCalledTimes(2); // genuinely retried, not short-circuited
  });

  it("DUPLICATE RESPONSE: a ZatcaDuplicateError from the provider is recorded honestly (compliance_failed, not a fake success, not silently retried)", async () => {
    const { ZatcaDuplicateError } = await import("../src/lib/zatca/errors.js");
    clearInvoiceMock.mockRejectedValueOnce(new ZatcaDuplicateError("already submitted to ZATCA"));
    auditFailuresRemaining = 0;
    const submissionId = await prepareSubmission();

    const res = await request(app).post(`/api/zatca/submissions/${submissionId}/submit`).set("Authorization", `Bearer ${token}`);
    expect(res.body.category).toBe("duplicate");
    expect(["cleared", "reported"]).not.toContain(res.body.submission?.state);

    const row = await db.query.zatcaSubmissions.findFirst({ where: eq(zatcaSubmissions.id, submissionId) });
    expect(row!.state).toBe("compliance_failed"); // ZatcaDuplicateError is not retryable
  });

  it("ZatcaError branch audit failure: if the audit write for a real ZATCA rejection fails, the state write rolls back too rather than landing without its audit trail", async () => {
    const { ZatcaValidationError } = await import("../src/lib/zatca/errors.js");
    clearInvoiceMock.mockRejectedValueOnce(new ZatcaValidationError("simulated validation rejection"));
    auditFailuresRemaining = 1;
    const submissionId = await prepareSubmission();

    const res = await request(app).post(`/api/zatca/submissions/${submissionId}/submit`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(500); // the transaction itself threw — no clean error envelope was possible

    const row = await db.query.zatcaSubmissions.findFirst({ where: eq(zatcaSubmissions.id, submissionId) });
    // Rolled back — never "compliance_failed" without its audit trail,
    // and never a fake success either. Left exactly where the atomic
    // claim put it; a human or a later retry can still act on it.
    expect(row!.state).toBe("submitting");
    expect(["cleared", "reported"]).not.toContain(row!.state);
  });
});
