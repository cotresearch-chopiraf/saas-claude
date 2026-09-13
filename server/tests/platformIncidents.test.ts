import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { platformOperators, auditEvents } from "../src/db/schema.js";
import { hashPassword } from "../src/lib/password.js";

// MIDAD Final Pre-Launch audit, Phase 13 — Observability/Incident Center.
// Manual creation/tracking only (no automatic error->incident pipeline —
// see db/schema.ts's incidents table header comment). Covers both a
// tenant-scoped incident (real audit_events row) and a platform-wide one
// (companyId: null, no audit_events row possible — logger.info() instead,
// same precedent as ownership transfer / global feature flags).

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

async function registerCompany(name: string) {
  const reg = await request(app)
    .post("/api/auth/register")
    .send({ companyName: name, name: "Owner", email: uniqueEmail("inc-owner"), password: "password123" });
  expect(reg.status).toBe(201);
  return reg.body.company.id as string;
}

async function createOperatorToken(role: "platform_owner" | "platform_admin" | "support" | "compliance" | "auditor" = "platform_owner") {
  const email = uniqueEmail(`inc-${role}`);
  await db.insert(platformOperators).values({ email, name: role, role, passwordHash: await hashPassword("operatorpass123") });
  const login = await request(app).post("/api/platform/auth/login").send({ email, password: "operatorpass123" });
  expect(login.status).toBe(200);
  return login.body.token as string;
}

beforeEach(resetDb);

describe("platform incidents: auth boundary", () => {
  it("unauthenticated and tenant-JWT access are rejected", async () => {
    expect((await request(app).get("/api/platform/incidents")).status).toBe(401);
    expect((await request(app).post("/api/platform/incidents").send({})).status).toBe(401);
  });

  it("support role cannot read or manage incidents", async () => {
    const token = await createOperatorToken("support");
    const list = await request(app).get("/api/platform/incidents").set("Authorization", `Bearer ${token}`);
    expect(list.status).toBe(403);
    const create = await request(app)
      .post("/api/platform/incidents")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "X", description: "Y", severity: "low", affectedService: "api" });
    expect(create.status).toBe(403);
  });

  it("auditor can read but cannot create/manage", async () => {
    const token = await createOperatorToken("auditor");
    const list = await request(app).get("/api/platform/incidents").set("Authorization", `Bearer ${token}`);
    expect(list.status).toBe(200);
    const create = await request(app)
      .post("/api/platform/incidents")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "X", description: "Y", severity: "low", affectedService: "api" });
    expect(create.status).toBe(403);
  });

  it("compliance can create and manage incidents", async () => {
    const token = await createOperatorToken("compliance");
    const create = await request(app)
      .post("/api/platform/incidents")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "ZATCA outage", description: "Provider down", severity: "high", affectedService: "zatca" });
    expect(create.status).toBe(201);
  });
});

describe("platform incidents: tenant-scoped (audit_events row)", () => {
  it("creates an incident tied to a company and writes a real audit_events row", async () => {
    const companyId = await registerCompany("Incident Co");
    const token = await createOperatorToken("platform_owner");

    const create = await request(app)
      .post("/api/platform/incidents")
      .set("Authorization", `Bearer ${token}`)
      .send({ companyId, title: "Slow dashboard", description: "Timeouts reported", severity: "medium", affectedService: "web" });
    expect(create.status).toBe(201);
    expect(create.body.companyId).toBe(companyId);
    expect(create.body.status).toBe("open");

    const events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, create.body.id) });
    expect(events.length).toBe(1);
    expect(events[0].action).toBe("incident.created");
    expect(events[0].companyId).toBe(companyId);
    expect(events[0].source).toBe("platform_admin");
  });

  it("404s creating an incident for a company that does not exist", async () => {
    const token = await createOperatorToken("platform_owner");
    const res = await request(app)
      .post("/api/platform/incidents")
      .set("Authorization", `Bearer ${token}`)
      .send({ companyId: "00000000-0000-0000-0000-000000000000", title: "Missing co", description: "No such company", severity: "low", affectedService: "api" });
    expect(res.status).toBe(404);
  });

  it("requires resolution notes to close an incident, then records the second audit event", async () => {
    const companyId = await registerCompany("Resolve Co");
    const token = await createOperatorToken("platform_owner");

    const create = await request(app)
      .post("/api/platform/incidents")
      .set("Authorization", `Bearer ${token}`)
      .send({ companyId, title: "DB latency", description: "Slow queries", severity: "high", affectedService: "database" });
    expect(create.status).toBe(201);
    const id = create.body.id as string;

    const missingNotes = await request(app)
      .patch(`/api/platform/incidents/${id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "resolved" });
    expect(missingNotes.status).toBe(400);

    const resolved = await request(app)
      .patch(`/api/platform/incidents/${id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "resolved", resolutionNotes: "Added missing index" });
    expect(resolved.status).toBe(200);
    expect(resolved.body.status).toBe("resolved");
    expect(resolved.body.resolvedAt).not.toBeNull();

    const events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, id) });
    expect(events.map((e) => e.action).sort()).toEqual(["incident.created", "incident.status_updated"]);
  });
});

describe("platform incidents: platform-wide (companyId: null, no audit_events row)", () => {
  it("creates a platform-wide incident with no company and no audit_events row", async () => {
    const token = await createOperatorToken("platform_owner");
    const create = await request(app)
      .post("/api/platform/incidents")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Platform-wide outage", description: "All tenants affected", severity: "critical", affectedService: "infra" });
    expect(create.status).toBe(201);
    expect(create.body.companyId).toBeNull();

    const events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, create.body.id) });
    expect(events.length).toBe(0);
  });
});

describe("platform incidents: listing and filtering", () => {
  it("filters by status and companyId", async () => {
    const companyId = await registerCompany("Filter Co");
    const token = await createOperatorToken("platform_owner");

    await request(app)
      .post("/api/platform/incidents")
      .set("Authorization", `Bearer ${token}`)
      .send({ companyId, title: "Open one", description: "Something is wrong", severity: "low", affectedService: "api" });
    await request(app)
      .post("/api/platform/incidents")
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Platform-wide one", description: "Affects every tenant", severity: "low", affectedService: "api" });

    const scoped = await request(app).get(`/api/platform/incidents?companyId=${companyId}`).set("Authorization", `Bearer ${token}`);
    expect(scoped.status).toBe(200);
    expect(scoped.body.length).toBe(1);
    expect(scoped.body[0].companyId).toBe(companyId);

    const openOnly = await request(app).get("/api/platform/incidents?status=open").set("Authorization", `Bearer ${token}`);
    expect(openOnly.status).toBe(200);
    expect(openOnly.body.length).toBe(2);
  });

  it("404s reading a non-existent incident", async () => {
    const token = await createOperatorToken("platform_owner");
    const res = await request(app)
      .get("/api/platform/incidents/00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});
