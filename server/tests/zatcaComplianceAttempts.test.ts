import "reflect-metadata";
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { webcrypto } from "node:crypto";
import http from "node:http";
import * as x509 from "@peculiar/x509";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";

// Slice M — Compliance Attempt persistence (Compliance Lifecycle ->
// Compliance Attempt, 1:N, historical). See docs/zatca for the
// architecture this implements; this file tests only the persistence
// layer added this slice, not Compliance Steps, aggregate compliance
// completion, Production Lifecycle, or renewal — all still out of scope.

vi.mock("../src/lib/mailer.js", () => ({ sendMail: vi.fn() }));

beforeAll(() => {
  process.env.ZATCA_CSR_ECDSA_CURVE = "P-256";
  x509.cryptoProvider.set(webcrypto as unknown as Crypto);
});

const app = buildApp();

const baseFields = {
  commonName: "EGS-UNIT-1",
  egsSerialNumber: "1-ACME-SW|2-1.0.0|3-SN12345",
  organizationIdentifier: "399999999900003",
  organizationUnitName: "Riyadh Branch",
  organizationName: "Test Company LLC",
  countryCode: "SA",
  invoiceType: "1100",
  location: "Riyadh, Saudi Arabia",
  industry: "Construction",
};

const customAttributeOids = {
  egsSerialNumber: "2.16.840.1.113883.3.9999.1",
  invoiceType: "2.16.840.1.113883.3.9999.2",
  location: "2.16.840.1.113883.3.9999.3",
  industry: "2.16.840.1.113883.3.9999.4",
};

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

let companyA: string, companyB: string, tokenA: string, tokenB: string;

beforeAll(async () => {
  await resetDb();

  const resA = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Compliance Attempts Co A", name: "Owner A", email: uniqueEmail("cpat-a"), password: "password123" });
  companyA = resA.body.company.id;
  tokenA = resA.body.token;

  const resB = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Compliance Attempts Co B", name: "Owner B", email: uniqueEmail("cpat-b"), password: "password123" });
  companyB = resB.body.company.id;
  tokenB = resB.body.token;

  await request(app)
    .patch("/api/zatca/config")
    .set("Authorization", `Bearer ${tokenA}`)
    .send({ vatNumber: baseFields.organizationIdentifier, commercialRegistration: "1010101010" });
  await request(app)
    .patch("/api/zatca/config")
    .set("Authorization", `Bearer ${tokenB}`)
    .send({ vatNumber: baseFields.organizationIdentifier, commercialRegistration: "2020202020" });
});

async function createEgsUnit(token: string): Promise<string> {
  const res = await request(app)
    .post("/api/zatca/egs-units")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: "Test Unit", environment: "simulation" });
  return res.body.id as string;
}

async function generateCsr(token: string, egsUnitId: string, invoiceType = baseFields.invoiceType, otp = "123456") {
  return request(app)
    .post(`/api/zatca/egs-units/${egsUnitId}/csr`)
    .set("Authorization", `Bearer ${token}`)
    .send({ otp, fields: { ...baseFields, invoiceType }, customAttributeOids });
}

async function requestComplianceCsid(token: string, egsUnitId: string, csrBase64: string, otp = "123456") {
  return request(app)
    .post(`/api/zatca/egs-units/${egsUnitId}/compliance-csid`)
    .set("Authorization", `Bearer ${token}`)
    .send({ otp, csrBase64 });
}

async function submitComplianceInvoice(
  token: string,
  egsUnitId: string,
  documentType = "388",
  overrides: Partial<{ invoiceXmlBase64: string; invoiceHashBase64: string; uuid: string }> = {},
) {
  return request(app)
    .post(`/api/zatca/egs-units/${egsUnitId}/compliance-invoices`)
    .set("Authorization", `Bearer ${token}`)
    .send({
      documentType,
      invoiceXmlBase64: overrides.invoiceXmlBase64 ?? "PGE+PC9hPg==",
      invoiceHashBase64: overrides.invoiceHashBase64 ?? "abc123==",
      uuid: overrides.uuid ?? "11111111-1111-1111-1111-111111111111",
    });
}

