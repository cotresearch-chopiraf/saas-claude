import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import request from "supertest";
import http from "node:http";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";

// MIDAD ZATCA Slice 3 — /api/zatca/* route tests: tenant isolation,
// authorization (owner vs member), secret non-leakage in API responses
// and logs, and real (never fabricated) connection-check state
// transitions against a local mock ZATCA server.

vi.mock("../src/lib/mailer.js", () => ({ sendMail: vi.fn() }));
import { sendMail } from "../src/lib/mailer.js";

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

function extractToken(mailBody: string): string {
  const match = mailBody.match(/token=([a-f0-9]{64})/);
  if (!match) throw new Error(`no token found in mail body: ${mailBody}`);
  return match[1];
}

let companyA: string;
let tokenA: string;
let companyB: string;
let tokenB: string;
let memberTokenA: string;

beforeAll(async () => {
  await resetDb();

  const resA = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "ZATCA Routes Co A", name: "Owner A", email: uniqueEmail("zatca-routes-a"), password: "password123" });
  companyA = resA.body.company.id;
  tokenA = resA.body.token;

  const resB = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "ZATCA Routes Co B", name: "Owner B", email: uniqueEmail("zatca-routes-b"), password: "password123" });
  companyB = resB.body.company.id;
  tokenB = resB.body.token;

  const inviteRes = await request(app)
    .post("/api/company/invites")
    .set("Authorization", `Bearer ${tokenA}`)
    .send({ email: uniqueEmail("zatca-routes-member-a"), role: "member" });
  expect(inviteRes.status).toBe(201);
  const mailCall = (sendMail as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
  const inviteToken = extractToken(mailCall[2] as string);
  const acceptRes = await request(app)
    .post("/api/auth/accept-invite")
    .send({ token: inviteToken, name: "Member A", password: "memberpass123" });
  expect(acceptRes.status).toBe(201);
  memberTokenA = acceptRes.body.token;
});

async function createEgsUnit(token: string, environment: "simulation" | "production" = "simulation") {
  const res = await request(app)
    .post("/api/zatca/egs-units")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: "Main Office", environment });
  expect(res.status).toBe(201);
  return res.body as { id: string; status: string; csidStatus: string; hasCredential: boolean };
}

describe("GET/PATCH /api/zatca/config", () => {
  it("returns an empty-but-real identity for a fresh company", async () => {
    const res = await request(app).get("/api/zatca/config").set("Authorization", `Bearer ${tokenB}`);
    expect(res.status).toBe(200);
    expect(res.body.identity.vatNumber).toBeNull();
    expect(res.body.egsUnits).toEqual([]);
  });

  it("owner can set VAT number / commercial registration", async () => {
    const res = await request(app)
      .patch("/api/zatca/config")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ vatNumber: "300000000000003", commercialRegistration: "1010101010" });
    expect(res.status).toBe(200);
    expect(res.body.identity.vatNumber).toBe("300000000000003");
    expect(res.body.identity.commercialRegistration).toBe("1010101010");
  });

  it("AUTHORIZATION: a member cannot configure ZATCA identity", async () => {
    const res = await request(app)
      .patch("/api/zatca/config")
      .set("Authorization", `Bearer ${memberTokenA}`)
      .send({ vatNumber: "300000000000003" });
    expect(res.status).toBe(403);
  });

  it("TENANT ISOLATION: company B's identity is unaffected by company A's update", async () => {
    const res = await request(app).get("/api/zatca/config").set("Authorization", `Bearer ${tokenB}`);
    expect(res.body.identity.vatNumber).toBeNull();
  });
});

describe("EGS unit lifecycle", () => {
  it("AUTHORIZATION: a member cannot create an EGS unit", async () => {
    const res = await request(app)
      .post("/api/zatca/egs-units")
      .set("Authorization", `Bearer ${memberTokenA}`)
      .send({ name: "Member Attempt", environment: "simulation" });
    expect(res.status).toBe(403);
  });

  it("owner creates an EGS unit starting in a real, non-fabricated state", async () => {
    const unit = await createEgsUnit(tokenA);
    expect(unit.status).toBe("not_onboarded");
    expect(unit.csidStatus).toBe("none");
    expect(unit.hasCredential).toBe(false);
  });

  it("TENANT ISOLATION: company B cannot read company A's EGS unit", async () => {
    const unit = await createEgsUnit(tokenA);
    const res = await request(app).get(`/api/zatca/egs-units/${unit.id}`).set("Authorization", `Bearer ${tokenB}`);
    expect(res.status).toBe(404);
  });

  it("a client cannot PATCH an EGS unit directly to status: active", async () => {
    const unit = await createEgsUnit(tokenA);
    const res = await request(app)
      .patch(`/api/zatca/egs-units/${unit.id}`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ status: "active" });
    expect(res.status).toBe(400);
  });

  it("owner can deactivate an EGS unit", async () => {
    const unit = await createEgsUnit(tokenA);
    const res = await request(app)
      .patch(`/api/zatca/egs-units/${unit.id}`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ status: "deactivated" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("deactivated");
  });
});

