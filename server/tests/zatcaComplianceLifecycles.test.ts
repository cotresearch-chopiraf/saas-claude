import "reflect-metadata";
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { webcrypto } from "node:crypto";
import http from "node:http";
import * as x509 from "@peculiar/x509";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";

// Slice L — Compliance Lifecycle persistence (CSR Instance -> Compliance
// Lifecycle, 1:0..1). See docs/zatca (Slices D-I) for the architecture
// this implements; this file tests only the persistence layer added this
// slice, not Compliance Attempts, Compliance Steps, Production Lifecycle,
// or renewal — all still out of scope.

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
    .send({ companyName: "Compliance Lifecycle Co A", name: "Owner A", email: uniqueEmail("cplc-a"), password: "password123" });
  companyA = resA.body.company.id;
  tokenA = resA.body.token;

  const resB = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Compliance Lifecycle Co B", name: "Owner B", email: uniqueEmail("cplc-b"), password: "password123" });
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

// Same fake-FATOORA-server pattern already used by zatcaProvider.test.ts
// and zatcaConfigRoutes.test.ts's verify-connection tests — never the
// real ZATCA network.
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

function issuedHandler(binarySecurityToken = "cert-bytes-base64", secret = "shared-secret-value"): http.RequestListener {
  return (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ requestID: 1234567890123, dispositionMessage: "ISSUED", binarySecurityToken, secret }));
  };
}

function invalidOtpHandler(): http.RequestListener {
  return (_req, res) => {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ errors: [{ code: "Invalid-OTP", message: "The provided OTP is invalid" }] }));
  };
}

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = undefined;
  clearFatooraEnv();
});

async function requestComplianceCsid(token: string, egsUnitId: string, csrBase64: string, otp = "123456") {
  return request(app)
    .post(`/api/zatca/egs-units/${egsUnitId}/compliance-csid`)
    .set("Authorization", `Bearer ${token}`)
    .send({ otp, csrBase64 });
}

describe("Slice L — Compliance Lifecycle persistence: Test 1, creation", () => {
  it("creates exactly one Compliance Lifecycle for the CSR Instance, with all fields correct", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const csrRes = await generateCsr(tokenA, egsUnitId);
    expect(csrRes.status).toBe(201);

    const server = await startMockFatoora(issuedHandler());
    cleanup = server.close;
    setFatooraEnv(server.url);

    const res = await requestComplianceCsid(tokenA, egsUnitId, csrRes.body.csrDerBase64);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ requestId: "1234567890123", dispositionMessage: "ISSUED" });

    const { getCsrInstance, listCsrInstancesForEgsUnit, getComplianceLifecycleForCsrInstance } = await import(
      "../src/lib/zatca/domain/index.js"
    );
    const [csrInstance] = await listCsrInstancesForEgsUnit(companyA, egsUnitId);
    const lifecycle = await getComplianceLifecycleForCsrInstance(companyA, csrInstance.id);
    expect(lifecycle).toBeTruthy();
    expect(lifecycle!.companyId).toBe(companyA);
    expect(lifecycle!.csrInstanceId).toBe(csrInstance.id);
    expect(lifecycle!.requestId).toBe("1234567890123");
    expect(lifecycle!.dispositionMessage).toBe("ISSUED");
    expect(lifecycle!.status).toBe("issued");
    expect(lifecycle!.startedAt).toBeInstanceOf(Date);
    expect(lifecycle!.secretRef).toBeTruthy();
    // getCsrInstance is exercised here too, confirming both lookups agree.
    expect((await getCsrInstance(companyA, csrInstance.id))!.id).toBe(csrInstance.id);
  });
});

describe("Slice L — Compliance Lifecycle persistence: Test 2, one lifecycle per CSR", () => {
  it("rejects a second Compliance CSID request for the same CSR Instance without overwriting the first", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const csrRes = await generateCsr(tokenA, egsUnitId);

    const server = await startMockFatoora(issuedHandler());
    cleanup = server.close;
    setFatooraEnv(server.url);

    const first = await requestComplianceCsid(tokenA, egsUnitId, csrRes.body.csrDerBase64);
    expect(first.status).toBe(201);

    const second = await requestComplianceCsid(tokenA, egsUnitId, csrRes.body.csrDerBase64);
    expect(second.status).toBe(409);
    expect(second.body.category).toBe("duplicate");

    const { listCsrInstancesForEgsUnit, getComplianceLifecycleForCsrInstance } = await import("../src/lib/zatca/domain/index.js");
    const [csrInstance] = await listCsrInstancesForEgsUnit(companyA, egsUnitId);
    const lifecycle = await getComplianceLifecycleForCsrInstance(companyA, csrInstance.id);
    expect(lifecycle!.requestId).toBe("1234567890123");
    expect(lifecycle!.dispositionMessage).toBe("ISSUED");
  });
});