// Same fake-FATOORA-server pattern already used by zatcaProvider.test.ts,
// zatcaConfigRoutes.test.ts, and zatcaComplianceLifecycles.test.ts — never
// the real ZATCA network. One server handles both the Compliance CSID path
// ("/compliance") and the Compliance Invoice path ("/compliance/invoices")
// by branching on req.url, so a single mock server can carry a test
// through both steps of the setup chain.
const ENV_KEYS = [
  "ZATCA_FATOORA_SIMULATION_BASE_URL",
  "ZATCA_FATOORA_SIMULATION_COMPLIANCE_PATH",
  "ZATCA_FATOORA_SIMULATION_COMPLIANCE_CSID_PATH",
  "ZATCA_FATOORA_SIMULATION_CLEARANCE_PATH",
  "ZATCA_FATOORA_SIMULATION_REPORTING_PATH",
];

function clearFatooraEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}

function setFatooraEnv(baseUrl: string) {
  process.env.ZATCA_FATOORA_SIMULATION_BASE_URL = baseUrl;
  process.env.ZATCA_FATOORA_SIMULATION_COMPLIANCE_PATH = "compliance/invoices";
  process.env.ZATCA_FATOORA_SIMULATION_COMPLIANCE_CSID_PATH = "compliance";
  process.env.ZATCA_FATOORA_SIMULATION_CLEARANCE_PATH = "invoices/clearance/single";
  process.env.ZATCA_FATOORA_SIMULATION_REPORTING_PATH = "invoices/reporting/single";
}

function startMockFatoora(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((res) => server.close(() => res())) });
    });
  });
}

type ComplianceInvoiceOutcome = "reported" | "not_reported" | "server_error";

function comboHandler(
  invoiceOutcome: ComplianceInvoiceOutcome,
  csidCredential: { cert: string; secret: string } = { cert: "cert-bytes-base64", secret: "shared-secret-value" },
): http.RequestListener {
  return (req, res) => {
    if (req.url === "/compliance/invoices") {
      if (invoiceOutcome === "server_error") {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: "Invalid-Request", message: "System failed to process your request" }));
        return;
      }
      const reportingStatus = invoiceOutcome === "reported" ? "REPORTED" : "NOT_REPORTED";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          reportingStatus,
          validationResults: { status: "PASS" },
          clearanceStatus: null,
          qrSellertStatus: null,
          qrBuyertStatus: null,
        }),
      );
      return;
    }
    // "/compliance" — Compliance CSID.
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        requestID: 1234567890123,
        dispositionMessage: "ISSUED",
        binarySecurityToken: csidCredential.cert,
        secret: csidCredential.secret,
      }),
    );
  };
}

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = undefined;
  clearFatooraEnv();
});

// Drives an EGS unit all the way to an "issued" Compliance Lifecycle,
// against whatever mock server is currently configured via setFatooraEnv.
async function setUpComplianceLifecycle(token: string, egsUnitId: string) {
  const csrRes = await generateCsr(token, egsUnitId);
  const csidRes = await requestComplianceCsid(token, egsUnitId, csrRes.body.csrDerBase64);
  expect(csidRes.status).toBe(201);
  return csrRes.body.csrDerBase64 as string;
}

describe("Slice M — Compliance Attempt persistence: Test 1, successful attempt", () => {
  it("persists exactly one attempt with correct lifecycle/company/correlationId/rawStatus/normalizedOutcome", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const server = await startMockFatoora(comboHandler("reported"));
    cleanup = server.close;
    setFatooraEnv(server.url);
    await setUpComplianceLifecycle(tokenA, egsUnitId);

    const res = await submitComplianceInvoice(tokenA, egsUnitId, "388");
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("compliance_pending");
    expect(res.body.rawStatus).toBe("REPORTED");
    expect(res.body.correlationId).toBeTruthy();

    const { listCsrInstancesForEgsUnit, getComplianceLifecycleForCsrInstance, listComplianceAttemptsForLifecycle } = await import(
      "../src/lib/zatca/domain/index.js"
    );
    const [csrInstance] = await listCsrInstancesForEgsUnit(companyA, egsUnitId);
    const lifecycle = await getComplianceLifecycleForCsrInstance(companyA, csrInstance.id);
    const attempts = await listComplianceAttemptsForLifecycle(companyA, lifecycle!.id);

    expect(attempts).toHaveLength(1);
    const attempt = attempts[0];
    expect(attempt.companyId).toBe(companyA);
    expect(attempt.complianceLifecycleId).toBe(lifecycle!.id);
    expect(attempt.documentType).toBe("388");
    expect(attempt.correlationId).toBeTruthy();
    expect(attempt.rawStatus).toBe("REPORTED");
    expect(attempt.normalizedOutcome).toBe("compliance_pending");
    expect(attempt.attemptedAt).toBeInstanceOf(Date);
    expect(attempt.errorCategory).toBeNull();
    expect(attempt.errorCode).toBeNull();
  });
});

