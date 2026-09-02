import "reflect-metadata";
import { describe, it, expect, beforeAll, vi } from "vitest";
import { webcrypto } from "node:crypto";
import * as x509 from "@peculiar/x509";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";

// Slice J — CSR Instance persistence (EGS Unit -> CSR Instance, 1:many,
// historical). See docs/zatca (Slices D-I) for the architecture this
// implements; this file tests only the persistence layer added this
// slice, not any of the still-out-of-scope Compliance/Production
// lifecycle concepts.

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
    .send({ companyName: "CSR Instance Co A", name: "Owner A", email: uniqueEmail("csri-a"), password: "password123" });
  companyA = resA.body.company.id;
  tokenA = resA.body.token;

  const resB = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "CSR Instance Co B", name: "Owner B", email: uniqueEmail("csri-b"), password: "password123" });
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

describe("Slice J — CSR Instance persistence: Test 1, creation", () => {
  it("creates a durable CSR Instance row with the correct company, EGS unit, Functionality Map, secretRef, and initial status", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const res = await generateCsr(tokenA, egsUnitId);
    expect(res.status).toBe(201);

    const { listCsrInstancesForEgsUnit } = await import("../src/lib/zatca/domain/index.js");
    const rows = await listCsrInstancesForEgsUnit(companyA, egsUnitId);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.companyId).toBe(companyA);
    expect(row.egsUnitId).toBe(egsUnitId);
    expect(row.invoiceType).toBe(baseFields.invoiceType);
    expect(row.secretRef).toBeTruthy();
    expect(row.generatedAt).toBeInstanceOf(Date);
    expect(row.status).toBe("generated");
    expect(row.supersededBy).toBeNull();
  });
});

describe("Slice J — CSR Instance persistence: Test 2, multiple generations", () => {
  it("persists two independent CSR Instance rows for two generations against the same EGS unit, neither overwriting the other", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const resA = await generateCsr(tokenA, egsUnitId, "1000");
    expect(resA.status).toBe(201);
    const resB = await generateCsr(tokenA, egsUnitId, "0100");
    expect(resB.status).toBe(201);

    const { listCsrInstancesForEgsUnit } = await import("../src/lib/zatca/domain/index.js");
    const rows = await listCsrInstancesForEgsUnit(companyA, egsUnitId);
    expect(rows).toHaveLength(2);

    const [newest, oldest] = rows; // orderBy generatedAt desc
    expect(newest.id).not.toBe(oldest.id);
    expect(newest.secretRef).not.toBe(oldest.secretRef);
    expect(oldest.invoiceType).toBe("1000");
    expect(newest.invoiceType).toBe("0100");

    // CSR A is not overwritten: its own historical fields are untouched...
    expect(oldest.status).toBe("superseded");
    expect(oldest.supersededBy).toBe(newest.id);
    // ...and CSR B is not incorrectly attached to CSR A's own record.
    expect(newest.status).toBe("generated");
    expect(newest.supersededBy).toBeNull();
  });
});

describe("Slice J — CSR Instance persistence: Test 3, secret store preservation", () => {
  it("keeps CSR A's secretRef independently resolvable after CSR B is generated, with CSR B holding a separate secretRef", async () => {
    const { getZatcaSecretStore } = await import("../src/lib/zatca/secretStore/index.js");
    const { listCsrInstancesForEgsUnit } = await import("../src/lib/zatca/domain/index.js");

    const egsUnitId = await createEgsUnit(tokenA);
    await generateCsr(tokenA, egsUnitId, "1000");
    const rowsAfterA = await listCsrInstancesForEgsUnit(companyA, egsUnitId);
    const secretRefA = rowsAfterA[0].secretRef;

    await generateCsr(tokenA, egsUnitId, "0100");
    const rowsAfterB = await listCsrInstancesForEgsUnit(companyA, egsUnitId);
    const secretRefB = rowsAfterB.find((r) => r.status === "generated")!.secretRef;

    expect(secretRefB).not.toBe(secretRefA);

    const credentialA = await getZatcaSecretStore().resolve(companyA, secretRefA);
    expect(credentialA).not.toBeNull();
    expect(credentialA?.privateKeyPem).toBeTruthy();

    const credentialB = await getZatcaSecretStore().resolve(companyA, secretRefB);
    expect(credentialB).not.toBeNull();
    expect(credentialB?.privateKeyPem).toBeTruthy();
    expect(credentialB?.privateKeyPem).not.toBe(credentialA?.privateKeyPem);
  });
});

