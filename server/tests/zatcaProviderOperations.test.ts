import "reflect-metadata";
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { webcrypto } from "node:crypto";
import http from "node:http";
import * as x509 from "@peculiar/x509";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { useZatcaCsrCurve } from "./helpers/zatcaEnv.js";

// Slice W — internal historical execution layer for Production CSID
// Onboarding and Renewal (zatca_provider_operations). See
// domain/productionCsid.ts's file comment for the exact scope boundary
// this file tests: technical execution history only, never a compliance-
// completion claim. This file does not test, and must never test,
// "onboarding completed"/"renewal completed"/any compliance verdict —
// none of those exist in the implementation.

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
    .send({ companyName: "Provider Ops Co A", name: "Owner A", email: uniqueEmail("povA"), password: "password123" });
  companyA = resA.body.company.id;
  tokenA = resA.body.token;

  const resB = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Provider Ops Co B", name: "Owner B", email: uniqueEmail("povB"), password: "password123" });
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
// ZATCA tests — never the real ZATCA network. One server handles the
// Compliance CSID path ("/compliance") and the Production CSID path
// ("/production/csids", both POST for onboarding and PATCH for renewal —
// the real endpoints share one path, see fatooraClient.ts) by branching
// on req.url + req.method.
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

type OnboardingOutcome = "issued" | "server_error";
type RenewalOutcome = "issued" | "not_compliant" | "server_error";

function comboHandler(opts: { onboarding?: OnboardingOutcome; renewal?: RenewalOutcome } = {}): http.RequestListener {
  return (req, res) => {
    if (req.url === "/production/csids" && req.method === "POST") {
      const outcome = opts.onboarding ?? "issued";
      if (outcome === "server_error") {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: "Invalid-Request", message: "System failed to process your request" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          requestID: 1642424139872,
          dispositionMessage: "ISSUED",
          binarySecurityToken: "production-cert-bytes",
          secret: "production-shared-secret",
        }),
      );
      return;
    }
    if (req.url === "/production/csids" && req.method === "PATCH") {
      const outcome = opts.renewal ?? "issued";
      if (outcome === "server_error") {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: "Invalid-Request", message: "System failed to process your request" }));
        return;
      }
      if (outcome === "not_compliant") {
        res.writeHead(428, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            value: {
              requestID: 1234567890123,
              tokenType: null,
              dispositionMessage: "NOT_COMPLIANT",
              binarySecurityToken: "renewal-not-compliant-cert",
              secret: "renewal-not-compliant-secret",
            },
          }),
        );
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          requestID: 347,
          tokenType: "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3",
          dispositionMessage: "ISSUED",
          binarySecurityToken: "renewal-cert-bytes",
          secret: "renewal-shared-secret",
        }),
      );
      return;
    }
    if (req.url === "/compliance/invoices") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ reportingStatus: "REPORTED", validationResults: { status: "PASS" }, clearanceStatus: null, qrSellertStatus: null, qrBuyertStatus: null }),
      );
      return;
    }
    // "/compliance" — Compliance CSID.
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        requestID: 1234567890123,
        dispositionMessage: "ISSUED",
        binarySecurityToken: "compliance-cert-bytes",
        secret: "compliance-shared-secret",
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

// Drives an EGS unit to an "issued" Compliance Lifecycle — the
// prerequisite for Production CSID Onboarding — against whatever mock
// server is currently configured.
async function setUpComplianceLifecycle(token: string, egsUnitId: string) {
  const csrRes = await generateCsr(token, egsUnitId);
  const csidRes = await requestComplianceCsid(token, egsUnitId, csrRes.body.csrDerBase64);
  expect(csidRes.status).toBe(201);
}

