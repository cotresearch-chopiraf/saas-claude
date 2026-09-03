import "reflect-metadata";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { webcrypto } from "node:crypto";
import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import * as x509 from "@peculiar/x509";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";

// Slice Y — architecture freeze guardrails.
//
// This file implements NO new ZATCA behavior. It exists solely to make the
// boundary established by Slices R-X (see docs/zatca/ARCHITECTURE_BOUNDARY.md)
// fail loudly in CI if a future change crosses it — either by introducing a
// forbidden compliance-completion concept, by hardcoding the unverified
// "1100 = 6 tests" (or third-party "12 tests") hypothesis as if it were a
// ZATCA fact, or by deriving self-billing from the CSR Functionality Map
// instead of the verified KSA-2 InvoiceTypeCode/@name mechanism.
//
// Two kinds of guard:
//   1. Static source-scan (no DB) — greps the actual ZATCA source text for
//      forbidden identifiers/phrases. A match here means someone wrote the
//      forbidden concept into executable code or a code comment, not that
//      they merely discussed it in architecture documentation (this scan
//      never touches docs/).
//   2. Behavioral (DB-backed) — proves, using the real validation path
//      (submitComplianceInvoiceForEgsUnit via the HTTP route), that
//      Functionality Map positions 3/4 do not affect the standard/simplified
//      family check, without assigning ANY meaning to what those positions
//      contain — per the explicit "do not add semantic tests for positions
//      3/4" instruction this slice was given.

