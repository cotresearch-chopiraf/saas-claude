import "reflect-metadata";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { webcrypto } from "node:crypto";
import http from "node:http";
import * as x509 from "@peculiar/x509";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { useZatcaCsrCurve } from "./helpers/zatcaEnv.js";

// Slice AB — real ZATCA provider submission wiring (routes/zatca.ts's
// /submissions/:id/submit). These tests never touch the real ZATCA
// network (unreachable from this environment, and automated tests must
// never call real production ZATCA) — every case runs against a real
// local HTTP server standing in for ZATCA's Clearance/Reporting endpoint,
// same technique as tests/zatcaProvider.test.ts and the FULL HTTP STACK
// test in tests/zatcaCsrCsid.test.ts.

const app = buildApp();

useZatcaCsrCurve();
beforeAll(() => {
  x509.cryptoProvider.set(webcrypto as unknown as Crypto);
});

const validFields = {
  commonName: "EGS-UNIT-EXEC",
  egsSerialNumber: "1-ACME-SW|2-1.0.0|3-SN99999",
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

async function makeIssuedCertificateForCsr(csrDerBase64: string, notAfter: Date): Promise<string> {
  const csr = new x509.Pkcs10CertificateRequest(csrDerBase64);
  const caAlg = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
  const caKeys = (await webcrypto.subtle.generateKey(caAlg, true, ["sign", "verify"])) as CryptoKeyPair;
  const issued = await x509.X509CertificateGenerator.create({
    serialNumber: "01",
    subject: csr.subject,
    issuer: "CN=Fake ZATCA CA for testing",
    notBefore: new Date("2026-01-01"),
    notAfter,
    signingAlgorithm: caAlg,
    publicKey: csr.publicKey,
    signingKey: caKeys.privateKey,
  });
  return Buffer.from(issued.rawData).toString("base64");
}

let token: string;

beforeAll(async () => {
  await resetDb();
  const res = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Submission Exec Co", name: "Owner", email: uniqueEmail("submit-exec"), password: "password123" });
  token = res.body.token;

  await request(app)
    .patch("/api/zatca/config")
    .set("Authorization", `Bearer ${token}`)
    .send({ vatNumber: validFields.organizationIdentifier, commercialRegistration: "1010101010" });
});

async function createEgsUnit(): Promise<string> {
  const res = await request(app)
    .post("/api/zatca/egs-units")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: `Unit ${Math.random()}`, environment: "simulation" });
  return res.body.id as string;
}

// Onboards a real, working credential (CSR generation + a locally-issued
// matching certificate confirmed at the compliance stage) — the same
// two-step flow a tenant performs for real, giving this EGS unit a
// privateKeyPem-bearing credential so real XAdES signing succeeds.
async function onboardEgsUnit(): Promise<string> {
  const egsUnitId = await createEgsUnit();
  const csrRes = await request(app)
    .post(`/api/zatca/egs-units/${egsUnitId}/csr`)
    .set("Authorization", `Bearer ${token}`)
    .send({ otp: "123456", fields: validFields, customAttributeOids });
  const matchingCert = await makeIssuedCertificateForCsr(csrRes.body.csrDerBase64, new Date("2027-01-01"));
  const csidRes = await request(app)
    .post(`/api/zatca/egs-units/${egsUnitId}/csid`)
    .set("Authorization", `Bearer ${token}`)
    .send({ binarySecurityToken: matchingCert, secret: "s3cr3t", stage: "compliance" });
  expect(csidRes.status).toBe(200);
  return egsUnitId;
}

async function createInvoice(clientTaxId?: string): Promise<string> {
  const res = await request(app)
    .post("/api/invoices")
    .set("Authorization", `Bearer ${token}`)
    .send({ clientName: "Exec Client", clientTaxId, items: [{ description: "Work", amount: 200 }] });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function prepare(egsUnitId: string, invoiceId: string): Promise<string> {
  const res = await request(app)
    .post(`/api/zatca/egs-units/${egsUnitId}/invoices/${invoiceId}/prepare`)
    .set("Authorization", `Bearer ${token}`);
  expect(res.status).toBe(201);
  return res.body.submission.id as string;
}

const FATOORA_ENV_KEYS = [
  "ZATCA_FATOORA_SIMULATION_BASE_URL",
  "ZATCA_FATOORA_SIMULATION_COMPLIANCE_PATH",
  "ZATCA_FATOORA_SIMULATION_CLEARANCE_PATH",
  "ZATCA_FATOORA_SIMULATION_REPORTING_PATH",
];

let activeServer: { close: () => Promise<void> } | undefined;

afterEach(async () => {
  if (activeServer) await activeServer.close();
  activeServer = undefined;
  for (const key of FATOORA_ENV_KEYS) delete process.env[key];
});

async function startMockZatcaServer(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  const server = await new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    const s = http.createServer(handler);
    s.listen(0, "127.0.0.1", () => {
      const address = s.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => s.close(() => r())) });
    });
  });
  activeServer = server;
  process.env.ZATCA_FATOORA_SIMULATION_BASE_URL = server.url;
  process.env.ZATCA_FATOORA_SIMULATION_COMPLIANCE_PATH = "compliance/invoices";
  process.env.ZATCA_FATOORA_SIMULATION_CLEARANCE_PATH = "invoices/clearance/single";
  process.env.ZATCA_FATOORA_SIMULATION_REPORTING_PATH = "invoices/reporting/single";
  return server;
}