describe("Slice L — Compliance Lifecycle persistence: Test 3, CSR relationship", () => {
  it("attaches a Compliance Lifecycle to exactly the CSR Instance that requested it, not any other", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const csrA = await generateCsr(tokenA, egsUnitId, "1000");

    const server = await startMockFatoora(issuedHandler());
    cleanup = server.close;
    setFatooraEnv(server.url);

    const res = await requestComplianceCsid(tokenA, egsUnitId, csrA.body.csrDerBase64);
    expect(res.status).toBe(201);

    const { listCsrInstancesForEgsUnit, getComplianceLifecycleForCsrInstance } = await import("../src/lib/zatca/domain/index.js");
    const [csrInstanceA] = await listCsrInstancesForEgsUnit(companyA, egsUnitId);

    const lifecycleForA = await getComplianceLifecycleForCsrInstance(companyA, csrInstanceA.id);
    expect(lifecycleForA).toBeTruthy();
    expect(lifecycleForA!.csrInstanceId).toBe(csrInstanceA.id);

    // A CSR Instance that never requested a Compliance CSID has none.
    const otherEgsUnitId = await createEgsUnit(tokenA);
    await generateCsr(tokenA, otherEgsUnitId, "0100");
    const [csrInstanceOther] = await listCsrInstancesForEgsUnit(companyA, otherEgsUnitId);
    const lifecycleForOther = await getComplianceLifecycleForCsrInstance(companyA, csrInstanceOther.id);
    expect(lifecycleForOther).toBeUndefined();
  });
});

describe("Slice L — Compliance Lifecycle persistence: Test 4, compliance secret isolation", () => {
  it("gives the Compliance Lifecycle its own secretRef, independent from and different than the CSR Instance's", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const csrRes = await generateCsr(tokenA, egsUnitId);

    const server = await startMockFatoora(issuedHandler());
    cleanup = server.close;
    setFatooraEnv(server.url);

    const res = await requestComplianceCsid(tokenA, egsUnitId, csrRes.body.csrDerBase64);
    expect(res.status).toBe(201);

    const { listCsrInstancesForEgsUnit, getComplianceLifecycleForCsrInstance } = await import("../src/lib/zatca/domain/index.js");
    const [csrInstance] = await listCsrInstancesForEgsUnit(companyA, egsUnitId);
    const lifecycle = await getComplianceLifecycleForCsrInstance(companyA, csrInstance.id);

    expect(lifecycle!.secretRef).not.toBe(csrInstance.secretRef);

    const { getZatcaSecretStore } = await import("../src/lib/zatca/secretStore/index.js");
    const csrSecret = await getZatcaSecretStore().resolve(companyA, csrInstance.secretRef);
    const complianceSecret = await getZatcaSecretStore().resolve(companyA, lifecycle!.secretRef);
    expect(csrSecret).toBeTruthy();
    expect(complianceSecret).toBeTruthy();
    expect(csrSecret!.privateKeyPem).toBeTruthy();
    expect(complianceSecret!.binarySecurityToken).toBe("cert-bytes-base64");
    expect(complianceSecret!.secret).toBe("shared-secret-value");
  });
});