vi.mock("../src/lib/mailer.js", () => ({ sendMail: vi.fn() }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");

function collectSourceFiles(absDir: string, extensions: string[]): string[] {
  if (!fs.existsSync(absDir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSourceFiles(full, extensions));
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

// The exact set of files this project's ZATCA architecture actually spans —
// intentionally NOT "every .ts file in the repo" (§7/§39 of the Slice Y
// spec: no broad exploratory scanning, only what the boundary covers).
const scannedFiles: string[] = [
  ...collectSourceFiles(path.join(repoRoot, "server", "src", "lib", "zatca"), [".ts"]),
  path.join(repoRoot, "server", "src", "routes", "zatca.ts"),
  path.join(repoRoot, "server", "src", "routes", "platformZatca.ts"),
  path.join(repoRoot, "server", "src", "db", "schema.ts"),
  path.join(repoRoot, "client", "src", "api", "zatca.ts"),
  path.join(repoRoot, "client", "src", "pages", "ZatcaSettings.tsx"),
  path.join(repoRoot, "client", "src", "platform", "api", "zatca.ts"),
  path.join(repoRoot, "client", "src", "platform", "pages", "PlatformZatca.tsx"),
].filter((f) => fs.existsSync(f));

function readAll(): { file: string; text: string }[] {
  return scannedFiles.map((file) => ({ file, text: fs.readFileSync(file, "utf8") }));
}

// A comment line explaining *why* a frozen concept must not be encoded (the
// "Allowed" case §16/§17/§23 explicitly carve out — e.g. productionCsid.ts's
// own header explaining that zatca_compliance_steps "remains unimplemented,
// deliberately") is not itself a violation. Only a match in executable code
// — a declaration, assignment, schema definition, etc. — counts. This is a
// deliberately simple heuristic (trimmed line starts with "//" or "*", the
// two comment-continuation forms this codebase actually uses), not a full
// parser; it errs toward allowing legitimate disclaiming comments rather
// than toward false positives that would make future developers distrust
// (and eventually ignore) this guard.
function isCommentLine(lineText: string): boolean {
  const trimmed = lineText.trim();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

function findMatches(needle: string): { file: string; line: number }[] {
  const hits: { file: string; line: number }[] = [];
  for (const { file, text } of readAll()) {
    const lines = text.split("\n");
    lines.forEach((lineText, idx) => {
      if (lineText.includes(needle) && !isCommentLine(lineText)) {
        hits.push({ file: path.relative(repoRoot, file), line: idx + 1 });
      }
    });
  }
  return hits;
}

describe("Slice Y — architecture freeze: scanned-file list sanity", () => {
  it("the scanned-file list is non-empty (guards against a silently-broken path list making every guard below vacuous)", () => {
    expect(scannedFiles.length).toBeGreaterThanOrEqual(5);
  });
});

describe("Slice Y — completion-semantics guard (§22, §29, §30 of the Slice Y spec)", () => {
  const forbiddenIdentifiers = [
    "compliance_completed",
    "onboarding_completed",
    "renewal_completed",
    "ZATCA_APPROVED",
    "ZATCA_COMPLIANT",
    "isCompliant",
    "compliancePassed",
    "onboardingPassed",
    "renewalPassed",
    "complianceCompleted",
    "onboardingCompleted",
    "renewalCompleted",
    "zatca_compliance_steps",
    "compliance_requirements",
    "required_compliance_tests",
    "zatca_required_steps",
    "zatca_test_matrix",
    "allTestsPassed",
    "testsPassed",
    "requiredTestsPassed",
  ];

  it.each(forbiddenIdentifiers)('forbidden identifier "%s" does not appear in scanned ZATCA source', (identifier) => {
    expect(findMatches(identifier)).toEqual([]);
  });
});

describe('Slice Y — "1100 = 6" / third-party "12 tests" guard (§19, §23, §24 of the Slice Y spec)', () => {
  // Every phrase here would encode the DERIVED (never verified) "1100 = 6"
  // hypothesis, or the third-party-only "12 tests" claim found in Slice X,
  // as if either were a ZATCA fact. Discussing them as explicitly-unverified
  // history belongs only in docs/zatca/ARCHITECTURE_BOUNDARY.md, which this
  // scan does not touch.
  const forbiddenPhrases = [
    "1100 = 6",
    "1100=6",
    "1100 has 6",
    "six tests",
    "6 tests",
    "test_count = 6",
    "test_count=6",
    "testCount = 6",
    "testCount=6",
    "testCount: 6",
    "12 compliance tests",
    "12 tests",
    "twelve tests",
  ];

  it.each(forbiddenPhrases)('forbidden phrase "%s" does not appear in scanned ZATCA source', (phrase) => {
    expect(findMatches(phrase)).toEqual([]);
  });
});

describe("Slice Y — self-billing independence guard (§6, §21 of the Slice Y spec)", () => {
  it("no CSR/Functionality-Map-handling file mentions self-billing (the verified mechanism is KSA-2 InvoiceTypeCode/@name, never CSR position 4)", () => {
    const csrRelatedFiles = [
      path.join(repoRoot, "server", "src", "lib", "zatca", "csr", "csrBuilder.ts"),
      path.join(repoRoot, "server", "src", "lib", "zatca", "domain", "csr.ts"),
      path.join(repoRoot, "server", "src", "lib", "zatca", "domain", "csrInstances.ts"),
      path.join(repoRoot, "server", "src", "lib", "zatca", "domain", "complianceInvoice.ts"),
    ].filter((f) => fs.existsSync(f));
    const selfBillingPattern = /self[\s_-]?bill/i;
    for (const file of csrRelatedFiles) {
      const text = fs.readFileSync(file, "utf8");
      expect(selfBillingPattern.test(text), `${path.relative(repoRoot, file)} must not mention self-billing`).toBe(false);
    }
  });

  it("the XML builder's InvoiceTypeCode name-attribute mapping is keyed only by invoice subtype (standard/simplified), never by any CSR or Functionality Map field", () => {
    const xmlBuilderPath = path.join(repoRoot, "server", "src", "lib", "zatca", "xmlBuilder.ts");
    const text = fs.readFileSync(xmlBuilderPath, "utf8");
    expect(text).not.toMatch(/functionalityMap/i);
    expect(text).not.toMatch(/csrInvoiceType/i);
    expect(text).not.toMatch(/invoiceType\[\s*3\s*\]/);
  });

  it("CanonicalZatcaDocument (types.ts) declares no CSR/Functionality-Map-derived field that could carry a position-4 self-billing flag into XML generation", () => {
    const typesPath = path.join(repoRoot, "server", "src", "lib", "zatca", "types.ts");
    const text = fs.readFileSync(typesPath, "utf8");
    expect(text).not.toMatch(/functionalityMap/i);
    expect(text).not.toMatch(/csrInvoiceType/i);
  });
});

// --- Behavioral guard: Functionality Map positions 3/4 are not interpreted ---
//
// Reuses the exact HTTP surface (CSR generate -> Compliance CSID -> Compliance
// Invoice) already exercised by Slice Q's invoiceFamily matrix
// (server/tests/zatcaComplianceAttempts.test.ts), with one variable changed:
// positions 3/4 of the CSR's invoiceType are non-zero. No meaning is
// asserted for what a non-zero position 3/4 value represents — only that
// the standard/simplified family check's outcome for positions 0/1 is
// unaffected by whatever positions 2/3 (0-indexed) contain.

beforeAll(() => {
  process.env.ZATCA_CSR_ECDSA_CURVE = "P-256";
  x509.cryptoProvider.set(webcrypto as unknown as Crypto);
});

const app = buildApp();

const baseFields = {
  commonName: "EGS-UNIT-Y",
  egsSerialNumber: "1-ACME-SW|2-1.0.0|3-SN99999",
  organizationIdentifier: "399999999900003",
  organizationUnitName: "Riyadh Branch",
  organizationName: "Test Company LLC",
  countryCode: "SA",
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

async function createEgsUnit(token: string): Promise<string> {
  const res = await request(app)
    .post("/api/zatca/egs-units")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: "Guardrail Unit", environment: "simulation" });
  return res.body.id as string;
}

async function generateCsr(token: string, egsUnitId: string, invoiceType: string, otp = "123456") {
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

async function submitComplianceInvoice(token: string, egsUnitId: string, invoiceFamily: "standard" | "simplified") {
  return request(app)
    .post(`/api/zatca/egs-units/${egsUnitId}/compliance-invoices`)
    .set("Authorization", `Bearer ${token}`)
    .send({
      documentType: "388",
      invoiceFamily,
      invoiceXmlBase64: "PGE+PC9hPg==",
      invoiceHashBase64: "abc123==",
      uuid: "22222222-2222-2222-2222-222222222222",
    });
}

async function setUpComplianceLifecycle(token: string, egsUnitId: string, invoiceType: string) {
  const csrRes = await generateCsr(token, egsUnitId, invoiceType);
  expect(csrRes.status).toBe(201);
  const csidRes = await requestComplianceCsid(token, egsUnitId, csrRes.body.csrDerBase64);
  expect(csidRes.status).toBe(201);
}

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

async function startMockFatoora(): Promise<{ url: string; close: () => Promise<void> }> {
  const http = await import("node:http");
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/compliance/invoices") {
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
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          requestID: 1234567890123,
          dispositionMessage: "ISSUED",
          binarySecurityToken: "cert-bytes-base64",
          secret: "shared-secret-value",
        }),
      );
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((res) => server.close(() => res())) });
    });
  });
}

