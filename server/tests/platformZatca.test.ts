import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import http from "node:http";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { platformOperators } from "../src/db/schema.js";
import { hashPassword } from "../src/lib/password.js";

// MIDAD Admin Dashboard — ZATCA operations (Slice 3). Read-only,
// cross-tenant, platform-scoped aggregate. Verifies real counts and,
// critically, that no secret ever reaches this view.

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

async function registerCompany(name: string) {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ companyName: name, name: "Owner", email: uniqueEmail("platform-zatca"), password: "password123" });
  expect(res.status).toBe(201);
  return { token: res.body.token as string, companyId: res.body.company.id as string, name };
}

async function createOperator(email: string, password: string) {
  await db.insert(platformOperators).values({ email, name: "Operator", passwordHash: await hashPassword(password) });
}

function startMockZatca(status: number): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({}));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

let operatorToken: string;
let companyA: { token: string; companyId: string; name: string };
let companyB: { token: string; companyId: string; name: string };
const rawSecret = "PLATFORM-VIEW-MUST-NEVER-SEE-THIS-SECRET";

beforeAll(async () => {
  await resetDb();

  companyA = await registerCompany("Platform ZATCA Co A");
  companyB = await registerCompany("Platform ZATCA Co B");

  const operatorEmail = uniqueEmail("platform-zatca-operator");
  await createOperator(operatorEmail, "operatorpass123");
  const login = await request(app).post("/api/platform/auth/login").send({ email: operatorEmail, password: "operatorpass123" });
  expect(login.status).toBe(200);
  operatorToken = login.body.token;

  // Company A: one simulation unit, credential configured, connection
  // check rejected by the mock ZATCA server (feeds "recentFailedChecks").
  const unitARes = await request(app)
    .post("/api/zatca/egs-units")
    .set("Authorization", `Bearer ${companyA.token}`)
    .send({ name: "A Unit", environment: "simulation" });
  const unitA = unitARes.body;
  await request(app)
    .post(`/api/zatca/egs-units/${unitA.id}/credential`)
    .set("Authorization", `Bearer ${companyA.token}`)
    .send({ binarySecurityToken: "tok-a", secret: rawSecret });

  const rejectingServer = await startMockZatca(403);
  process.env.ZATCA_FATOORA_SIMULATION_BASE_URL = rejectingServer.url;
  process.env.ZATCA_FATOORA_SIMULATION_COMPLIANCE_PATH = "compliance/invoices";
  process.env.ZATCA_FATOORA_SIMULATION_CLEARANCE_PATH = "invoices/clearance/single";
  process.env.ZATCA_FATOORA_SIMULATION_REPORTING_PATH = "invoices/reporting/single";
  await request(app).post(`/api/zatca/egs-units/${unitA.id}/verify-connection`).set("Authorization", `Bearer ${companyA.token}`);
  await rejectingServer.close();
  delete process.env.ZATCA_FATOORA_SIMULATION_BASE_URL;
  delete process.env.ZATCA_FATOORA_SIMULATION_COMPLIANCE_PATH;
  delete process.env.ZATCA_FATOORA_SIMULATION_CLEARANCE_PATH;
  delete process.env.ZATCA_FATOORA_SIMULATION_REPORTING_PATH;

  // Company B: one production unit, never configured — stays not_onboarded.
  await request(app)
    .post("/api/zatca/egs-units")
    .set("Authorization", `Bearer ${companyB.token}`)
    .send({ name: "B Unit", environment: "production" });
});

describe("GET /api/platform/zatca", () => {
  it("requires platform authentication", async () => {
    const res = await request(app).get("/api/platform/zatca");
    expect(res.status).toBe(401);
  });

  it("a tenant token cannot access the platform ZATCA dashboard", async () => {
    const res = await request(app).get("/api/platform/zatca").set("Authorization", `Bearer ${companyA.token}`);
    expect(res.status).toBe(401);
  });

  it("reports real aggregate counts across tenants", async () => {
    const res = await request(app).get("/api/platform/zatca").set("Authorization", `Bearer ${operatorToken}`);
    expect(res.status).toBe(200);
    expect(res.body.totalEgsUnits).toBeGreaterThanOrEqual(2);
    expect(res.body.byEnvironment.simulation).toBeGreaterThanOrEqual(1);
    expect(res.body.byEnvironment.production).toBeGreaterThanOrEqual(1);
    expect(res.body.byStatus.not_onboarded).toBeGreaterThanOrEqual(1);
  });

  it("includes a real failed-connection-check entry for company A, with company name attached", async () => {
    const res = await request(app).get("/api/platform/zatca").set("Authorization", `Bearer ${operatorToken}`);
    const forCompanyA = res.body.recentFailedChecks.filter((e: { companyId: string }) => e.companyId === companyA.companyId);
    expect(forCompanyA.length).toBeGreaterThanOrEqual(1);
    expect(forCompanyA[0].companyName).toBe(companyA.name);
  });

  it("SECRET NON-LEAKAGE: the response never contains the raw secret value or any secretRef field", async () => {
    const res = await request(app).get("/api/platform/zatca").set("Authorization", `Bearer ${operatorToken}`);
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(rawSecret);
    expect(serialized).not.toContain("secretRef");
    expect(serialized).not.toContain("binarySecurityToken");
  });
});
