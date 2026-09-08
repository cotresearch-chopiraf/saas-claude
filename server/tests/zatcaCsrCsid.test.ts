import "reflect-metadata";
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { webcrypto } from "node:crypto";
import http from "node:http";
import * as x509 from "@peculiar/x509";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { useZatcaCsrCurve } from "./helpers/zatcaEnv.js";

// Slice 5 continuation, task #51 — CSR generation + CSID confirmation
// routes. See domain/csr.ts's file comment for exactly what this does and
// does not do (never submits the CSR to ZATCA over the network — that
// contract is unverified). These tests exercise the real, testable half:
// key/CSR generation, and confirming a certificate the tenant obtained
// some other way actually matches the key pair MIDAD generated.

vi.mock("../src/lib/mailer.js", () => ({ sendMail: vi.fn() }));
import { sendMail } from "../src/lib/mailer.js";

function extractInviteToken(mailBody: string): string {
  const match = mailBody.match(/token=([a-f0-9]{64})/);
  if (!match) throw new Error(`no token found in mail body: ${mailBody}`);
  return match[1];
}

useZatcaCsrCurve();
beforeAll(() => {
  x509.cryptoProvider.set(webcrypto as unknown as Crypto);
});

const app = buildApp();

const validFields = {
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
    .send({ companyName: "CSR Co A", name: "Owner A", email: uniqueEmail("csr-a"), password: "password123" });
  companyA = resA.body.company.id;
  tokenA = resA.body.token;

  const resB = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "CSR Co B", name: "Owner B", email: uniqueEmail("csr-b"), password: "password123" });
  companyB = resB.body.company.id;
  tokenB = resB.body.token;

  // VAT Registration Number consistency (ZATCA Network Integration
  // continuation) — CSR generation now requires organizationIdentifier to
  // match the company's registered VAT number exactly. Set it once here
  // to match validFields.organizationIdentifier so every existing
  // CSR-generation test below keeps working; the dedicated mismatch test
  // exercises the rejection path separately without touching this.
  await request(app)
    .patch("/api/zatca/config")
    .set("Authorization", `Bearer ${tokenA}`)
    .send({ vatNumber: validFields.organizationIdentifier, commercialRegistration: "1010101010" });
});

async function createEgsUnit(token: string): Promise<string> {
  const res = await request(app)
    .post("/api/zatca/egs-units")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: "Test Unit", environment: "simulation" });
  return res.body.id as string;
}