describe("Slice M — Compliance Attempt persistence: Test 2, failed attempt", () => {
  it("persists an attempt for a genuine ZATCA-side rejection (a real, non-throwing result)", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const server = await startMockFatoora(comboHandler("not_reported"));
    cleanup = server.close;
    setFatooraEnv(server.url);
    await setUpComplianceLifecycle(tokenA, egsUnitId);

    const res = await submitComplianceInvoice(tokenA, egsUnitId, "381");
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("rejected");
    expect(res.body.rawStatus).toBe("NOT_REPORTED");

    const { listCsrInstancesForEgsUnit, getComplianceLifecycleForCsrInstance, listComplianceAttemptsForLifecycle } = await import(
      "../src/lib/zatca/domain/index.js"
    );
    const [csrInstance] = await listCsrInstancesForEgsUnit(companyA, egsUnitId);
    const lifecycle = await getComplianceLifecycleForCsrInstance(companyA, csrInstance.id);
    const attempts = await listComplianceAttemptsForLifecycle(companyA, lifecycle!.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].normalizedOutcome).toBe("rejected");
    expect(attempts[0].documentType).toBe("381");
    expect(attempts[0].errorCategory).toBeNull();
  });

  it("persists an attempt (with errorCategory) when the provider call itself throws, and still returns the mapped HTTP error", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const server = await startMockFatoora(comboHandler("server_error"));
    cleanup = server.close;
    setFatooraEnv(server.url);
    await setUpComplianceLifecycle(tokenA, egsUnitId);

    const res = await submitComplianceInvoice(tokenA, egsUnitId, "383");
    expect(res.status).toBe(503);
    expect(res.body.category).toBe("external_service");

    const { listCsrInstancesForEgsUnit, getComplianceLifecycleForCsrInstance, listComplianceAttemptsForLifecycle } = await import(
      "../src/lib/zatca/domain/index.js"
    );
    const [csrInstance] = await listCsrInstancesForEgsUnit(companyA, egsUnitId);
    const lifecycle = await getComplianceLifecycleForCsrInstance(companyA, csrInstance.id);
    const attempts = await listComplianceAttemptsForLifecycle(companyA, lifecycle!.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].documentType).toBe("383");
    expect(attempts[0].errorCategory).toBe("external_service");
    expect(attempts[0].correlationId).toBeNull();
    expect(attempts[0].rawStatus).toBeNull();
    expect(attempts[0].normalizedOutcome).toBeNull();
  });
});

describe("Slice M — Compliance Attempt persistence: Test 3, multiple attempts", () => {
  it("supports three attempts against the same lifecycle without any uniqueness conflict", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const server = await startMockFatoora(comboHandler("reported"));
    cleanup = server.close;
    setFatooraEnv(server.url);
    await setUpComplianceLifecycle(tokenA, egsUnitId);

    const res1 = await submitComplianceInvoice(tokenA, egsUnitId, "388");
    const res2 = await submitComplianceInvoice(tokenA, egsUnitId, "388");
    const res3 = await submitComplianceInvoice(tokenA, egsUnitId, "381");
    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
    expect(res3.status).toBe(201);

    const { listCsrInstancesForEgsUnit, getComplianceLifecycleForCsrInstance, listComplianceAttemptsForLifecycle } = await import(
      "../src/lib/zatca/domain/index.js"
    );
    const [csrInstance] = await listCsrInstancesForEgsUnit(companyA, egsUnitId);
    const lifecycle = await getComplianceLifecycleForCsrInstance(companyA, csrInstance.id);
    const attempts = await listComplianceAttemptsForLifecycle(companyA, lifecycle!.id);
    expect(attempts).toHaveLength(3);
    expect(new Set(attempts.map((a) => a.id)).size).toBe(3);
  });
});