describe("Slice L — Compliance Lifecycle persistence: Test 5, CSR secret preservation", () => {
  it("does not delete or alter the CSR Instance's secretRef when a Compliance Lifecycle is created", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const csrRes = await generateCsr(tokenA, egsUnitId);

    const { listCsrInstancesForEgsUnit } = await import("../src/lib/zatca/domain/index.js");
    const [csrInstanceBefore] = await listCsrInstancesForEgsUnit(companyA, egsUnitId);

    const server = await startMockFatoora(issuedHandler());
    cleanup = server.close;
    setFatooraEnv(server.url);

    const res = await requestComplianceCsid(tokenA, egsUnitId, csrRes.body.csrDerBase64);
    expect(res.status).toBe(201);

    const [csrInstanceAfter] = await listCsrInstancesForEgsUnit(companyA, egsUnitId);
    expect(csrInstanceAfter.secretRef).toBe(csrInstanceBefore.secretRef);
    expect(csrInstanceAfter.status).toBe("generated");

    const { getZatcaSecretStore } = await import("../src/lib/zatca/secretStore/index.js");
    const stillResolvable = await getZatcaSecretStore().resolve(companyA, csrInstanceBefore.secretRef);
    expect(stillResolvable).toBeTruthy();
    expect(stillResolvable!.privateKeyPem).toBeTruthy();
  });
});

describe("Slice L — Compliance Lifecycle persistence: Test 6, multiple CSR lifecycles", () => {
  it("gives two different CSR Instances of the same EGS unit two independent, both-queryable Compliance Lifecycles", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const csrA = await generateCsr(tokenA, egsUnitId, "1000");

    const serverA = await startMockFatoora(issuedHandler("cert-a", "secret-a"));
    setFatooraEnv(serverA.url);
    const resA = await requestComplianceCsid(tokenA, egsUnitId, csrA.body.csrDerBase64);
    expect(resA.status).toBe(201);
    await serverA.close();

    const csrB = await generateCsr(tokenA, egsUnitId, "0100");
    const serverB = await startMockFatoora(issuedHandler("cert-b", "secret-b"));
    cleanup = serverB.close;
    setFatooraEnv(serverB.url);
    const resB = await requestComplianceCsid(tokenA, egsUnitId, csrB.body.csrDerBase64);
    expect(resB.status).toBe(201);

    const { listCsrInstancesForEgsUnit, getComplianceLifecycleForCsrInstance } = await import("../src/lib/zatca/domain/index.js");
    const rows = await listCsrInstancesForEgsUnit(companyA, egsUnitId);
    expect(rows).toHaveLength(2);
    const [newest, oldest] = rows;

    const lifecycleOldest = await getComplianceLifecycleForCsrInstance(companyA, oldest.id);
    const lifecycleNewest = await getComplianceLifecycleForCsrInstance(companyA, newest.id);
    expect(lifecycleOldest).toBeTruthy();
    expect(lifecycleNewest).toBeTruthy();
    expect(lifecycleOldest!.id).not.toBe(lifecycleNewest!.id);
    expect(lifecycleOldest!.secretRef).not.toBe(lifecycleNewest!.secretRef);

    const { getZatcaSecretStore } = await import("../src/lib/zatca/secretStore/index.js");
    const secretOldest = await getZatcaSecretStore().resolve(companyA, lifecycleOldest!.secretRef);
    const secretNewest = await getZatcaSecretStore().resolve(companyA, lifecycleNewest!.secretRef);
    expect(secretOldest!.binarySecurityToken).toBe("cert-a");
    expect(secretNewest!.binarySecurityToken).toBe("cert-b");
  });
});

describe("Slice L — Compliance Lifecycle persistence: Test 7, failure response", () => {
  it("persists no Compliance Lifecycle row when ZATCA rejects the Compliance CSID request", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const csrRes = await generateCsr(tokenA, egsUnitId);

    const server = await startMockFatoora(invalidOtpHandler());
    cleanup = server.close;
    setFatooraEnv(server.url);

    const res = await requestComplianceCsid(tokenA, egsUnitId, csrRes.body.csrDerBase64, "000000");
    expect(res.status).toBe(400);
    expect(res.body.category).toBe("validation");

    const { listCsrInstancesForEgsUnit, getComplianceLifecycleForCsrInstance } = await import("../src/lib/zatca/domain/index.js");
    const [csrInstance] = await listCsrInstancesForEgsUnit(companyA, egsUnitId);
    const lifecycle = await getComplianceLifecycleForCsrInstance(companyA, csrInstance.id);
    expect(lifecycle).toBeUndefined();
  });

  it("returns a configuration error and creates no lifecycle when no CSR Instance exists for this EGS unit yet", async () => {
    const egsUnitId = await createEgsUnit(tokenA);

    const res = await requestComplianceCsid(tokenA, egsUnitId, "irrelevant-csr-base64");
    expect(res.status).toBe(400);
    expect(res.body.category).toBe("configuration");
  });
});