describe("POST /api/zatca/egs-units/:id/csr", () => {
  it("generates a real, well-formed CSR and moves csidStatus to compliance_pending", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const res = await request(app)
      .post(`/api/zatca/egs-units/${egsUnitId}/csr`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ otp: "123456", fields: validFields, customAttributeOids });

    expect(res.status).toBe(201);
    expect(res.body.csrPem).toContain("-----BEGIN CERTIFICATE REQUEST-----");

    const unit = await request(app).get(`/api/zatca/egs-units/${egsUnitId}`).set("Authorization", `Bearer ${tokenA}`);
    expect(unit.body.csidStatus).toBe("compliance_pending");
    expect(unit.body.hasCredential).toBe(true);
  });

  it("never returns any private key material in the response", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const res = await request(app)
      .post(`/api/zatca/egs-units/${egsUnitId}/csr`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ otp: "123456", fields: validFields, customAttributeOids });
    expect(JSON.stringify(res.body)).not.toContain("PRIVATE KEY");
  });

  it("rejects an empty OTP", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const res = await request(app)
      .post(`/api/zatca/egs-units/${egsUnitId}/csr`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ otp: "", fields: validFields, customAttributeOids });
    expect(res.status).toBe(400);
  });

  it("rejects when a required ZATCA-custom OID is missing (SPEC_TEXT_REQUIRED refusal, not a guess)", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const res = await request(app)
      .post(`/api/zatca/egs-units/${egsUnitId}/csr`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ otp: "123456", fields: validFields, customAttributeOids: {} });
    expect(res.status).toBe(400);
    expect(res.body.category).toBe("configuration");
  });

  it("AUTHORIZATION: a member cannot generate a CSR", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const inviteRes = await request(app)
      .post("/api/company/invites")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ email: uniqueEmail("csr-member"), role: "member" });
    expect(inviteRes.status).toBe(201);
    const mailCall = (sendMail as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    const inviteToken = extractInviteToken(mailCall[2] as string);
    const acceptRes = await request(app)
      .post("/api/auth/accept-invite")
      .send({ token: inviteToken, name: "Member A", password: "memberpass123" });
    expect(acceptRes.status).toBe(201);

    const res = await request(app)
      .post(`/api/zatca/egs-units/${egsUnitId}/csr`)
      .set("Authorization", `Bearer ${acceptRes.body.token}`)
      .send({ otp: "123456", fields: validFields, customAttributeOids });
    expect(res.status).toBe(403);
  });

  it("TENANT ISOLATION: company B cannot generate a CSR for company A's EGS unit", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const res = await request(app)
      .post(`/api/zatca/egs-units/${egsUnitId}/csr`)
      .set("Authorization", `Bearer ${tokenB}`)
      .send({ otp: "123456", fields: validFields, customAttributeOids });
    expect(res.status).toBe(404);
  });

  it("VAT CONSISTENCY: rejects a CSR whose organizationIdentifier does not match the company's registered VAT number", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const mismatched = { ...validFields, organizationIdentifier: "300000000000003" };
    expect(mismatched.organizationIdentifier).not.toBe(validFields.organizationIdentifier);
    const res = await request(app)
      .post(`/api/zatca/egs-units/${egsUnitId}/csr`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ otp: "123456", fields: mismatched, customAttributeOids });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/لا يطابق الرقم الضريبي/);
    // Never silently corrected or defaulted -- confirm no EGS unit
    // advanced past not_onboarded/csidStatus "none" for this rejection.
    const unit = await request(app).get(`/api/zatca/egs-units/${egsUnitId}`).set("Authorization", `Bearer ${tokenA}`);
    expect(unit.body.csidStatus).toBe("none");
  });

  it("VAT CONSISTENCY: rejects CSR generation entirely when the company has no VAT number registered yet", async () => {
    const resC = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "CSR Co C (no VAT)", name: "Owner C", email: uniqueEmail("csr-c"), password: "password123" });
    const tokenC = resC.body.token as string;
    const egsUnitId = await createEgsUnit(tokenC);
    const res = await request(app)
      .post(`/api/zatca/egs-units/${egsUnitId}/csr`)
      .set("Authorization", `Bearer ${tokenC}`)
      .send({ otp: "123456", fields: validFields, customAttributeOids });
    expect(res.status).toBe(400);
    expect(res.body.category).toBe("configuration");
  });
});

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

