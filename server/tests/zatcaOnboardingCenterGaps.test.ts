import "reflect-metadata";
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { webcrypto } from "node:crypto";
import http from "node:http";
import * as x509 from "@peculiar/x509";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { useZatcaCsrCurve } from "./helpers/zatcaEnv.js";
import { ZATCA_ONBOARDING_RATE_LIMIT_MAX } from "../src/middleware/rateLimit.js";

// ZATCA Customer Onboarding & Compliance Center — closes two gaps the
// ZATCA Live Sandbox Verification audit found in the existing (pre-Center)
// backend:
//   1. compliance-csid / compliance-invoices / production-csid /
//      production-csid/renew had no HTTP-level cross-tenant regression
//      test (the underlying domain functions were already company-scoped
//      — see domain/*.ts's own "undefined means not found OR not yours"
//      contract — but nothing proved it end-to-end over HTTP for these
//      four routes specifically, unlike csr/csid/submit which already had
//      one each).
//   2. The four new read-only GET routes this Center adds (current CSR
//      instance, compliance lifecycle, compliance attempts, production
//      CSID operations) needed their own tests — they didn't exist before
//      this Center.
// Also covers the new zatcaOnboardingRateLimit (previously only /submit
// had any ZATCA-specific rate limit at all).

vi.mock("../src/lib/mailer.js", () => ({ sendMail: vi.fn() }));

useZatcaCsrCurve();
beforeAll(() => {
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
    .send({ companyName: "Onboarding Center Co A", name: "Owner A", email: uniqueEmail("obc-a"), password: "password123" });
  companyA = resA.body.company.id;
  tokenA = resA.body.token;

  const resB = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Onboarding Center Co B", name: "Owner B", email: uniqueEmail("obc-b"), password: "password123" });
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

async function generateCsr(token: string, egsUnitId: string, otp = "123456") {
  return request(app)
    .post(`/api/zatca/egs-units/${egsUnitId}/csr`)
    .set("Authorization", `Bearer ${token}`)
    .send({ otp, fields: baseFields, customAttributeOids });
}

async function requestComplianceCsid(token: string, egsUnitId: string, csrBase64: string, otp = "123456") {
  return request(app)
    .post(`/api/zatca/egs-units/${egsUnitId}/compliance-csid`)
    .set("Authorization", `Bearer ${token}`)
    .send({ otp, csrBase64 });
}

async function submitComplianceInvoice(token: string, egsUnitId: string) {
  return request(app)
    .post(`/api/zatca/egs-units/${egsUnitId}/compliance-invoices`)
    .set("Authorization", `Bearer ${token}`)
    .send({
      documentType: "388",
      invoiceFamily: "standard",
      invoiceXmlBase64: "PGE+PC9hPg==",
      invoiceHashBase64: "abc123==",
      uuid: "11111111-1111-1111-1111-111111111111",
    });
}

async function requestProductionCsid(token: string, egsUnitId: string) {
  return request(app).post(`/api/zatca/egs-units/${egsUnitId}/production-csid`).set("Authorization", `Bearer ${token}`).send({});
}

async function renewProductionCsid(token: string, egsUnitId: string, csrBase64 = "renewal-csr-base64", otp = "654321") {
  return request(app)
    .post(`/api/zatca/egs-units/${egsUnitId}/production-csid/renew`)
    .set("Authorization", `Bearer ${token}`)
    .send({ csrBase64, otp });
}

// Same fake-FATOORA-server pattern already used throughout this project's
// ZATCA tests (zatcaProvider.test.ts, zatcaComplianceLifecycles.test.ts,
// zatcaComplianceAttempts.test.ts, zatcaProviderOperations.test.ts) —
// never the real ZATCA network. One server answers every path this file's
// tests need.
const ENV_KEYS = [
  "ZATCA_FATOORA_SIMULATION_BASE_URL",
  "ZATCA_FATOORA_SIMULATION_COMPLIANCE_PATH",
  "ZATCA_FATOORA_SIMULATION_COMPLIANCE_CSID_PATH",
  "ZATCA_FATOORA_SIMULATION_PRODUCTION_CSID_PATH",
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
  process.env.ZATCA_FATOORA_SIMULATION_PRODUCTION_CSID_PATH = "production/csids";
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

function allSuccessHandler(): http.RequestListener {
  return (req, res) => {
    if (req.url === "/compliance" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ requestID: 1234567890123, dispositionMessage: "ISSUED", binarySecurityToken: "cert-bytes-base64", secret: "shared-secret-value" }));
      return;
    }
    if (req.url === "/compliance/invoices" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          reportingStatus: "REPORTED",
          validationResults: { status: "PASS" },
          clearanceStatus: null,
          qrSellertStatus: null,
          qrBuyertStatus: null,
        }),
      );
      return;
    }
    if (req.url === "/production/csids" && req.method === "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ requestID: 9988776655, dispositionMessage: "ISSUED", binarySecurityToken: "prod-cert-base64", secret: "prod-secret-value" }));
      return;
    }
    if (req.url === "/production/csids" && req.method === "PATCH") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ requestID: 5544332211, tokenType: "PKCS12", dispositionMessage: "ISSUED", binarySecurityToken: "renewed-cert-base64", secret: "renewed-secret-value" }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unexpected path in test mock" }));
  };
}

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = undefined;
  clearFatooraEnv();
});