describe("credential configuration — secret non-leakage", () => {
  const rawSecret = "RAW-SECRET-VALUE-MUST-NEVER-LEAK";
  const rawToken = "RAW-BINARY-SECURITY-TOKEN-MUST-NEVER-LEAK";

  it("AUTHORIZATION: a member cannot configure credentials", async () => {
    const unit = await createEgsUnit(tokenA);
    const res = await request(app)
      .post(`/api/zatca/egs-units/${unit.id}/credential`)
      .set("Authorization", `Bearer ${memberTokenA}`)
      .send({ binarySecurityToken: rawToken, secret: rawSecret });
    expect(res.status).toBe(403);
  });

  it("stores a credential without ever returning it, and advances status to onboarding", async () => {
    const unit = await createEgsUnit(tokenA);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(app)
      .post(`/api/zatca/egs-units/${unit.id}/credential`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ binarySecurityToken: rawToken, secret: rawSecret });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("onboarding");
    expect(res.body.hasCredential).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(rawSecret);
    expect(JSON.stringify(res.body)).not.toContain(rawToken);

    // Secrets never appear in logs.
    const allLoggedText = [...logSpy.mock.calls, ...errorSpy.mock.calls].flat().map((v) => JSON.stringify(v)).join("\n");
    expect(allLoggedText).not.toContain(rawSecret);
    expect(allLoggedText).not.toContain(rawToken);
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("secrets never appear in the audit trail", async () => {
    const unit = await createEgsUnit(tokenA);
    await request(app)
      .post(`/api/zatca/egs-units/${unit.id}/credential`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ binarySecurityToken: rawToken, secret: rawSecret });

    const auditRes = await request(app).get("/api/audit-events").set("Authorization", `Bearer ${tokenA}`);
    expect(auditRes.status).toBe(200);
    expect(JSON.stringify(auditRes.body)).not.toContain(rawSecret);
    expect(JSON.stringify(auditRes.body)).not.toContain(rawToken);
  });

  it("DELETE clears the credential", async () => {
    const unit = await createEgsUnit(tokenA);
    await request(app)
      .post(`/api/zatca/egs-units/${unit.id}/credential`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ binarySecurityToken: rawToken, secret: rawSecret });

    const res = await request(app).delete(`/api/zatca/egs-units/${unit.id}/credential`).set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.hasCredential).toBe(false);
  });
});