describe("POST /api/zatca/egs-units/:id/csid", () => {
  async function generateCsr(token: string, egsUnitId: string) {
    const res = await request(app)
      .post(`/api/zatca/egs-units/${egsUnitId}/csr`)
      .set("Authorization", `Bearer ${token}`)
      .send({ otp: "123456", fields: validFields, customAttributeOids });
    return res.body.csrDerBase64 as string;
  }

  it("400s when no CSR was ever generated for this unit", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const fakeCertBase64 = await makeIssuedCertificateForCsr(await generateCsr(tokenA, await createEgsUnit(tokenA)), new Date("2027-01-01"));
    const res = await request(app)
      .post(`/api/zatca/egs-units/${egsUnitId}/csid`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ binarySecurityToken: fakeCertBase64, secret: "s3cr3t", stage: "compliance" });
    expect(res.status).toBe(400);
    expect(res.body.category).toBe("configuration");
  });

  it("REJECTS a certificate whose public key does not match the CSR's key pair (never silently accepts a mismatched cert)", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    await generateCsr(tokenA, egsUnitId);
    // Certificate issued for a DIFFERENT (unrelated) CSR/key pair.
    const otherEgsUnitId = await createEgsUnit(tokenA);
    const unrelatedCsr = await generateCsr(tokenA, otherEgsUnitId);
    const mismatchedCert = await makeIssuedCertificateForCsr(unrelatedCsr, new Date("2027-01-01"));

    const res = await request(app)
      .post(`/api/zatca/egs-units/${egsUnitId}/csid`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ binarySecurityToken: mismatchedCert, secret: "s3cr3t", stage: "compliance" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/لا يمكن قبول هذه الشهادة|لا تطابق/);
  });

  it("ACCEPTS a real matching certificate, sets csidStatus=compliance_issued and a real certificateExpiresAt from the certificate", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const csrDer = await generateCsr(tokenA, egsUnitId);
    const notAfter = new Date("2027-06-15T00:00:00Z");
    const matchingCert = await makeIssuedCertificateForCsr(csrDer, notAfter);

    const res = await request(app)
      .post(`/api/zatca/egs-units/${egsUnitId}/csid`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ binarySecurityToken: matchingCert, secret: "s3cr3t", stage: "compliance" });

    expect(res.status).toBe(200);
    expect(res.body.csidStatus).toBe("compliance_issued");
    expect(new Date(res.body.certificateExpiresAt).toISOString()).toBe(notAfter.toISOString());
  });

  it("a production-stage confirmation sets csidStatus=production_issued (after compliance is issued first)", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const csrDer = await generateCsr(tokenA, egsUnitId);
    const complianceCert = await makeIssuedCertificateForCsr(csrDer, new Date("2027-01-01"));
    const complianceRes = await request(app)
      .post(`/api/zatca/egs-units/${egsUnitId}/csid`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ binarySecurityToken: complianceCert, secret: "s3cr3t", stage: "compliance" });
    expect(complianceRes.status).toBe(200);
    expect(complianceRes.body.csidStatus).toBe("compliance_issued");

    const res = await request(app)
      .post(`/api/zatca/egs-units/${egsUnitId}/csid`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ binarySecurityToken: complianceCert, secret: "s3cr3t", stage: "production" });

    expect(res.status).toBe(200);
    expect(res.body.csidStatus).toBe("production_issued");
  });

  it("STATE MACHINE: rejects 'CSR -> Production CSID' as a shortcut -- production requires compliance_issued first", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const csrDer = await generateCsr(tokenA, egsUnitId);
    const cert = await makeIssuedCertificateForCsr(csrDer, new Date("2027-01-01"));

    // Never confirmed "compliance" -- csidStatus is still compliance_pending.
    const res = await request(app)
      .post(`/api/zatca/egs-units/${egsUnitId}/csid`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ binarySecurityToken: cert, secret: "s3cr3t", stage: "production" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/لا يمكن تأكيد شهادة الإنتاج/);
    const unit = await request(app).get(`/api/zatca/egs-units/${egsUnitId}`).set("Authorization", `Bearer ${tokenA}`);
    expect(unit.body.csidStatus).toBe("compliance_pending");
  });

  it("STATE MACHINE: rejects a second 'compliance' confirmation once compliance is already issued", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const csrDer = await generateCsr(tokenA, egsUnitId);
    const cert = await makeIssuedCertificateForCsr(csrDer, new Date("2027-01-01"));
    const first = await request(app)
      .post(`/api/zatca/egs-units/${egsUnitId}/csid`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ binarySecurityToken: cert, secret: "s3cr3t", stage: "compliance" });
    expect(first.status).toBe(200);

    const second = await request(app)
      .post(`/api/zatca/egs-units/${egsUnitId}/csid`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ binarySecurityToken: cert, secret: "s3cr3t", stage: "compliance" });
    expect(second.status).toBe(400);
    expect(second.body.error).toMatch(/لا يمكن تأكيد شهادة الامتثال/);
  });

  it("TENANT ISOLATION: company B cannot confirm a CSID for company A's EGS unit", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const csrDer = await generateCsr(tokenA, egsUnitId);
    const matchingCert = await makeIssuedCertificateForCsr(csrDer, new Date("2027-01-01"));
    const res = await request(app)
      .post(`/api/zatca/egs-units/${egsUnitId}/csid`)
      .set("Authorization", `Bearer ${tokenB}`)
      .send({ binarySecurityToken: matchingCert, secret: "s3cr3t", stage: "compliance" });
    expect(res.status).toBe(404);
  });

  it("secrets never appear in the response or audit trail", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const csrDer = await generateCsr(tokenA, egsUnitId);
    const matchingCert = await makeIssuedCertificateForCsr(csrDer, new Date("2027-01-01"));
    const rawSecret = "CSID-TEST-RAW-SECRET-VALUE";

    const res = await request(app)
      .post(`/api/zatca/egs-units/${egsUnitId}/csid`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ binarySecurityToken: matchingCert, secret: rawSecret, stage: "compliance" });
    expect(JSON.stringify(res.body)).not.toContain(rawSecret);

    const auditRes = await request(app).get("/api/audit-events").set("Authorization", `Bearer ${tokenA}`);
    expect(JSON.stringify(auditRes.body)).not.toContain(rawSecret);
  });

  it("END-TO-END: the confirmed credential's private key actually signs (real XadesZatcaSigner integration)", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const csrDer = await generateCsr(tokenA, egsUnitId);
    const matchingCert = await makeIssuedCertificateForCsr(csrDer, new Date("2027-01-01"));
    await request(app)
      .post(`/api/zatca/egs-units/${egsUnitId}/csid`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ binarySecurityToken: matchingCert, secret: "s3cr3t", stage: "compliance" });

    const { getZatcaSecretStore } = await import("../src/lib/zatca/secretStore/index.js");
    const { getEgsUnit } = await import("../src/lib/zatca/domain/index.js");
    const unit = await getEgsUnit(companyA, egsUnitId);
    const credential = await getZatcaSecretStore().resolve(companyA, unit!.secretRef!);
    expect(credential?.privateKeyPem).toBeTruthy();
    expect(credential?.binarySecurityToken).toBe(matchingCert);

    const { XadesZatcaSigner } = await import("../src/lib/zatca/signer/xadesZatcaSigner.js");
    const { verifyZatcaSignature } = await import("../src/lib/zatca/signer/verify.js");
    const { buildZatcaInvoiceXml } = await import("../src/lib/zatca/xmlBuilder.js");
    const xml = buildZatcaInvoiceXml({
      id: "INV-1",
      uuid: "22222222-2222-2222-2222-222222222222",
      issueDate: "2026-09-01",
      issueTime: "12:00:00",
      documentTypeCode: "388",
      subtype: "simplified",
      currencyCode: "SAR",
      invoiceCounterValue: 1,
      previousInvoiceHash: "MA==",
      supplier: { registrationName: "Test", vatNumber: "300000000000003" },
      taxSubtotals: [{ taxableAmount: 10, taxAmount: 1.5, taxCategoryCode: "S", taxRatePercent: 15 }],
      totalTaxAmount: 1.5,
      taxExclusiveAmount: 10,
      taxInclusiveAmount: 11.5,
      payableAmount: 11.5,
      lines: [{ id: "1", description: "x", quantity: 1, unitPrice: 10, lineExtensionAmount: 10, taxAmount: 1.5, taxRatePercent: 15, taxCategoryCode: "S" }],
    });
    const { signedXml } = await new XadesZatcaSigner().sign({ canonicalXml: xml, credential: credential! });
    const verification = await verifyZatcaSignature(signedXml);
    expect(verification.valid).toBe(true);
  });

  const FATOORA_ENV_KEYS = [
    "ZATCA_FATOORA_SIMULATION_BASE_URL",
    "ZATCA_FATOORA_SIMULATION_COMPLIANCE_PATH",
    "ZATCA_FATOORA_SIMULATION_CLEARANCE_PATH",
    "ZATCA_FATOORA_SIMULATION_REPORTING_PATH",
  ];
  let mockZatcaServer: { close: () => Promise<void> } | undefined;

  afterEach(async () => {
    if (mockZatcaServer) await mockZatcaServer.close();
    mockZatcaServer = undefined;
    for (const key of FATOORA_ENV_KEYS) delete process.env[key];
  });

  it("FULL HTTP STACK: prepare -> submit through the real routes gets past real signing AND local verification, all the way to a real ZATCA provider outcome (Slice AB)", async () => {
    // The strongest available end-to-end proof: nothing here calls
    // XadesZatcaSigner, verifyZatcaSignature, or FatooraProvider directly —
    // only real /api/zatca/* HTTP routes, exactly as a browser client would
    // call them, using a credential this same flow (CSR -> CSID confirm)
    // produced, submitting against a real local HTTP server standing in
    // for ZATCA's own Clearance endpoint (never the real ZATCA network —
    // this environment cannot reach it, and automated tests must never
    // call real production ZATCA). If real signing, real local
    // verification (task #49), or the real provider wiring (Slice AB)
    // regressed, this test would fail well before reaching "cleared".
    const server = await new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
      const s = http.createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ validationResults: { status: "PASS" }, clearanceStatus: "CLEARED", clearedInvoice: "PGE+PC9hPg==" }));
      });
      s.listen(0, "127.0.0.1", () => {
        const address = s.address();
        const port = typeof address === "object" && address ? address.port : 0;
        resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => s.close(() => r())) });
      });
    });
    mockZatcaServer = server;
    process.env.ZATCA_FATOORA_SIMULATION_BASE_URL = server.url;
    process.env.ZATCA_FATOORA_SIMULATION_COMPLIANCE_PATH = "compliance/invoices";
    process.env.ZATCA_FATOORA_SIMULATION_CLEARANCE_PATH = "invoices/clearance/single";
    process.env.ZATCA_FATOORA_SIMULATION_REPORTING_PATH = "invoices/reporting/single";

    await request(app).patch("/api/zatca/config").set("Authorization", `Bearer ${tokenA}`).send({
      vatNumber: validFields.organizationIdentifier,
      commercialRegistration: "1010101010",
    });
    const egsUnitId = await createEgsUnit(tokenA);
    const csrDer = await generateCsr(tokenA, egsUnitId);
    const matchingCert = await makeIssuedCertificateForCsr(csrDer, new Date("2027-01-01"));
    const csidRes = await request(app)
      .post(`/api/zatca/egs-units/${egsUnitId}/csid`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ binarySecurityToken: matchingCert, secret: "s3cr3t", stage: "compliance" });
    expect(csidRes.status).toBe(200);

    // clientTaxId present -> subtype "standard" (B2B) -> routed to
    // clearInvoice, matching the mock server's CLEARED response above.
    const invoiceRes = await request(app)
      .post("/api/invoices")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ clientName: "CSID E2E Client", clientTaxId: "310000000000003", items: [{ description: "Work", amount: 200 }] });
    expect(invoiceRes.status).toBe(201);

    const prepareRes = await request(app)
      .post(`/api/zatca/egs-units/${egsUnitId}/invoices/${invoiceRes.body.id}/prepare`)
      .set("Authorization", `Bearer ${tokenA}`);
    expect(prepareRes.status).toBe(201);
    expect(prepareRes.body.submission.subtype).toBe("standard");

    const submitRes = await request(app)
      .post(`/api/zatca/submissions/${prepareRes.body.submission.id}/submit`)
      .set("Authorization", `Bearer ${tokenA}`);

    expect(submitRes.status).toBe(200);
    expect(submitRes.body.submission.state).toBe("cleared");
    expect(submitRes.body.submission.clearedDocumentXmlBase64).toBe("PGE+PC9hPg==");
    // secret/credential material never leaks into the response.
    expect(JSON.stringify(submitRes.body)).not.toContain("s3cr3t");
  });
});