describe("TENANT ISOLATION (HTTP-level, Phase 15 coverage gap): compliance-csid / compliance-invoices / production-csid / renewal", () => {
  it("company B cannot request a Compliance CSID for company A's EGS unit", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const csrRes = await generateCsr(tokenA, egsUnitId);
    expect(csrRes.status).toBe(201);

    const server = await startMockFatoora(allSuccessHandler());
    cleanup = server.close;
    setFatooraEnv(server.url);

    const res = await requestComplianceCsid(tokenB, egsUnitId, csrRes.body.csrDerBase64);
    expect(res.status).toBe(404);
  });

  it("company B cannot submit a Compliance Invoice for company A's EGS unit", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const csrRes = await generateCsr(tokenA, egsUnitId);
    const server = await startMockFatoora(allSuccessHandler());
    cleanup = server.close;
    setFatooraEnv(server.url);
    await requestComplianceCsid(tokenA, egsUnitId, csrRes.body.csrDerBase64);

    const res = await submitComplianceInvoice(tokenB, egsUnitId);
    expect(res.status).toBe(404);
  });

  it("company B cannot request a Production CSID for company A's EGS unit", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const csrRes = await generateCsr(tokenA, egsUnitId);
    const server = await startMockFatoora(allSuccessHandler());
    cleanup = server.close;
    setFatooraEnv(server.url);
    await requestComplianceCsid(tokenA, egsUnitId, csrRes.body.csrDerBase64);

    const res = await requestProductionCsid(tokenB, egsUnitId);
    expect(res.status).toBe(404);
  });

  it("company B cannot renew a Production CSID for company A's EGS unit", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const server = await startMockFatoora(allSuccessHandler());
    cleanup = server.close;
    setFatooraEnv(server.url);

    const res = await renewProductionCsid(tokenB, egsUnitId);
    expect(res.status).toBe(404);
  });

  it("none of the four cross-tenant rejections leak any real credential/secret value from company A's setup", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const csrRes = await generateCsr(tokenA, egsUnitId);
    const server = await startMockFatoora(allSuccessHandler());
    cleanup = server.close;
    setFatooraEnv(server.url);
    await requestComplianceCsid(tokenA, egsUnitId, csrRes.body.csrDerBase64);

    const results = await Promise.all([
      requestComplianceCsid(tokenB, egsUnitId, csrRes.body.csrDerBase64),
      submitComplianceInvoice(tokenB, egsUnitId),
      requestProductionCsid(tokenB, egsUnitId),
      renewProductionCsid(tokenB, egsUnitId),
    ]);
    const serialized = results.map((r) => JSON.stringify(r.body)).join("|");
    expect(serialized).not.toContain("cert-bytes-base64");
    expect(serialized).not.toContain("shared-secret-value");
    expect(serialized).not.toContain("prod-cert-base64");
    expect(serialized).not.toContain("prod-secret-value");
  });
});