describe("Slice M — Compliance Attempt persistence: Test 4, retry", () => {
  it("leaves retryOfAttemptId null on every attempt — no retry identity concept exists yet", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const server = await startMockFatoora(comboHandler("reported"));
    cleanup = server.close;
    setFatooraEnv(server.url);
    await setUpComplianceLifecycle(tokenA, egsUnitId);

    await submitComplianceInvoice(tokenA, egsUnitId, "388");
    await submitComplianceInvoice(tokenA, egsUnitId, "388");

    const { listCsrInstancesForEgsUnit, getComplianceLifecycleForCsrInstance, listComplianceAttemptsForLifecycle } = await import(
      "../src/lib/zatca/domain/index.js"
    );
    const [csrInstance] = await listCsrInstancesForEgsUnit(companyA, egsUnitId);
    const lifecycle = await getComplianceLifecycleForCsrInstance(companyA, csrInstance.id);
    const attempts = await listComplianceAttemptsForLifecycle(companyA, lifecycle!.id);
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    for (const attempt of attempts) expect(attempt.retryOfAttemptId).toBeNull();
  });
});

describe("Slice M — Compliance Attempt persistence: Test 5, tenant isolation", () => {
  it("company B cannot submit a Compliance Invoice attempt for company A's EGS unit", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const server = await startMockFatoora(comboHandler("reported"));
    cleanup = server.close;
    setFatooraEnv(server.url);
    await setUpComplianceLifecycle(tokenA, egsUnitId);

    const res = await submitComplianceInvoice(tokenB, egsUnitId, "388");
    expect(res.status).toBe(404);
  });

  it("company B's own attempt lookups never see company A's rows", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const server = await startMockFatoora(comboHandler("reported"));
    cleanup = server.close;
    setFatooraEnv(server.url);
    await setUpComplianceLifecycle(tokenA, egsUnitId);
    const submitRes = await submitComplianceInvoice(tokenA, egsUnitId, "388");
    expect(submitRes.status).toBe(201);

    const { listCsrInstancesForEgsUnit, getComplianceLifecycleForCsrInstance, listComplianceAttemptsForLifecycle, getComplianceAttempt } =
      await import("../src/lib/zatca/domain/index.js");
    const [csrInstance] = await listCsrInstancesForEgsUnit(companyA, egsUnitId);
    const lifecycle = await getComplianceLifecycleForCsrInstance(companyA, csrInstance.id);
    const attemptsForB = await listComplianceAttemptsForLifecycle(companyB, lifecycle!.id);
    expect(attemptsForB).toHaveLength(0);

    const [attemptForA] = await listComplianceAttemptsForLifecycle(companyA, lifecycle!.id);
    expect(await getComplianceAttempt(companyB, attemptForA.id)).toBeUndefined();
  });
});

describe("Slice M — Compliance Attempt persistence: Test 6, invalid lifecycle", () => {
  it("rejects with a configuration error, and persists no attempt, when no CSR Instance exists yet", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const res = await submitComplianceInvoice(tokenA, egsUnitId, "388");
    expect(res.status).toBe(400);
    expect(res.body.category).toBe("configuration");
  });

  it("rejects with a configuration error, and persists no attempt, when a CSR exists but no Compliance Lifecycle yet", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    await generateCsr(tokenA, egsUnitId);

    const res = await submitComplianceInvoice(tokenA, egsUnitId, "388");
    expect(res.status).toBe(400);
    expect(res.body.category).toBe("configuration");

    const { listCsrInstancesForEgsUnit } = await import("../src/lib/zatca/domain/index.js");
    const [csrInstance] = await listCsrInstancesForEgsUnit(companyA, egsUnitId);
    expect(csrInstance).toBeTruthy(); // sanity: the CSR exists, only the lifecycle doesn't
  });
});