describe("Real submission: routing (clearance vs reporting)", () => {
  it("a simplified (B2C, no clientTaxId) invoice is routed to reportInvoice, not clearInvoice", async () => {
    let hitPath: string | undefined;
    await startMockZatcaServer((req, res) => {
      hitPath = req.url;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ validationResults: { status: "PASS" }, reportingStatus: "REPORTED" }));
    });

    const egsUnitId = await onboardEgsUnit();
    const invoiceId = await createInvoice(); // no clientTaxId -> simplified
    const submissionId = await prepare(egsUnitId, invoiceId);

    const res = await request(app).post(`/api/zatca/submissions/${submissionId}/submit`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.submission.state).toBe("reported");
    expect(hitPath).toContain("reporting");
  });
});

describe("Real submission: retry classification", () => {
  it("a transient provider failure (500) persists retry_required, not compliance_failed", async () => {
    await startMockZatcaServer((_req, res) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: "ISS", message: "internal" }));
    });

    const egsUnitId = await onboardEgsUnit();
    const invoiceId = await createInvoice("310000000000003");
    const submissionId = await prepare(egsUnitId, invoiceId);

    const res = await request(app).post(`/api/zatca/submissions/${submissionId}/submit`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(503);
    expect(res.body.category).toBe("external_service");
    expect(res.body.submission.state).toBe("retry_required");
  });

  it("a non-retryable rejection (malformed/invalid request, 400) persists compliance_failed", async () => {
    await startMockZatcaServer((_req, res) => {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: "BAD", message: "bad request" }));
    });

    const egsUnitId = await onboardEgsUnit();
    const invoiceId = await createInvoice("310000000000003");
    const submissionId = await prepare(egsUnitId, invoiceId);

    const res = await request(app).post(`/api/zatca/submissions/${submissionId}/submit`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.category).toBe("validation");
    expect(res.body.submission.state).toBe("compliance_failed");
  });
});

describe("Real submission: rejected business outcome", () => {
  it("a genuine NOT_CLEARED response persists 'rejected' and blocks a further blind resubmit (no second real call)", async () => {
    let hitCount = 0;
    await startMockZatcaServer((_req, res) => {
      hitCount += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ validationResults: { status: "ERROR" }, clearanceStatus: "NOT_CLEARED", clearedInvoice: null }));
    });

    const egsUnitId = await onboardEgsUnit();
    const invoiceId = await createInvoice("310000000000003");
    const submissionId = await prepare(egsUnitId, invoiceId);

    const first = await request(app).post(`/api/zatca/submissions/${submissionId}/submit`).set("Authorization", `Bearer ${token}`);
    expect(first.status).toBe(200);
    expect(first.body.submission.state).toBe("rejected");
    expect(hitCount).toBe(1);

    const second = await request(app).post(`/api/zatca/submissions/${submissionId}/submit`).set("Authorization", `Bearer ${token}`);
    expect(second.body.alreadyAttempted).toBe(true);
    expect(second.body.submission.state).toBe("rejected");
    expect(hitCount).toBe(1); // no second real submission for an already-rejected document
  });
});

describe("Real submission: concurrency", () => {
  it("two simultaneous /submit requests on the same submission result in exactly ONE real provider call", async () => {
    let hitCount = 0;
    await startMockZatcaServer((_req, res) => {
      hitCount += 1;
      // Small delay so both requests are genuinely in flight together.
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ validationResults: { status: "PASS" }, clearanceStatus: "CLEARED", clearedInvoice: "PGE+PC9hPg==" }));
      }, 50);
    });

    const egsUnitId = await onboardEgsUnit();
    const invoiceId = await createInvoice("310000000000003");
    const submissionId = await prepare(egsUnitId, invoiceId);

    const [r1, r2] = await Promise.all([
      request(app).post(`/api/zatca/submissions/${submissionId}/submit`).set("Authorization", `Bearer ${token}`),
      request(app).post(`/api/zatca/submissions/${submissionId}/submit`).set("Authorization", `Bearer ${token}`),
    ]);

    expect(hitCount).toBe(1);
    const alreadyAttemptedFlags = [r1.body.alreadyAttempted, r2.body.alreadyAttempted].sort();
    expect(alreadyAttemptedFlags).toEqual([false, true]);

    const final = await request(app).get(`/api/zatca/submissions/${submissionId}`).set("Authorization", `Bearer ${token}`);
    expect(final.body.state).toBe("cleared");
  });
});