describe("GET /api/zatca/egs-units/:id/csr (read-only current CSR instance)", () => {
  it("returns null when no CSR has ever been generated for this unit", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const res = await request(app).get(`/api/zatca/egs-units/${egsUnitId}/csr`).set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.csrInstance).toBeNull();
  });

  it("returns the current CSR instance's safe metadata after generation, never the private key", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const csrRes = await generateCsr(tokenA, egsUnitId);
    expect(csrRes.status).toBe(201);

    const res = await request(app).get(`/api/zatca/egs-units/${egsUnitId}/csr`).set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.csrInstance).toMatchObject({ invoiceType: baseFields.invoiceType, status: "generated" });
    expect(res.body.csrInstance.id).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(res.body)).not.toContain("secretRef");
  });

  it("a regenerated CSR supersedes the prior one — this route always returns the current, not-superseded instance", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const first = await generateCsr(tokenA, egsUnitId);
    const second = await generateCsr(tokenA, egsUnitId);
    expect(second.status).toBe(201);

    const res = await request(app).get(`/api/zatca/egs-units/${egsUnitId}/csr`).set("Authorization", `Bearer ${tokenA}`);
    expect(res.body.csrInstance.status).toBe("generated");
  });

  it("404s for an unknown EGS unit", async () => {
    const res = await request(app)
      .get("/api/zatca/egs-units/00000000-0000-0000-0000-000000000000/csr")
      .set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(404);
  });

  it("TENANT ISOLATION: company B cannot read company A's CSR instance", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    await generateCsr(tokenA, egsUnitId);
    const res = await request(app).get(`/api/zatca/egs-units/${egsUnitId}/csr`).set("Authorization", `Bearer ${tokenB}`);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/zatca/egs-units/:id/compliance-csid (read-only compliance lifecycle)", () => {
  it("returns null before any CSR/Compliance CSID request", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const res = await request(app).get(`/api/zatca/egs-units/${egsUnitId}/compliance-csid`).set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.complianceLifecycle).toBeNull();
  });

  it("returns the lifecycle's safe metadata after a real request, never the secretRef", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const csrRes = await generateCsr(tokenA, egsUnitId);
    const server = await startMockFatoora(allSuccessHandler());
    cleanup = server.close;
    setFatooraEnv(server.url);
    const postRes = await requestComplianceCsid(tokenA, egsUnitId, csrRes.body.csrDerBase64);
    expect(postRes.status).toBe(201);

    const res = await request(app).get(`/api/zatca/egs-units/${egsUnitId}/compliance-csid`).set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.complianceLifecycle).toMatchObject({ requestId: "1234567890123", dispositionMessage: "ISSUED", status: "issued" });
    expect(JSON.stringify(res.body)).not.toContain("shared-secret-value");
    expect(JSON.stringify(res.body)).not.toContain("cert-bytes-base64");
    expect(JSON.stringify(res.body)).not.toContain("secretRef");
  });

  it("TENANT ISOLATION: company B cannot read company A's compliance lifecycle", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const csrRes = await generateCsr(tokenA, egsUnitId);
    const server = await startMockFatoora(allSuccessHandler());
    cleanup = server.close;
    setFatooraEnv(server.url);
    await requestComplianceCsid(tokenA, egsUnitId, csrRes.body.csrDerBase64);

    const res = await request(app).get(`/api/zatca/egs-units/${egsUnitId}/compliance-csid`).set("Authorization", `Bearer ${tokenB}`);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/zatca/egs-units/:id/compliance-invoices (read-only compliance attempt history)", () => {
  it("returns an empty list before any Compliance Invoice attempt", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const res = await request(app).get(`/api/zatca/egs-units/${egsUnitId}/compliance-invoices`).set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.attempts).toEqual([]);
  });

  it("lists a real attempt's safe outcome fields, never document XML/hash or credentials", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const csrRes = await generateCsr(tokenA, egsUnitId);
    const server = await startMockFatoora(allSuccessHandler());
    cleanup = server.close;
    setFatooraEnv(server.url);
    await requestComplianceCsid(tokenA, egsUnitId, csrRes.body.csrDerBase64);
    const attemptRes = await submitComplianceInvoice(tokenA, egsUnitId);
    expect(attemptRes.status).toBe(201);

    const res = await request(app).get(`/api/zatca/egs-units/${egsUnitId}/compliance-invoices`).set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.attempts).toHaveLength(1);
    expect(res.body.attempts[0]).toMatchObject({ documentType: "388", invoiceFamily: "standard", normalizedOutcome: "compliance_pending" });
    expect(JSON.stringify(res.body)).not.toContain("PGE+PC9hPg==");
    expect(JSON.stringify(res.body)).not.toContain("shared-secret-value");
  });

  it("TENANT ISOLATION: company B sees an empty list, never company A's compliance attempts", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const csrRes = await generateCsr(tokenA, egsUnitId);
    const server = await startMockFatoora(allSuccessHandler());
    cleanup = server.close;
    setFatooraEnv(server.url);
    await requestComplianceCsid(tokenA, egsUnitId, csrRes.body.csrDerBase64);
    await submitComplianceInvoice(tokenA, egsUnitId);

    // company B doesn't own this EGS unit at all -> 404, not an empty list
    // for someone else's data.
    const res = await request(app).get(`/api/zatca/egs-units/${egsUnitId}/compliance-invoices`).set("Authorization", `Bearer ${tokenB}`);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/zatca/egs-units/:id/production-csid (read-only production CSID operation history)", () => {
  it("returns an empty list before any Production CSID operation", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const res = await request(app).get(`/api/zatca/egs-units/${egsUnitId}/production-csid`).set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.operations).toEqual([]);
  });

  it("lists onboarding + renewal operations, most recent first, never a secretRef", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const csrRes = await generateCsr(tokenA, egsUnitId);
    const server = await startMockFatoora(allSuccessHandler());
    cleanup = server.close;
    setFatooraEnv(server.url);
    await requestComplianceCsid(tokenA, egsUnitId, csrRes.body.csrDerBase64);
    const onboardRes = await requestProductionCsid(tokenA, egsUnitId);
    expect(onboardRes.status).toBe(201);
    const renewRes = await renewProductionCsid(tokenA, egsUnitId);
    expect(renewRes.status).toBe(201);

    const res = await request(app).get(`/api/zatca/egs-units/${egsUnitId}/production-csid`).set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.operations).toHaveLength(2);
    expect(res.body.operations.map((o: { operationType: string }) => o.operationType).sort()).toEqual(
      ["production_csid_onboarding", "production_csid_renewal"].sort(),
    );
    expect(JSON.stringify(res.body)).not.toContain("prod-cert-base64");
    expect(JSON.stringify(res.body)).not.toContain("prod-secret-value");
    expect(JSON.stringify(res.body)).not.toContain("renewed-secret-value");
    expect(JSON.stringify(res.body)).not.toContain("secretRef");
  });

  it("TENANT ISOLATION: company B cannot read company A's production CSID operations", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const res = await request(app).get(`/api/zatca/egs-units/${egsUnitId}/production-csid`).set("Authorization", `Bearer ${tokenB}`);
    expect(res.status).toBe(404);
  });
});

describe("zatcaOnboardingRateLimit (Phase 16 — previously only /submit had any ZATCA rate limit)", () => {
  it("verify-connection eventually receives 429, keyed per company", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    let lastStatus = 0;
    for (let i = 0; i < ZATCA_ONBOARDING_RATE_LIMIT_MAX + 5; i++) {
      const res = await request(app)
        .post(`/api/zatca/egs-units/${egsUnitId}/verify-connection`)
        .set("Authorization", `Bearer ${tokenA}`);
      lastStatus = res.status;
      if (lastStatus === 429) break;
    }
    expect(lastStatus).toBe(429);
  });
});