describe("Slice J — CSR Instance persistence: Test 4, Functionality Map fidelity", () => {
  it.each(["1000", "0100", "1100", "0010", "0001", "0000"])(
    "persists invoiceType %s exactly as supplied, never reinterpreted",
    async (invoiceType) => {
      const egsUnitId = await createEgsUnit(tokenA);
      const res = await generateCsr(tokenA, egsUnitId, invoiceType);
      expect(res.status).toBe(201);

      const { listCsrInstancesForEgsUnit } = await import("../src/lib/zatca/domain/index.js");
      const rows = await listCsrInstancesForEgsUnit(companyA, egsUnitId);
      expect(rows[0].invoiceType).toBe(invoiceType);
    },
  );
});

describe("Slice J — CSR Instance persistence: Test 5, tenant isolation", () => {
  it("a CSR Instance created for company A's EGS unit is invisible to company B", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    await generateCsr(tokenA, egsUnitId);

    const { listCsrInstancesForEgsUnit, getCsrInstance } = await import("../src/lib/zatca/domain/index.js");
    const rowsAsB = await listCsrInstancesForEgsUnit(companyB, egsUnitId);
    expect(rowsAsB).toHaveLength(0);

    const rowsAsA = await listCsrInstancesForEgsUnit(companyA, egsUnitId);
    const instanceId = rowsAsA[0].id;
    const foundAsB = await getCsrInstance(companyB, instanceId);
    expect(foundAsB).toBeUndefined();
    const foundAsA = await getCsrInstance(companyA, instanceId);
    expect(foundAsA).toBeTruthy();
  });

  it("cannot generate a CSR (and therefore cannot create a CSR Instance) against another company's EGS unit", async () => {
    const egsUnitIdOfA = await createEgsUnit(tokenA);
    const res = await generateCsr(tokenB, egsUnitIdOfA);
    expect(res.status).toBe(404);

    const { listCsrInstancesForEgsUnit } = await import("../src/lib/zatca/domain/index.js");
    const rows = await listCsrInstancesForEgsUnit(companyB, egsUnitIdOfA);
    expect(rows).toHaveLength(0);
  });
});

describe("Slice J — CSR Instance persistence: Test 6, failure handling", () => {
  it("surfaces a DB persistence failure instead of silently returning success", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const originalTransaction = db.transaction.bind(db);
    db.transaction = vi.fn().mockRejectedValue(new Error("simulated DB failure during CSR Instance persistence")) as typeof db.transaction;
    try {
      const res = await generateCsr(tokenA, egsUnitId);
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(JSON.stringify(res.body)).not.toContain("simulated DB failure");
    } finally {
      db.transaction = originalTransaction;
    }

    const { listCsrInstancesForEgsUnit } = await import("../src/lib/zatca/domain/index.js");
    const rows = await listCsrInstancesForEgsUnit(companyA, egsUnitId);
    expect(rows).toHaveLength(0);
  });
});

describe("Slice J — CSR Instance persistence: Test 7, existing API contract unchanged", () => {
  it("the CSR endpoint response contains exactly csrPem and csrDerBase64 — no new fields leaked to API consumers", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const res = await generateCsr(tokenA, egsUnitId);
    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(["csrDerBase64", "csrPem"]);
    expect(res.body.csrInstanceId).toBeUndefined();
  });

  it("the audit event for CSR generation includes the new csrInstanceId in metadata, without leaking any secret", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    await generateCsr(tokenA, egsUnitId);

    const { listCsrInstancesForEgsUnit } = await import("../src/lib/zatca/domain/index.js");
    const rows = await listCsrInstancesForEgsUnit(companyA, egsUnitId);

    const auditRes = await request(app).get("/api/audit-events").set("Authorization", `Bearer ${tokenA}`);
    const body = JSON.stringify(auditRes.body);
    expect(body).toContain(rows[0].id);
    expect(body).not.toContain(rows[0].secretRef);
  });
});