describe("Slice W — Production CSID Onboarding: successful operation history", () => {
  it("persists exactly one provider operation with correct company/EGS unit, technical status, and no secret leakage", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const server = await startMockFatoora(comboHandler());
    cleanup = server.close;
    setFatooraEnv(server.url);
    await setUpComplianceLifecycle(tokenA, egsUnitId);

    const res = await requestProductionCsid(tokenA, egsUnitId);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ requestId: "1642424139872", dispositionMessage: "ISSUED" });

    const { listProviderOperationsForEgsUnit } = await import("../src/lib/zatca/domain/index.js");
    const ops = await listProviderOperationsForEgsUnit(companyA, egsUnitId);
    expect(ops).toHaveLength(1);
    const op = ops[0];
    expect(op.companyId).toBe(companyA);
    expect(op.egsUnitId).toBe(egsUnitId);
    expect(op.operationType).toBe("production_csid_onboarding");
    expect(op.internalStatus).toBe("response_received");
    expect(op.providerRequestId).toBe("1642424139872");
    expect(op.dispositionMessage).toBe("ISSUED");
    expect(op.providerOutcome).toBeNull();
    expect(op.errorCategory).toBeNull();
    expect(op.secretRef).toBeTruthy();
    expect(op.startedAt).toBeInstanceOf(Date);
    expect(op.finishedAt).toBeInstanceOf(Date);
    expect(op.finishedAt.getTime()).toBeGreaterThanOrEqual(op.startedAt.getTime());

    const { getZatcaSecretStore } = await import("../src/lib/zatca/secretStore/index.js");
    const secret = await getZatcaSecretStore().resolve(companyA, op.secretRef!);
    expect(secret?.binarySecurityToken).toBe("production-cert-bytes");
  });

  it("does not touch egsUnit.csidStatus and does not modify the Compliance Lifecycle", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const server = await startMockFatoora(comboHandler());
    cleanup = server.close;
    setFatooraEnv(server.url);
    await setUpComplianceLifecycle(tokenA, egsUnitId);

    const { getEgsUnit, listCsrInstancesForEgsUnit, getComplianceLifecycleForCsrInstance } = await import("../src/lib/zatca/domain/index.js");
    const beforeUnit = await getEgsUnit(companyA, egsUnitId);
    const [csrInstance] = await listCsrInstancesForEgsUnit(companyA, egsUnitId);
    const beforeLifecycle = await getComplianceLifecycleForCsrInstance(companyA, csrInstance.id);

    const res = await requestProductionCsid(tokenA, egsUnitId);
    expect(res.status).toBe(201);

    const afterUnit = await getEgsUnit(companyA, egsUnitId);
    const afterLifecycle = await getComplianceLifecycleForCsrInstance(companyA, csrInstance.id);
    expect(afterUnit!.csidStatus).toBe(beforeUnit!.csidStatus);
    expect(afterLifecycle!.status).toBe(beforeLifecycle!.status);
    expect(afterLifecycle!.updatedAt).toEqual(beforeLifecycle!.updatedAt);
  });
});

describe("Slice W — Production CSID Onboarding: failure handling", () => {
  it("persists an operation with internalStatus=failed and errorCategory when the provider call throws; no secretRef", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const server = await startMockFatoora(comboHandler({ onboarding: "server_error" }));
    cleanup = server.close;
    setFatooraEnv(server.url);
    await setUpComplianceLifecycle(tokenA, egsUnitId);

    const res = await requestProductionCsid(tokenA, egsUnitId);
    expect(res.status).toBe(503);
    expect(res.body.category).toBe("external_service");

    const { listProviderOperationsForEgsUnit } = await import("../src/lib/zatca/domain/index.js");
    const ops = await listProviderOperationsForEgsUnit(companyA, egsUnitId);
    expect(ops).toHaveLength(1);
    expect(ops[0].internalStatus).toBe("failed");
    expect(ops[0].errorCategory).toBe("external_service");
    expect(ops[0].secretRef).toBeNull();
    expect(ops[0].providerRequestId).toBeNull();
  });

  it("creates no operation row when no CSR/Compliance Lifecycle exists yet (pre-flight failure, provider never called)", async () => {
    const egsUnitId = await createEgsUnit(tokenA);

    const res = await requestProductionCsid(tokenA, egsUnitId);
    expect(res.status).toBe(400);
    expect(res.body.category).toBe("configuration");

    const { listProviderOperationsForEgsUnit } = await import("../src/lib/zatca/domain/index.js");
    expect(await listProviderOperationsForEgsUnit(companyA, egsUnitId)).toHaveLength(0);
  });
});