describe("Slice L — Compliance Lifecycle persistence: Test 8, tenant isolation", () => {
  it("company B cannot request a Compliance CSID for company A's EGS unit / CSR Instance", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const csrRes = await generateCsr(tokenA, egsUnitId);

    const res = await requestComplianceCsid(tokenB, egsUnitId, csrRes.body.csrDerBase64);
    expect(res.status).toBe(404);
  });

  it("company B's own Compliance Lifecycle lookups never see company A's rows", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const csrRes = await generateCsr(tokenA, egsUnitId);

    const server = await startMockFatoora(issuedHandler());
    cleanup = server.close;
    setFatooraEnv(server.url);
    const res = await requestComplianceCsid(tokenA, egsUnitId, csrRes.body.csrDerBase64);
    expect(res.status).toBe(201);

    const { listCsrInstancesForEgsUnit, getComplianceLifecycleForCsrInstance } = await import("../src/lib/zatca/domain/index.js");
    const [csrInstance] = await listCsrInstancesForEgsUnit(companyA, egsUnitId);

    expect(await getComplianceLifecycleForCsrInstance(companyB, csrInstance.id)).toBeUndefined();
  });
});

describe("Slice L — Compliance Lifecycle persistence: Test 9, credential leakage", () => {
  it("never stores or returns binarySecurityToken/secret/PEM material anywhere — DB rows, audit events, or the API response", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const csrRes = await generateCsr(tokenA, egsUnitId);

    const server = await startMockFatoora(issuedHandler("SENSITIVE-CERT-BYTES", "SENSITIVE-SHARED-SECRET"));
    cleanup = server.close;
    setFatooraEnv(server.url);

    const res = await requestComplianceCsid(tokenA, egsUnitId, csrRes.body.csrDerBase64);
    expect(res.status).toBe(201);

    const resBody = JSON.stringify(res.body);
    expect(resBody).not.toContain("SENSITIVE-CERT-BYTES");
    expect(resBody).not.toContain("SENSITIVE-SHARED-SECRET");
    expect(resBody).not.toContain("secretRef");
    expect(resBody).not.toContain("BEGIN PRIVATE KEY");

    const { listCsrInstancesForEgsUnit, getComplianceLifecycleForCsrInstance } = await import("../src/lib/zatca/domain/index.js");
    const [csrInstance] = await listCsrInstancesForEgsUnit(companyA, egsUnitId);
    const lifecycle = await getComplianceLifecycleForCsrInstance(companyA, csrInstance.id);
    const lifecycleJson = JSON.stringify(lifecycle);
    expect(lifecycleJson).not.toContain("SENSITIVE-CERT-BYTES");
    expect(lifecycleJson).not.toContain("SENSITIVE-SHARED-SECRET");
    expect(lifecycleJson).not.toContain("BEGIN PRIVATE KEY");

    const auditRows = await db.query.auditEvents.findMany({
      where: (a, { eq }) => eq(a.entityId, egsUnitId),
    });
    const auditJson = JSON.stringify(auditRows);
    expect(auditJson).not.toContain("SENSITIVE-CERT-BYTES");
    expect(auditJson).not.toContain("SENSITIVE-SHARED-SECRET");
    expect(auditJson).not.toContain("BEGIN PRIVATE KEY");
    expect(auditJson).toContain("zatca.complianceCsid.requested");
  });
});

describe("Slice L — Compliance Lifecycle persistence: Test 10, API response compatibility", () => {
  it("the existing CSR and CSID routes' response contracts are unchanged by this slice", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const csrRes = await generateCsr(tokenA, egsUnitId);
    expect(csrRes.status).toBe(201);
    expect(Object.keys(csrRes.body).sort()).toEqual(["csrDerBase64", "csrPem"]);
  });

  it("the new compliance-csid route's response exposes only requestId/dispositionMessage, never secretRef or a database id", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const csrRes = await generateCsr(tokenA, egsUnitId);

    const server = await startMockFatoora(issuedHandler());
    cleanup = server.close;
    setFatooraEnv(server.url);

    const res = await requestComplianceCsid(tokenA, egsUnitId, csrRes.body.csrDerBase64);
    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(["dispositionMessage", "requestId"]);
  });
});