describe("POST /api/zatca/egs-units/:id/verify-connection", () => {
  const ENV_KEYS = [
    "ZATCA_FATOORA_SIMULATION_BASE_URL",
    "ZATCA_FATOORA_SIMULATION_COMPLIANCE_PATH",
    "ZATCA_FATOORA_SIMULATION_CLEARANCE_PATH",
    "ZATCA_FATOORA_SIMULATION_REPORTING_PATH",
  ];
  let cleanupServer: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanupServer) await cleanupServer();
    cleanupServer = undefined;
    for (const key of ENV_KEYS) delete process.env[key];
  });

  function startMockZatca(status: number): Promise<string> {
    return new Promise((resolve) => {
      const server = http.createServer((_req, res) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({}));
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        cleanupServer = () => new Promise((r) => server.close(() => r()));
        resolve(`http://127.0.0.1:${port}`);
      });
    });
  }

  it("returns NOT_CONNECTED without contacting ZATCA when no credential is configured", async () => {
    const unit = await createEgsUnit(tokenA);
    const res = await request(app)
      .post(`/api/zatca/egs-units/${unit.id}/verify-connection`)
      .set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(false);
    expect(res.body.reason).toBe("not_connected");
    expect(res.body.egsUnit.status).toBe("not_onboarded");
  });

  it("AUTHORIZATION: a member cannot trigger a connection check", async () => {
    const unit = await createEgsUnit(tokenA);
    const res = await request(app)
      .post(`/api/zatca/egs-units/${unit.id}/verify-connection`)
      .set("Authorization", `Bearer ${memberTokenA}`);
    expect(res.status).toBe(403);
  });

  it("TENANT ISOLATION: company B cannot verify company A's EGS unit", async () => {
    const unit = await createEgsUnit(tokenA);
    const res = await request(app)
      .post(`/api/zatca/egs-units/${unit.id}/verify-connection`)
      .set("Authorization", `Bearer ${tokenB}`);
    expect(res.status).toBe(404);
  });

  it("STATE TRANSITION: a real successful probe moves the unit to active", async () => {
    const unit = await createEgsUnit(tokenA, "simulation");
    await request(app)
      .post(`/api/zatca/egs-units/${unit.id}/credential`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ binarySecurityToken: "tok", secret: "sec" });

    const baseUrl = await startMockZatca(404); // reachable, not 401/403 -> connected: true
    process.env.ZATCA_FATOORA_SIMULATION_BASE_URL = baseUrl;
    process.env.ZATCA_FATOORA_SIMULATION_COMPLIANCE_PATH = "compliance/invoices";
    process.env.ZATCA_FATOORA_SIMULATION_CLEARANCE_PATH = "invoices/clearance/single";
    process.env.ZATCA_FATOORA_SIMULATION_REPORTING_PATH = "invoices/reporting/single";

    const res = await request(app)
      .post(`/api/zatca/egs-units/${unit.id}/verify-connection`)
      .set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(true);
    expect(res.body.egsUnit.status).toBe("active");
  });

  it("STATE TRANSITION: a rejected credential does not advance the unit to active", async () => {
    const unit = await createEgsUnit(tokenA, "simulation");
    await request(app)
      .post(`/api/zatca/egs-units/${unit.id}/credential`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ binarySecurityToken: "tok", secret: "sec" });

    const baseUrl = await startMockZatca(403);
    process.env.ZATCA_FATOORA_SIMULATION_BASE_URL = baseUrl;
    process.env.ZATCA_FATOORA_SIMULATION_COMPLIANCE_PATH = "compliance/invoices";
    process.env.ZATCA_FATOORA_SIMULATION_CLEARANCE_PATH = "invoices/clearance/single";
    process.env.ZATCA_FATOORA_SIMULATION_REPORTING_PATH = "invoices/reporting/single";

    const res = await request(app)
      .post(`/api/zatca/egs-units/${unit.id}/verify-connection`)
      .set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(200);
    expect(res.body.connected).toBe(false);
    expect(res.body.reason).toBe("credential_rejected");
    expect(res.body.egsUnit.status).toBe("onboarding");
  });

  it("NEVER fabricates success: a network failure returns a real error, not a fake connected state", async () => {
    const unit = await createEgsUnit(tokenA, "simulation");
    await request(app)
      .post(`/api/zatca/egs-units/${unit.id}/credential`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ binarySecurityToken: "tok", secret: "sec" });

    process.env.ZATCA_FATOORA_SIMULATION_BASE_URL = "http://127.0.0.1:1"; // nothing listens here
    process.env.ZATCA_FATOORA_SIMULATION_COMPLIANCE_PATH = "compliance/invoices";
    process.env.ZATCA_FATOORA_SIMULATION_CLEARANCE_PATH = "invoices/clearance/single";
    process.env.ZATCA_FATOORA_SIMULATION_REPORTING_PATH = "invoices/reporting/single";

    const res = await request(app)
      .post(`/api/zatca/egs-units/${unit.id}/verify-connection`)
      .set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(504);
    expect(res.body.category).toBe("network");
    expect(res.body.connected).toBeUndefined();
  });

  it("a real endpoint-not-configured environment returns a configuration error, never a fabricated result", async () => {
    const unit = await createEgsUnit(tokenA, "simulation");
    await request(app)
      .post(`/api/zatca/egs-units/${unit.id}/credential`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ binarySecurityToken: "tok", secret: "sec" });
    // No ZATCA_FATOORA_SIMULATION_* env vars set at all.

    const res = await request(app)
      .post(`/api/zatca/egs-units/${unit.id}/verify-connection`)
      .set("Authorization", `Bearer ${tokenA}`);
    expect(res.status).toBe(400);
    expect(res.body.category).toBe("configuration");

    // A configuration error means no network attempt was ever made — the
    // unit's lastCommunicationAt must stay exactly as it was before this
    // call (still null here), never advanced as if ZATCA had been contacted.
    const getRes = await request(app).get(`/api/zatca/egs-units/${unit.id}`).set("Authorization", `Bearer ${tokenA}`);
    expect(getRes.body.lastCommunicationAt).toBeNull();
  });
});