describe("Slice W — Production CSID Renewal: successful operation history", () => {
  it("records internalStatus=response_received and providerOutcome=issued for a genuine 'issued' response", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const server = await startMockFatoora(comboHandler({ renewal: "issued" }));
    cleanup = server.close;
    setFatooraEnv(server.url);

    const res = await renewProductionCsid(tokenA, egsUnitId);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ requestId: "347", dispositionMessage: "ISSUED", outcome: "issued" });

    const { listProviderOperationsForEgsUnit } = await import("../src/lib/zatca/domain/index.js");
    const ops = await listProviderOperationsForEgsUnit(companyA, egsUnitId);
    expect(ops).toHaveLength(1);
    expect(ops[0].operationType).toBe("production_csid_renewal");
    expect(ops[0].internalStatus).toBe("response_received");
    expect(ops[0].providerOutcome).toBe("issued");
    expect(ops[0].errorCategory).toBeNull();
    expect(ops[0].secretRef).toBeTruthy();
  });

  it("records internalStatus=response_received (NOT failed) and providerOutcome=not_compliant for a genuine 428 response, and still stores its credential", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const server = await startMockFatoora(comboHandler({ renewal: "not_compliant" }));
    cleanup = server.close;
    setFatooraEnv(server.url);

    const res = await renewProductionCsid(tokenA, egsUnitId);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ requestId: "1234567890123", dispositionMessage: "NOT_COMPLIANT", outcome: "not_compliant" });

    const { listProviderOperationsForEgsUnit } = await import("../src/lib/zatca/domain/index.js");
    const ops = await listProviderOperationsForEgsUnit(companyA, egsUnitId);
    expect(ops).toHaveLength(1);
    // Critical: "not_compliant" is a real received response, not a
    // technical failure — internalStatus must reflect that distinction.
    expect(ops[0].internalStatus).toBe("response_received");
    expect(ops[0].providerOutcome).toBe("not_compliant");
    expect(ops[0].errorCategory).toBeNull();
    expect(ops[0].secretRef).toBeTruthy();

    const { getZatcaSecretStore } = await import("../src/lib/zatca/secretStore/index.js");
    const secret = await getZatcaSecretStore().resolve(companyA, ops[0].secretRef!);
    expect(secret?.binarySecurityToken).toBe("renewal-not-compliant-cert");
  });
});

describe("Slice W — Production CSID Renewal: failure handling", () => {
  it("persists internalStatus=failed with errorCategory on a transport/protocol failure; no secretRef, no providerOutcome", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const server = await startMockFatoora(comboHandler({ renewal: "server_error" }));
    cleanup = server.close;
    setFatooraEnv(server.url);

    const res = await renewProductionCsid(tokenA, egsUnitId);
    expect(res.status).toBe(503);
    expect(res.body.category).toBe("external_service");

    const { listProviderOperationsForEgsUnit } = await import("../src/lib/zatca/domain/index.js");
    const ops = await listProviderOperationsForEgsUnit(companyA, egsUnitId);
    expect(ops).toHaveLength(1);
    expect(ops[0].internalStatus).toBe("failed");
    expect(ops[0].errorCategory).toBe("external_service");
    expect(ops[0].secretRef).toBeNull();
    expect(ops[0].providerOutcome).toBeNull();
  });

  it("rejects a request missing csrBase64/otp with a 400 before ever calling the provider", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const res = await request(app)
      .post(`/api/zatca/egs-units/${egsUnitId}/production-csid/renew`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({});
    expect(res.status).toBe(400);

    const { listProviderOperationsForEgsUnit } = await import("../src/lib/zatca/domain/index.js");
    expect(await listProviderOperationsForEgsUnit(companyA, egsUnitId)).toHaveLength(0);
  });
});

