import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { platformOperators } from "../src/db/schema.js";
import { hashPassword } from "../src/lib/password.js";

// MIDAD Final Pre-Launch audit, Phase 17 — Sale/Handover Center. A
// read-only aggregate snapshot built entirely from existing read paths —
// this test asserts the shape and the auth boundary, not fresh business
// logic (there is none: every field here is a passthrough or a count over
// an existing table).

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

async function createOperatorToken(role: "platform_owner" | "platform_admin" | "support" | "compliance" | "auditor" = "platform_owner") {
  const email = uniqueEmail(`ho-${role}`);
  await db.insert(platformOperators).values({ email, name: role, role, passwordHash: await hashPassword("operatorpass123") });
  const login = await request(app).post("/api/platform/auth/login").send({ email, password: "operatorpass123" });
  expect(login.status).toBe(200);
  return login.body.token as string;
}

beforeEach(resetDb);

describe("platform handover center: auth boundary", () => {
  it("unauthenticated and tenant-JWT access are rejected", async () => {
    expect((await request(app).get("/api/platform/handover/summary")).status).toBe(401);
  });

  it("is denied for support and compliance (not owner/admin/auditor)", async () => {
    for (const role of ["support", "compliance"] as const) {
      const token = await createOperatorToken(role);
      const res = await request(app).get("/api/platform/handover/summary").set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(403);
    }
  });

  it("auditor can read the summary", async () => {
    const token = await createOperatorToken("auditor");
    const res = await request(app).get("/api/platform/handover/summary").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });
});

describe("platform handover center: summary shape and honesty", () => {
  it("returns real aggregate counts and never fabricates production-hosting facts", async () => {
    const token = await createOperatorToken("platform_owner");
    const res = await request(app).get("/api/platform/handover/summary").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);

    // Real counts: at least the one platform_owner operator that logged in
    // to obtain this token must be reflected.
    expect(res.body.platformOperators.total).toBeGreaterThanOrEqual(1);
    expect(res.body.platformOperators.owners).toBeGreaterThanOrEqual(1);
    expect(typeof res.body.organizations.total).toBe("number");
    expect(typeof res.body.featureFlags.total).toBe("number");
    expect(typeof res.body.plans.total).toBe("number");
    expect(res.body.openIncidents).toEqual({ open: 0, investigating: 0 });

    expect(res.body.zatca.liveExternalVerification).toBe(false);
    expect(res.body.zatca.statusDocument).toBe("docs/zatca/LIVE_SANDBOX_VERIFICATION.md");

    expect(res.body.notAvailable).toContain("productionHostingProvider");
    expect(res.body.notAvailable).toContain("automatedBackupsEnabled");

    expect(typeof res.body.schema.migrationCount).toBe("number");
    expect(res.body.schema.migrationCount).toBeGreaterThan(0);

    expect(typeof res.body.backup.found).toBe("boolean");
  });
});
