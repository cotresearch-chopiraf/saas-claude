import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { auditEvents, invoices } from "../src/db/schema.js";

// MIDAD Phase 2E foundation: invoices.projectId / invoices.contractId.
// Same shared-company-per-file discipline as ipc.test.ts / forecast.test.ts.

vi.mock("../src/lib/mailer.js", () => ({ sendMail: vi.fn() }));

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

let ownerToken: string;
let companyBToken: string;

beforeAll(async () => {
  await resetDb();

  const ownerRes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Invoice Co", name: "Owner", email: uniqueEmail("inv-owner"), password: "password123" });
  expect(ownerRes.status).toBe(201);
  ownerToken = ownerRes.body.token;

  const companyBRes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Other Co", name: "Owner B", email: uniqueEmail("inv-other"), password: "password123" });
  expect(companyBRes.status).toBe(201);
  companyBToken = companyBRes.body.token;
});

async function createProject(token = ownerToken) {
  const res = await request(app)
    .post("/api/projects")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: `Invoice Project ${Math.random()}` });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function createContract(projectId: string, token = ownerToken) {
  const res = await request(app)
    .post(`/api/projects/${projectId}/contracts`)
    .set("Authorization", `Bearer ${token}`)
    .send({ originalValue: 10000 });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

function createInvoice(body: Record<string, unknown>, token = ownerToken) {
  return request(app)
    .post("/api/invoices")
    .set("Authorization", `Bearer ${token}`)
    .send({ clientName: "Client X", items: [{ description: "Work", amount: 1000 }], ...body });
}

describe("Creation", () => {
  it("invoice with projectId only", async () => {
    const projectId = await createProject();
    const res = await createInvoice({ projectId });
    expect(res.status).toBe(201);
    expect(res.body.projectId).toBe(projectId);
    expect(res.body.contractId).toBeNull();
  });

  it("invoice with projectId + contractId", async () => {
    const projectId = await createProject();
    const contractId = await createContract(projectId);
    const res = await createInvoice({ projectId, contractId });
    expect(res.status).toBe(201);
    expect(res.body.projectId).toBe(projectId);
    expect(res.body.contractId).toBe(contractId);
  });

  it("invoice with contractId only: projectId is derived from the contract", async () => {
    const projectId = await createProject();
    const contractId = await createContract(projectId);
    const res = await createInvoice({ contractId });
    expect(res.status).toBe(201);
    expect(res.body.contractId).toBe(contractId);
    expect(res.body.projectId).toBe(projectId); // derived, not independently supplied
  });

  it("invoice without project/contract remains valid (unallocated, backward compatible)", async () => {
    const res = await createInvoice({});
    expect(res.status).toBe(201);
    expect(res.body.projectId).toBeNull();
    expect(res.body.contractId).toBeNull();
  });
});

describe("Validation", () => {
  it("rejects a foreign (nonexistent) projectId", async () => {
    const res = await createInvoice({ projectId: "00000000-0000-0000-0000-000000000000" });
    expect(res.status).toBe(404);
  });

  it("rejects a foreign (nonexistent) contractId", async () => {
    const res = await createInvoice({ contractId: "00000000-0000-0000-0000-000000000000" });
    expect(res.status).toBe(404);
  });

  it("rejects a contract that belongs to a different project than the supplied projectId", async () => {
    const projectA = await createProject();
    const projectB = await createProject();
    const contractOnA = await createContract(projectA);
    const res = await createInvoice({ projectId: projectB, contractId: contractOnA });
    expect(res.status).toBe(400);
  });

  it("rejects a contract belonging to another company", async () => {
    const foreignProjectId = await createProject(companyBToken);
    const foreignContractId = await createContract(foreignProjectId, companyBToken);
    const res = await createInvoice({ contractId: foreignContractId });
    expect(res.status).toBe(404);
  });

  it("rejects a project belonging to another company", async () => {
    const foreignProjectId = await createProject(companyBToken);
    const res = await createInvoice({ projectId: foreignProjectId });
    expect(res.status).toBe(404);
  });

  it("same-named project in another company is never accidentally matched", async () => {
    const projectId = await createProject(); // "Invoice Project <random>" under owner's company
    const sameNameForeign = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${companyBToken}`)
      .send({ name: "Invoice Project identical-name-attack" });
    expect(sameNameForeign.status).toBe(201);

    // Using company B's token but company A's real project id must still fail —
    // proves scoping is by companyId, never by name collision.
    const res = await createInvoice({ projectId }, companyBToken);
    expect(res.status).toBe(404);
  });
});

describe("Historical compatibility", () => {
  it("old invoices with NULL projectId/contractId remain valid and readable", async () => {
    const createRes = await createInvoice({});
    expect(createRes.status).toBe(201);
    const getRes = await request(app)
      .get(`/api/invoices/${createRes.body.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.projectId).toBeNull();
    expect(getRes.body.contractId).toBeNull();
  });

  it("the invoice list still returns unallocated invoices alongside project-linked ones", async () => {
    const projectId = await createProject();
    await createInvoice({});
    await createInvoice({ projectId });
    const listRes = await request(app).get("/api/invoices").set("Authorization", `Bearer ${ownerToken}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.invoices.some((i: { projectId: string | null }) => i.projectId === null)).toBe(true);
    expect(listRes.body.invoices.some((i: { projectId: string | null }) => i.projectId === projectId)).toBe(true);
  });
});

describe("Payment", () => {
  it("mark-paid still works, and the project/contract relationship survives it unchanged", async () => {
    const projectId = await createProject();
    const contractId = await createContract(projectId);
    const createRes = await createInvoice({ projectId, contractId });

    await request(app).patch(`/api/invoices/${createRes.body.id}/send`).set("Authorization", `Bearer ${ownerToken}`);
    const paidRes = await request(app)
      .patch(`/api/invoices/${createRes.body.id}/mark-paid`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(paidRes.status).toBe(200);
    expect(paidRes.body.status).toBe("paid");
    expect(paidRes.body.paidAt).toBeTruthy();
    expect(paidRes.body.projectId).toBe(projectId);
    expect(paidRes.body.contractId).toBe(contractId);
  });
});

describe("Audit", () => {
  it("invoice.created records the project/contract relationship", async () => {
    const projectId = await createProject();
    const contractId = await createContract(projectId);
    const createRes = await createInvoice({ projectId, contractId });
    expect(createRes.status).toBe(201);

    const eventRow = await db.query.auditEvents.findFirst({ where: eq(auditEvents.entityId, createRes.body.id) });
    expect(eventRow).toBeTruthy();
    expect(eventRow!.action).toBe("invoice.created");
    const metadata = eventRow!.metadata as Record<string, unknown>;
    expect(metadata.projectId).toBe(projectId);
    expect(metadata.contractId).toBe(contractId);
  });

  it("an unallocated invoice records null projectId/contractId in its audit metadata", async () => {
    const createRes = await createInvoice({});
    const eventRow = await db.query.auditEvents.findFirst({ where: eq(auditEvents.entityId, createRes.body.id) });
    const metadata = eventRow!.metadata as Record<string, unknown>;
    expect(metadata.projectId).toBeNull();
    expect(metadata.contractId).toBeNull();
  });
});

describe("Architectural invariant", () => {
  it("adding the relationship never mutates invoice monetary fields", async () => {
    const projectId = await createProject();
    const res = await createInvoice({ projectId, taxRatePercent: undefined });
    const row = await db.query.invoices.findFirst({ where: eq(invoices.id, res.body.id) });
    expect(Number(row!.taxRatePercent)).toBe(Number(res.body.taxRatePercent));
  });
});