let companyA: string, tokenA: string;
let cleanup: (() => Promise<void>) | undefined;

beforeAll(async () => {
  await resetDb();
  const resA = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Guardrail Co A", name: "Owner A", email: uniqueEmail("guard-a"), password: "password123" });
  companyA = resA.body.company.id;
  tokenA = resA.body.token;
  await request(app)
    .patch("/api/zatca/config")
    .set("Authorization", `Bearer ${tokenA}`)
    .send({ vatNumber: baseFields.organizationIdentifier, commercialRegistration: "1010101010" });
});

afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = undefined;
  clearFatooraEnv();
});

describe("Slice Y — Functionality Map positions 3/4 are not interpreted (§5, §20 of the Slice Y spec)", () => {
  it("invoiceType '1001' (positions 3/4 non-zero) still allows standard, exactly like '1000'", async () => {
    const mock = await startMockFatoora();
    cleanup = mock.close;
    setFatooraEnv(mock.url);
    const egsUnitId = await createEgsUnit(tokenA);
    await setUpComplianceLifecycle(tokenA, egsUnitId, "1001");
    const res = await submitComplianceInvoice(tokenA, egsUnitId, "standard");
    expect(res.status).toBe(201);
  });

  it("invoiceType '1001' (positions 3/4 non-zero) still rejects simplified, exactly like '1000'", async () => {
    const mock = await startMockFatoora();
    cleanup = mock.close;
    setFatooraEnv(mock.url);
    const egsUnitId = await createEgsUnit(tokenA);
    await setUpComplianceLifecycle(tokenA, egsUnitId, "1001");
    const res = await submitComplianceInvoice(tokenA, egsUnitId, "simplified");
    expect(res.status).toBe(400);
  });

  it("invoiceType '0111' (positions 3/4 non-zero) still allows simplified, exactly like '0100'", async () => {
    const mock = await startMockFatoora();
    cleanup = mock.close;
    setFatooraEnv(mock.url);
    const egsUnitId = await createEgsUnit(tokenA);
    await setUpComplianceLifecycle(tokenA, egsUnitId, "0111");
    const res = await submitComplianceInvoice(tokenA, egsUnitId, "simplified");
    expect(res.status).toBe(201);
  });

  it("invoiceType '0111' (positions 3/4 non-zero) still rejects standard, exactly like '0100'", async () => {
    const mock = await startMockFatoora();
    cleanup = mock.close;
    setFatooraEnv(mock.url);
    const egsUnitId = await createEgsUnit(tokenA);
    await setUpComplianceLifecycle(tokenA, egsUnitId, "0111");
    const res = await submitComplianceInvoice(tokenA, egsUnitId, "standard");
    expect(res.status).toBe(400);
  });

  it("invoiceType '1111' (positions 3/4 non-zero) allows both standard and simplified, exactly like '1100' — non-zero positions 3/4 are never a rejection reason on their own", async () => {
    const mock = await startMockFatoora();
    cleanup = mock.close;
    setFatooraEnv(mock.url);
    const egsUnitId = await createEgsUnit(tokenA);
    await setUpComplianceLifecycle(tokenA, egsUnitId, "1111");
    const standardRes = await submitComplianceInvoice(tokenA, egsUnitId, "standard");
    expect(standardRes.status).toBe(201);
    const simplifiedRes = await submitComplianceInvoice(tokenA, egsUnitId, "simplified");
    expect(simplifiedRes.status).toBe(201);
  });
});