describe("Slice W — tenant isolation", () => {
  it("company B cannot request a Production CSID for company A's EGS unit", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const server = await startMockFatoora(comboHandler());
    cleanup = server.close;
    setFatooraEnv(server.url);
    await setUpComplianceLifecycle(tokenA, egsUnitId);

    const res = await requestProductionCsid(tokenB, egsUnitId);
    expect(res.status).toBe(404);
  });

  it("company B cannot renew a Production CSID for company A's EGS unit", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const res = await renewProductionCsid(tokenB, egsUnitId);
    expect(res.status).toBe(404);
  });

  it("company B's provider-operation lookups never see company A's rows", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const server = await startMockFatoora(comboHandler());
    cleanup = server.close;
    setFatooraEnv(server.url);
    await setUpComplianceLifecycle(tokenA, egsUnitId);
    await requestProductionCsid(tokenA, egsUnitId);

    const { listProviderOperationsForEgsUnit, getProviderOperation } = await import("../src/lib/zatca/domain/index.js");
    expect(await listProviderOperationsForEgsUnit(companyB, egsUnitId)).toHaveLength(0);

    const [opForA] = await listProviderOperationsForEgsUnit(companyA, egsUnitId);
    expect(await getProviderOperation(companyB, opForA.id)).toBeUndefined();
  });
});

describe("Slice W — credential leakage", () => {
  it("never stores or returns raw credential material anywhere — DB rows, audit events, or API responses", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const server = await startMockFatoora(comboHandler());
    cleanup = server.close;
    setFatooraEnv(server.url);
    await setUpComplianceLifecycle(tokenA, egsUnitId);

    const onboardRes = await requestProductionCsid(tokenA, egsUnitId);
    expect(onboardRes.status).toBe(201);
    const renewRes = await renewProductionCsid(tokenA, egsUnitId);
    expect(renewRes.status).toBe(201);

    const combinedResponseJson = JSON.stringify(onboardRes.body) + JSON.stringify(renewRes.body);
    expect(combinedResponseJson).not.toContain("production-cert-bytes");
    expect(combinedResponseJson).not.toContain("production-shared-secret");
    expect(combinedResponseJson).not.toContain("renewal-cert-bytes");
    expect(combinedResponseJson).not.toContain("renewal-shared-secret");
    expect(combinedResponseJson).not.toContain("secretRef");

    const { listProviderOperationsForEgsUnit } = await import("../src/lib/zatca/domain/index.js");
    const ops = await listProviderOperationsForEgsUnit(companyA, egsUnitId);
    const opsJson = JSON.stringify(ops);
    expect(opsJson).not.toContain("production-cert-bytes");
    expect(opsJson).not.toContain("production-shared-secret");
    expect(opsJson).not.toContain("renewal-cert-bytes");
    expect(opsJson).not.toContain("renewal-shared-secret");

    const auditRows = await db.query.auditEvents.findMany({ where: (a, { eq }) => eq(a.entityId, egsUnitId) });
    const auditJson = JSON.stringify(auditRows);
    expect(auditJson).not.toContain("production-cert-bytes");
    expect(auditJson).not.toContain("production-shared-secret");
    expect(auditJson).not.toContain("renewal-cert-bytes");
    expect(auditJson).not.toContain("renewal-shared-secret");
    expect(auditJson).toContain("zatca.productionCsid.onboardingRequested");
    expect(auditJson).toContain("zatca.productionCsid.renewalRequested");
  });
});