describe("Slice J — CSR Instance persistence: concurrency", () => {
  it("two near-simultaneous CSR generations for the same EGS unit both survive as independent rows with distinct secretRefs", async () => {
    const egsUnitId = await createEgsUnit(tokenA);

    const [resA, resB] = await Promise.all([
      generateCsr(tokenA, egsUnitId, "1000"),
      generateCsr(tokenA, egsUnitId, "0100"),
    ]);
    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);

    const { listCsrInstancesForEgsUnit } = await import("../src/lib/zatca/domain/index.js");
    const rows = await listCsrInstancesForEgsUnit(companyA, egsUnitId);
    expect(rows).toHaveLength(2);

    const secretRefs = new Set(rows.map((r) => r.secretRef));
    expect(secretRefs.size).toBe(2);
    const ids = new Set(rows.map((r) => r.id));
    expect(ids.size).toBe(2);

    // Not relying on a single mutable CSR record: whichever one the EGS
    // unit's own current secretRef now points to, BOTH underlying secrets
    // must still independently resolve — neither generation destroyed the
    // other's key material, regardless of ordering.
    const { getZatcaSecretStore } = await import("../src/lib/zatca/secretStore/index.js");
    for (const row of rows) {
      const credential = await getZatcaSecretStore().resolve(companyA, row.secretRef);
      expect(credential).not.toBeNull();
      expect(credential?.privateKeyPem).toBeTruthy();
    }
  });
});

// Slice K — confirmCsidForEgsUnit must not destroy a CSR Instance's
// historically-owned secretRef during normal CSID confirmation. Uses the
// exact same fake-CA certificate-issuance mechanism already established
// in tests/zatcaCsrCsid.test.ts (never a fabricated provider behavior).
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

async function confirmCsid(token: string, egsUnitId: string, binarySecurityToken: string, secret: string, stage: "compliance" | "production") {
  return request(app)
    .post(`/api/zatca/egs-units/${egsUnitId}/csid`)
    .set("Authorization", `Bearer ${token}`)
    .send({ binarySecurityToken, secret, stage });
}

describe("Slice K — Test 1: existing CSID confirmation still works", () => {
  it("compliance-stage confirmation succeeds exactly as before", async () => {
    const egsUnitId = await createEgsUnit(tokenA);
    const csrRes = await generateCsr(tokenA, egsUnitId);
    const cert = await makeIssuedCertificateForCsr(csrRes.body.csrDerBase64, new Date("2027-01-01"));

    const res = await confirmCsid(tokenA, egsUnitId, cert, "s3cr3t", "compliance");
    expect(res.status).toBe(200);
    expect(res.body.csidStatus).toBe("compliance_issued");
  });
});

describe("Slice K — Test 2: historical CSR secret survives CSID confirmation", () => {
  it("CSR Instance A's secretRef still resolves in ZatcaSecretStore after compliance-stage confirmation", async () => {
    const { listCsrInstancesForEgsUnit } = await import("../src/lib/zatca/domain/index.js");
    const { getZatcaSecretStore } = await import("../src/lib/zatca/secretStore/index.js");

    const egsUnitId = await createEgsUnit(tokenA);
    const csrRes = await generateCsr(tokenA, egsUnitId);
    const rowsBefore = await listCsrInstancesForEgsUnit(companyA, egsUnitId);
    const secretRefA = rowsBefore[0].secretRef;
    expect(await getZatcaSecretStore().resolve(companyA, secretRefA)).not.toBeNull();

    const cert = await makeIssuedCertificateForCsr(csrRes.body.csrDerBase64, new Date("2027-01-01"));
    const confirmRes = await confirmCsid(tokenA, egsUnitId, cert, "s3cr3t", "compliance");
    expect(confirmRes.status).toBe(200);

    // The bug this slice fixes: before the fix, this secret would have
    // been deleted by confirmCsidForEgsUnit's old unconditional delete().
    const credentialAfter = await getZatcaSecretStore().resolve(companyA, secretRefA);
    expect(credentialAfter).not.toBeNull();
    expect(credentialAfter?.privateKeyPem).toBeTruthy();

    // CSR Instance A's own row is untouched -- still records secretRef A.
    const rowsAfter = await listCsrInstancesForEgsUnit(companyA, egsUnitId);
    expect(rowsAfter[0].secretRef).toBe(secretRefA);
  });
});

