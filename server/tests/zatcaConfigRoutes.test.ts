import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import request from "supertest";
import http from "node:http";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { companyTaxIdentifiers } from "../src/db/schema.js";

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

// ZATCA P2 remediation — company_tax_identifiers previously had no database
// uniqueness backstop: two concurrent PATCH /zatca/config requests for the
// same (companyId, identifierType) could both pass the application-level
// find-then-insert-or-update check before either committed, leaving two
// rows for what the domain model treats as a single identifier. The
// company_tax_identifiers_company_type_country_unique index (schema.ts)
// now makes Postgres the final authority; these tests prove it holds under
// genuine concurrency and that a losing request gets a clean 409, never an
// unhandled 500 or a silently duplicated row. Each test registers its own
// fresh company so results don't depend on state left over from the
// GET/PATCH describe block above or from test execution order.
describe("PATCH /api/zatca/config — company_tax_identifiers uniqueness (ZATCA P2)", () => {
  async function registerCompany(prefix: string) {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ companyName: `${prefix} Co`, name: "Owner", email: uniqueEmail(prefix), password: "password123" });
    expect(res.status).toBe(201);
    return { companyId: res.body.company.id as string, token: res.body.token as string };
  }

  it("1. valid first creation succeeds", async () => {
    const { token } = await registerCompany("zatca-uniq-first");
    const res = await request(app)
      .patch("/api/zatca/config")
      .set("Authorization", `Bearer ${token}`)
      .send({ vatNumber: "300000000000010" });
    expect(res.status).toBe(200);
    expect(res.body.identity.vatNumber).toBe("300000000000010");
  });

  it("2. sequential re-submission for the same identifier type updates the SAME row rather than creating a duplicate", async () => {
    const { companyId, token } = await registerCompany("zatca-uniq-seq");
    const first = await request(app)
      .patch("/api/zatca/config")
      .set("Authorization", `Bearer ${token}`)
      .send({ vatNumber: "300000000000011" });
    expect(first.status).toBe(200);

    const second = await request(app)
      .patch("/api/zatca/config")
      .set("Authorization", `Bearer ${token}`)
      .send({ vatNumber: "300000000000099" });
    expect(second.status).toBe(200);
    expect(second.body.identity.vatNumber).toBe("300000000000099");

    // Exactly one row exists for this company+type, not two.
    const rows = await db.query.companyTaxIdentifiers.findMany({
      where: and(eq(companyTaxIdentifiers.companyId, companyId), eq(companyTaxIdentifiers.identifierType, "vat_number")),
    });
    expect(rows.length).toBe(1);
  });

  it("3. N concurrent requests racing to set the SAME identifier type for the first time never create more than one row (structural, not application-level)", async () => {
    const { companyId, token } = await registerCompany("zatca-uniq-concurrent");
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        request(app)
          .patch("/api/zatca/config")
          .set("Authorization", `Bearer ${token}`)
          .send({ vatNumber: `30000000000${String(i).padStart(4, "0")}` }),
      ),
    );

    // Every request gets a real response — never an unhandled 500. Exactly
    // how many actually overlap in the SELECT-then-INSERT window (and so
    // lose with a 409) depends on real scheduling/IO timing — Node's event
    // loop does not guarantee all 8 requests reach their SELECT before any
    // commits, so a request that starts late may legitimately find the
    // winner's row already committed and take the UPDATE branch (200)
    // instead of racing at all. The one invariant the fix actually
    // guarantees, regardless of how many happen to race, is the database
    // state below — this is exactly what the earlier application-only
    // check-then-act could NOT guarantee, and it holds true whether zero
    // or seven of the eight requests happened to collide this run.
    expect(results.every((r) => r.status === 200 || r.status === 409)).toBe(true);
    const losers = results.filter((r) => r.status === 409);
    for (const loser of losers) {
      expect(typeof loser.body.error).toBe("string");
      expect(loser.body.error.length).toBeGreaterThan(0);
    }

    const rows = await db.query.companyTaxIdentifiers.findMany({
      where: and(eq(companyTaxIdentifiers.companyId, companyId), eq(companyTaxIdentifiers.identifierType, "vat_number")),
    });
    expect(rows.length).toBe(1);
  });

  it("4. different identifier types for the same company are independent and both succeed", async () => {
    const { token } = await registerCompany("zatca-uniq-diff-type");
    const res = await request(app)
      .patch("/api/zatca/config")
      .set("Authorization", `Bearer ${token}`)
      .send({ vatNumber: "300000000000020", commercialRegistration: "1010101020" });
    expect(res.status).toBe(200);
    expect(res.body.identity.vatNumber).toBe("300000000000020");
    expect(res.body.identity.commercialRegistration).toBe("1010101020");
  });

  it("5. CROSS-TENANT: two different companies concurrently setting the SAME value never conflict with each other — uniqueness is per-company, not global", async () => {
    const a = await registerCompany("zatca-uniq-tenant-a");
    const b = await registerCompany("zatca-uniq-tenant-b");
    const sameValue = "300000000000030";

    const [resA, resB] = await Promise.all([
      request(app).patch("/api/zatca/config").set("Authorization", `Bearer ${a.token}`).send({ vatNumber: sameValue }),
      request(app).patch("/api/zatca/config").set("Authorization", `Bearer ${b.token}`).send({ vatNumber: sameValue }),
    ]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    expect(resA.body.identity.vatNumber).toBe(sameValue);
    expect(resB.body.identity.vatNumber).toBe(sameValue);
  });

  it("6. no delete/re-create path exists for company_tax_identifiers in the current model — not applicable, and not invented here", () => {
    // routes/zatca.ts exposes no DELETE for tax identifiers; the only
    // mutation path is the PATCH /config upsert covered by the tests
    // above. Recorded explicitly rather than silently skipped.
    expect(true).toBe(true);
  });

  it("7. concurrent UPDATEs on an already-existing identifier cannot bypass the uniqueness constraint (still exactly one row afterward)", async () => {
    const { companyId, token } = await registerCompany("zatca-uniq-update-race");
    const created = await request(app)
      .patch("/api/zatca/config")
      .set("Authorization", `Bearer ${token}`)
      .send({ vatNumber: "300000000000040" });
    expect(created.status).toBe(200);

    // Now that a row exists, every one of these concurrent requests takes
    // the UPDATE-by-id branch (never the INSERT branch), so none of them
    // can violate the unique index — but they race each other for the
    // same row, and the model must still end up with exactly one row.
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        request(app)
          .patch("/api/zatca/config")
          .set("Authorization", `Bearer ${token}`)
          .send({ vatNumber: `30000000000${String(i).padStart(4, "5")}` }),
      ),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);

    const rows = await db.query.companyTaxIdentifiers.findMany({
      where: and(eq(companyTaxIdentifiers.companyId, companyId), eq(companyTaxIdentifiers.identifierType, "vat_number")),
    });
    expect(rows.length).toBe(1);
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