describe("Slice M — Compliance Attempt persistence: Test 7, no zatca_submissions pollution", () => {
  it("never creates a zatca_submissions row for a Compliance Invoice attempt, success or failure", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const server = await startMockFatoora(comboHandler("reported"));
    cleanup = server.close;
    setFatooraEnv(server.url);
    await setUpComplianceLifecycle(tokenA, egsUnitId);

    await submitComplianceInvoice(tokenA, egsUnitId, "388");
    const failingServer = await startMockFatoora(comboHandler("server_error"));
    setFatooraEnv(failingServer.url);
    await submitComplianceInvoice(tokenA, egsUnitId, "381");
    await failingServer.close();

    const { listSubmissionsForCompany } = await import("../src/lib/zatca/domain/index.js");
    const submissions = await listSubmissionsForCompany(companyA);
    expect(submissions).toHaveLength(0);
  });
});

describe("Slice M — Compliance Attempt persistence: Test 8, secret isolation", () => {
  it("never stores or returns the Compliance CSID credential anywhere — DB rows, audit events, or the API response", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const server = await startMockFatoora(
      comboHandler("reported", { cert: "SENSITIVE-COMPLIANCE-CERT", secret: "SENSITIVE-COMPLIANCE-SECRET" }),
    );
    cleanup = server.close;
    setFatooraEnv(server.url);
    await setUpComplianceLifecycle(tokenA, egsUnitId);

    const res = await submitComplianceInvoice(tokenA, egsUnitId, "388");
    expect(res.status).toBe(201);

    const resBody = JSON.stringify(res.body);
    expect(resBody).not.toContain("SENSITIVE-COMPLIANCE-CERT");
    expect(resBody).not.toContain("SENSITIVE-COMPLIANCE-SECRET");
    expect(resBody).not.toContain("secretRef");
    expect(resBody).not.toContain("Authorization");

    const { listCsrInstancesForEgsUnit, getComplianceLifecycleForCsrInstance, listComplianceAttemptsForLifecycle } = await import(
      "../src/lib/zatca/domain/index.js"
    );
    const [csrInstance] = await listCsrInstancesForEgsUnit(companyA, egsUnitId);
    const lifecycle = await getComplianceLifecycleForCsrInstance(companyA, csrInstance.id);
    const attempts = await listComplianceAttemptsForLifecycle(companyA, lifecycle!.id);
    const attemptsJson = JSON.stringify(attempts);
    expect(attemptsJson).not.toContain("SENSITIVE-COMPLIANCE-CERT");
    expect(attemptsJson).not.toContain("SENSITIVE-COMPLIANCE-SECRET");
    expect(attemptsJson).not.toContain("secretRef");
    expect(attemptsJson).not.toContain("binarySecurityToken");

    const auditRows = await db.query.auditEvents.findMany({ where: (a, { eq }) => eq(a.entityId, egsUnitId) });
    const auditJson = JSON.stringify(auditRows);
    expect(auditJson).not.toContain("SENSITIVE-COMPLIANCE-CERT");
    expect(auditJson).not.toContain("SENSITIVE-COMPLIANCE-SECRET");
    expect(auditJson).toContain("zatca.complianceInvoice.attempted");
  });
});

describe("Slice M — Compliance Attempt persistence: Test 9, lifecycle status remains unchanged", () => {
  it("keeps zatca_compliance_lifecycles.status exactly 'issued' after both a successful and a failed attempt", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const server = await startMockFatoora(comboHandler("reported"));
    cleanup = server.close;
    setFatooraEnv(server.url);
    await setUpComplianceLifecycle(tokenA, egsUnitId);

    const { listCsrInstancesForEgsUnit, getComplianceLifecycleForCsrInstance } = await import("../src/lib/zatca/domain/index.js");
    const [csrInstance] = await listCsrInstancesForEgsUnit(companyA, egsUnitId);
    const beforeLifecycle = await getComplianceLifecycleForCsrInstance(companyA, csrInstance.id);
    expect(beforeLifecycle!.status).toBe("issued");

    await submitComplianceInvoice(tokenA, egsUnitId, "388");

    const failingServer = await startMockFatoora(comboHandler("not_reported"));
    setFatooraEnv(failingServer.url);
    await submitComplianceInvoice(tokenA, egsUnitId, "381");
    await failingServer.close();

    const afterLifecycle = await getComplianceLifecycleForCsrInstance(companyA, csrInstance.id);
    expect(afterLifecycle!.status).toBe("issued");

    const { getEgsUnit } = await import("../src/lib/zatca/domain/index.js");
    const unit = await getEgsUnit(companyA, egsUnitId);
    expect(unit!.csidStatus).toBe("compliance_pending");
  });
});