describe("Slice K — Test 3: EGS current pointer can change without destroying history", () => {
  it("zatca_egs_units.secretRef moves to the confirmed credential while CSR Instance A.secretRef stays unchanged", async () => {
    const { listCsrInstancesForEgsUnit } = await import("../src/lib/zatca/domain/index.js");

    const egsUnitId = await createEgsUnit(tokenA);
    const csrRes = await generateCsr(tokenA, egsUnitId);
    const rowsBefore = await listCsrInstancesForEgsUnit(companyA, egsUnitId);
    const secretRefA = rowsBefore[0].secretRef;

    const unitBefore = await request(app).get(`/api/zatca/egs-units/${egsUnitId}`).set("Authorization", `Bearer ${tokenA}`);
    expect(unitBefore.body.hasCredential).toBe(true); // sanity: has a secretRef already (from generation)

    const cert = await makeIssuedCertificateForCsr(csrRes.body.csrDerBase64, new Date("2027-01-01"));
    await confirmCsid(tokenA, egsUnitId, cert, "s3cr3t", "compliance");

    const { getEgsUnit } = await import("../src/lib/zatca/domain/index.js");
    const unitAfter = await getEgsUnit(companyA, egsUnitId);
    // EGS current pointer legitimately changed (operational behavior
    // preserved) ...
    expect(unitAfter?.secretRef).not.toBe(secretRefA);
    // ... but CSR Instance A's own historical field did not.
    const rowsAfter = await listCsrInstancesForEgsUnit(companyA, egsUnitId);
    expect(rowsAfter[0].secretRef).toBe(secretRefA);
  });
});

describe("Slice K — Test 4: multiple CSR instances survive CSID confirmation", () => {
  it("CSR A and CSR B (regenerated before confirmation) both remain with independently resolvable secrets after confirming CSR B", async () => {
    const { listCsrInstancesForEgsUnit } = await import("../src/lib/zatca/domain/index.js");
    const { getZatcaSecretStore } = await import("../src/lib/zatca/secretStore/index.js");

    const egsUnitId = await createEgsUnit(tokenA);
    await generateCsr(tokenA, egsUnitId, "1000"); // CSR A -- immediately superseded
    const csrBRes = await generateCsr(tokenA, egsUnitId, "0100"); // CSR B -- current

    const rowsBeforeConfirm = await listCsrInstancesForEgsUnit(companyA, egsUnitId);
    expect(rowsBeforeConfirm).toHaveLength(2);
    const secretRefA = rowsBeforeConfirm.find((r) => r.status === "superseded")!.secretRef;
    const secretRefB = rowsBeforeConfirm.find((r) => r.status === "generated")!.secretRef;

    const cert = await makeIssuedCertificateForCsr(csrBRes.body.csrDerBase64, new Date("2027-01-01"));
    const confirmRes = await confirmCsid(tokenA, egsUnitId, cert, "s3cr3t", "compliance");
    expect(confirmRes.status).toBe(200);

    const rowsAfterConfirm = await listCsrInstancesForEgsUnit(companyA, egsUnitId);
    expect(rowsAfterConfirm).toHaveLength(2);

    expect(await getZatcaSecretStore().resolve(companyA, secretRefA)).not.toBeNull();
    expect(await getZatcaSecretStore().resolve(companyA, secretRefB)).not.toBeNull();
  });
});

describe("Slice K — Test 5: no credential leakage", () => {
  it("binarySecurityToken/secret/privateKeyPem never appear in the DB row, audit metadata, or API response", async () => {
    const { listCsrInstancesForEgsUnit } = await import("../src/lib/zatca/domain/index.js");

    const egsUnitId = await createEgsUnit(tokenA);
    const csrRes = await generateCsr(tokenA, egsUnitId);
    const cert = await makeIssuedCertificateForCsr(csrRes.body.csrDerBase64, new Date("2027-01-01"));
    const rawSecret = "SLICE-K-RAW-SECRET-VALUE";

    const confirmRes = await confirmCsid(tokenA, egsUnitId, cert, rawSecret, "compliance");
    expect(confirmRes.status).toBe(200);
    expect(JSON.stringify(confirmRes.body)).not.toContain(rawSecret);
    expect(JSON.stringify(confirmRes.body)).not.toContain(cert);

    const rows = await listCsrInstancesForEgsUnit(companyA, egsUnitId);
    const rowJson = JSON.stringify(rows);
    expect(rowJson).not.toContain(rawSecret);
    expect(rowJson).not.toContain(cert);
    // Only an opaque secretRef string, never key/cert material shaped
    // like PEM.
    expect(rowJson).not.toContain("BEGIN PRIVATE KEY");
    expect(rowJson).not.toContain("BEGIN CERTIFICATE");

    const auditRes = await request(app).get("/api/audit-events").set("Authorization", `Bearer ${tokenA}`);
    const auditJson = JSON.stringify(auditRes.body);
    expect(auditJson).not.toContain(rawSecret);
    expect(auditJson).not.toContain(cert);
  });
});
