import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { auditEvents, budgetItems } from "../src/db/schema.js";

// Real code path, not a mock of the app: only the outbound "email" is
// intercepted so the test can read the raw invite token, same as
// authorization.test.ts / compliance.test.ts.
vi.mock("../src/lib/mailer.js", () => ({ sendMail: vi.fn() }));
import { sendMail } from "../src/lib/mailer.js";

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

// One owner + one member account, and one company B for tenant-isolation
// checks, all registered ONCE for this whole file (register/accept-invite
// are rate-limited — a real user only does this once) and reused across
// every test; each test creates its own fresh project/contract/revision so
// tests never interfere with each other's data.
let ownerToken: string;
let memberToken: string;
let companyBToken: string;

beforeAll(async () => {
  await resetDb();

  const ownerRes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Midad Co", name: "Owner", email: uniqueEmail("midad-owner"), password: "password123" });
  expect(ownerRes.status).toBe(201);
  ownerToken = ownerRes.body.token;

  const inviteRes = await request(app)
    .post("/api/company/invites")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ email: uniqueEmail("midad-member"), role: "member" });
  expect(inviteRes.status).toBe(201);
  const mailCall = (sendMail as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
  const inviteToken = (mailCall[2] as string).match(/token=([a-f0-9]{64})/)![1];
  const acceptRes = await request(app)
    .post("/api/auth/accept-invite")
    .send({ token: inviteToken, name: "Member", password: "memberpass123" });
  expect(acceptRes.status).toBe(201);
  memberToken = acceptRes.body.token;

  const companyBRes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Other Co", name: "Owner B", email: uniqueEmail("midad-other"), password: "password123" });
  expect(companyBRes.status).toBe(201);
  companyBToken = companyBRes.body.token;
});

async function createProject(token = ownerToken) {
  const res = await request(app)
    .post("/api/projects")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: `Midad Project ${Math.random()}`, budgetTotal: 100000 });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function createContract(projectId: string, overrides: Record<string, unknown> = {}) {
  const res = await request(app)
    .post(`/api/projects/${projectId}/contracts`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ contractNumber: "C-1", clientName: "Client", originalValue: 50000, ...overrides });
  expect(res.status).toBe(201);
  return res.body as { id: string; revisedValue: string; originalValue: string; contractType: string };
}

describe("MIDAD Phase 1 — Contract foundation", () => {
  it("creates a main contract with revisedValue defaulting to originalValue", async () => {
    const projectId = await createProject();
    const contract = await createContract(projectId, { originalValue: 75000 });
    expect(contract.contractType).toBe("main");
    expect(Number(contract.revisedValue)).toBe(75000);
  });

  it("creates an amendment referencing a valid parent contract", async () => {
    const projectId = await createProject();
    const parent = await createContract(projectId);

    const res = await request(app)
      .post(`/api/projects/${projectId}/contracts`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractType: "amendment", parentContractId: parent.id, originalValue: 5000 });
    expect(res.status).toBe(201);
    expect(res.body.parentContractId).toBe(parent.id);
  });

  it("rejects an amendment with no parentContractId", async () => {
    const projectId = await createProject();
    const res = await request(app)
      .post(`/api/projects/${projectId}/contracts`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractType: "amendment", originalValue: 5000 });
    expect(res.status).toBe(400);
  });

  it("rejects an amendment whose parentContractId belongs to a different project", async () => {
    const projectId = await createProject();
    const otherProjectId = await createProject();
    const parent = await createContract(otherProjectId);

    const res = await request(app)
      .post(`/api/projects/${projectId}/contracts`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractType: "amendment", parentContractId: parent.id, originalValue: 5000 });
    expect(res.status).toBe(404);
  });

  it("records an audit event with before/after on update, and updates revisedValue", async () => {
    const projectId = await createProject();
    const contract = await createContract(projectId, { originalValue: 20000 });

    const res = await request(app)
      .patch(`/api/projects/${projectId}/contracts/${contract.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ revisedValue: 22000, status: "active" });
    expect(res.status).toBe(200);
    expect(Number(res.body.revisedValue)).toBe(22000);

    const events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, contract.id) });
    const updateEvent = events.find((e) => e.action === "contract.updated");
    expect(updateEvent).toBeTruthy();
    expect((updateEvent!.beforeValue as { revisedValue: string }).revisedValue).toBe("20000.00");
  });

  it("a member cannot create or update a contract", async () => {
    const projectId = await createProject();
    const createRes = await request(app)
      .post(`/api/projects/${projectId}/contracts`)
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ originalValue: 1000 });
    expect(createRes.status).toBe(403);

    const contract = await createContract(projectId);
    const updateRes = await request(app)
      .patch(`/api/projects/${projectId}/contracts/${contract.id}`)
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ revisedValue: 999 });
    expect(updateRes.status).toBe(403);
  });

  it("another company cannot read or create contracts on this project", async () => {
    const projectId = await createProject();
    const contract = await createContract(projectId);

    const getRes = await request(app)
      .get(`/api/projects/${projectId}/contracts/${contract.id}`)
      .set("Authorization", `Bearer ${companyBToken}`);
    expect(getRes.status).toBe(404);

    const listRes = await request(app)
      .get(`/api/projects/${projectId}/contracts`)
      .set("Authorization", `Bearer ${companyBToken}`);
    expect(listRes.status).toBe(404);
  });
});

describe("MIDAD Phase 1 — Cost code hierarchy", () => {
  it("creates a company-wide cost code and lists it without a projectId", async () => {
    const res = await request(app)
      .post("/api/cost-codes")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ code: `CC-${Date.now()}`, name: "Concrete works", category: "materials" });
    expect(res.status).toBe(201);
    expect(res.body.projectId).toBeFalsy();

    const listRes = await request(app).get("/api/cost-codes").set("Authorization", `Bearer ${ownerToken}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.some((c: { id: string }) => c.id === res.body.id)).toBe(true);
  });

  it("a project-specific cost code only shows up when filtering by that project", async () => {
    const projectId = await createProject();
    const otherProjectId = await createProject();

    const res = await request(app)
      .post("/api/cost-codes")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ code: `CC-P-${Date.now()}`, name: "Site-specific labor", projectId });
    expect(res.status).toBe(201);

    const withProject = await request(app)
      .get("/api/cost-codes")
      .query({ projectId })
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(withProject.body.some((c: { id: string }) => c.id === res.body.id)).toBe(true);

    const withOtherProject = await request(app)
      .get("/api/cost-codes")
      .query({ projectId: otherProjectId })
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(withOtherProject.body.some((c: { id: string }) => c.id === res.body.id)).toBe(false);

    const withoutProject = await request(app).get("/api/cost-codes").set("Authorization", `Bearer ${ownerToken}`);
    expect(withoutProject.body.some((c: { id: string }) => c.id === res.body.id)).toBe(false);
  });

  it("rejects a projectId belonging to another company", async () => {
    const otherProjectRes = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${companyBToken}`)
      .send({ name: "Other co project" });
    const res = await request(app)
      .post("/api/cost-codes")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ code: "CC-X", name: "Should fail", projectId: otherProjectRes.body.id });
    expect(res.status).toBe(404);
  });

  it("rejects an unknown parentCostCodeId", async () => {
    const res = await request(app)
      .post("/api/cost-codes")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ code: "CC-orphan", name: "Orphan", parentCostCodeId: "00000000-0000-0000-0000-000000000000" });
    expect(res.status).toBe(404);
  });

  it("a member cannot create a cost code", async () => {
    const res = await request(app)
      .post("/api/cost-codes")
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ code: "CC-member", name: "Should fail" });
    expect(res.status).toBe(403);
  });
});

describe("MIDAD Phase 1 — BOQ revisions", () => {
  async function createContractForProject() {
    const projectId = await createProject();
    const contract = await createContract(projectId);
    return { projectId, contractId: contract.id };
  }

  it("claims sequential revision numbers per contract", async () => {
    const { projectId, contractId } = await createContractForProject();

    const first = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId });
    expect(first.status).toBe(201);
    expect(first.body.revision_number).toBe(1);

    const second = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId });
    expect(second.status).toBe(201);
    expect(second.body.revision_number).toBe(2);
  });

  it("rejects a contractId that does not belong to this project", async () => {
    const { projectId } = await createContractForProject();
    const otherProjectId = await createProject();
    const otherContract = await createContract(otherProjectId);

    const res = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId: otherContract.id });
    expect(res.status).toBe(404);
  });

  it("computes item amount as quantity * rate, and lists items with the revision", async () => {
    const { projectId, contractId } = await createContractForProject();
    const revRes = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId });
    const revisionId = revRes.body.id as string;

    const itemRes = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions/${revisionId}/items`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ description: "Excavation", unit: "m3", quantity: 12.5, rate: 40 });
    expect(itemRes.status).toBe(201);
    expect(Number(itemRes.body.amount)).toBe(500);

    const getRes = await request(app)
      .get(`/api/projects/${projectId}/boq-revisions/${revisionId}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(getRes.body.items).toHaveLength(1);
  });

  it("publishing is a one-way, immutable transition: items can't be added or removed after publish", async () => {
    const { projectId, contractId } = await createContractForProject();
    const revRes = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId });
    const revisionId = revRes.body.id as string;

    const itemRes = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions/${revisionId}/items`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ description: "Formwork", quantity: 1, rate: 100 });

    const publishRes = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions/${revisionId}/publish`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(publishRes.status).toBe(200);
    expect(publishRes.body.status).toBe("published");

    const addAfterPublish = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions/${revisionId}/items`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ description: "Too late", quantity: 1, rate: 1 });
    expect(addAfterPublish.status).toBe(409);

    const deleteAfterPublish = await request(app)
      .delete(`/api/projects/${projectId}/boq-revisions/${revisionId}/items/${itemRes.body.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(deleteAfterPublish.status).toBe(409);

    const republish = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions/${revisionId}/publish`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(republish.status).toBe(409);
  });

  it("publishing a new revision supersedes the previously published one for the same contract", async () => {
    const { projectId, contractId } = await createContractForProject();
    const rev1 = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId });
    await request(app)
      .post(`/api/projects/${projectId}/boq-revisions/${rev1.body.id}/publish`)
      .set("Authorization", `Bearer ${ownerToken}`);

    const rev2 = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId });
    const publish2 = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions/${rev2.body.id}/publish`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(publish2.status).toBe(200);

    const rev1After = await request(app)
      .get(`/api/projects/${projectId}/boq-revisions/${rev1.body.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(rev1After.body.status).toBe("superseded");
  });

  // Dynamic concurrency test, same discipline as tests/concurrency.test.ts:
  // two simultaneous publish calls on the SAME draft revision must never
  // both succeed — exactly one 200 and one 409.
  it("concurrent publish attempts on the same revision: exactly one succeeds", async () => {
    const { projectId, contractId } = await createContractForProject();
    const revRes = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId });
    const revisionId = revRes.body.id as string;

    const publish = () =>
      request(app)
        .post(`/api/projects/${projectId}/boq-revisions/${revisionId}/publish`)
        .set("Authorization", `Bearer ${ownerToken}`);

    const [r1, r2] = await Promise.all([publish(), publish()]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);
  });

  it("a member cannot create a revision, add items, or publish", async () => {
    const { projectId, contractId } = await createContractForProject();
    const createRes = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions`)
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ contractId });
    expect(createRes.status).toBe(403);
  });

  it("another company cannot read this project's BOQ revisions", async () => {
    const { projectId, contractId } = await createContractForProject();
    const revRes = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId });

    const res = await request(app)
      .get(`/api/projects/${projectId}/boq-revisions/${revRes.body.id}`)
      .set("Authorization", `Bearer ${companyBToken}`);
    expect(res.status).toBe(404);
  });
});

describe("MIDAD Phase 1 — Budget revisions", () => {
  it("claims sequential revision numbers per project and lists them", async () => {
    const projectId = await createProject();

    const first = await request(app)
      .post(`/api/projects/${projectId}/budget-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ reason: "Initial allocation" });
    expect(first.status).toBe(201);
    expect(first.body.revision_number).toBe(1);

    const second = await request(app)
      .post(`/api/projects/${projectId}/budget-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ reason: "Reallocate materials to labor" });
    expect(second.status).toBe(201);
    expect(second.body.revision_number).toBe(2);

    const listRes = await request(app)
      .get(`/api/projects/${projectId}/budget-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(listRes.body).toHaveLength(2);
  });

  it("assigns a budget item to a draft revision, optionally re-tagging its cost code, and audits it", async () => {
    const projectId = await createProject();
    const itemRes = await request(app)
      .post(`/api/projects/${projectId}/budget/items`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ category: "Materials", plannedAmount: 5000 });
    const budgetItemId = itemRes.body.id as string;

    const costCodeRes = await request(app)
      .post("/api/cost-codes")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ code: `CC-BR-${Date.now()}`, name: "Materials code" });

    const revRes = await request(app)
      .post(`/api/projects/${projectId}/budget-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({});
    const revisionId = revRes.body.id as string;

    const assignRes = await request(app)
      .post(`/api/projects/${projectId}/budget-revisions/${revisionId}/items/${budgetItemId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ costCodeId: costCodeRes.body.id });
    expect(assignRes.status).toBe(200);
    expect(assignRes.body.budgetRevisionId).toBe(revisionId);
    expect(assignRes.body.costCodeId).toBe(costCodeRes.body.id);

    const events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, budgetItemId) });
    expect(events.some((e) => e.action === "budgetItem.assignedToRevision")).toBe(true);

    const stored = await db.query.budgetItems.findFirst({ where: eq(budgetItems.id, budgetItemId) });
    expect(stored?.budgetRevisionId).toBe(revisionId);
  });

  it("rejects assigning a budget item that belongs to a different project", async () => {
    const projectId = await createProject();
    const otherProjectId = await createProject();
    const itemRes = await request(app)
      .post(`/api/projects/${otherProjectId}/budget/items`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ category: "Materials", plannedAmount: 1000 });

    const revRes = await request(app)
      .post(`/api/projects/${projectId}/budget-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({});

    const assignRes = await request(app)
      .post(`/api/projects/${projectId}/budget-revisions/${revRes.body.id}/items/${itemRes.body.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({});
    expect(assignRes.status).toBe(404);
  });

  it("approve is one-way: further item assignment and re-approval are rejected once approved", async () => {
    const projectId = await createProject();
    const revRes = await request(app)
      .post(`/api/projects/${projectId}/budget-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({});
    const revisionId = revRes.body.id as string;

    const approveRes = await request(app)
      .post(`/api/projects/${projectId}/budget-revisions/${revisionId}/approve`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.status).toBe("approved");

    const reapprove = await request(app)
      .post(`/api/projects/${projectId}/budget-revisions/${revisionId}/approve`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(reapprove.status).toBe(409);

    const itemRes = await request(app)
      .post(`/api/projects/${projectId}/budget/items`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ category: "Materials", plannedAmount: 1000 });
    const assignAfterApprove = await request(app)
      .post(`/api/projects/${projectId}/budget-revisions/${revisionId}/items/${itemRes.body.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({});
    expect(assignAfterApprove.status).toBe(409);
  });

  // Same dynamic-concurrency discipline as the BOQ publish test above and
  // tests/concurrency.test.ts: two simultaneous approvals of the SAME draft
  // revision must never both succeed.
  it("concurrent approve attempts on the same revision: exactly one succeeds", async () => {
    const projectId = await createProject();
    const revRes = await request(app)
      .post(`/api/projects/${projectId}/budget-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({});
    const revisionId = revRes.body.id as string;

    const approve = () =>
      request(app)
        .post(`/api/projects/${projectId}/budget-revisions/${revisionId}/approve`)
        .set("Authorization", `Bearer ${ownerToken}`);

    const [r1, r2] = await Promise.all([approve(), approve()]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);
  });

  it("a member cannot create or approve a budget revision", async () => {
    const projectId = await createProject();
    const createRes = await request(app)
      .post(`/api/projects/${projectId}/budget-revisions`)
      .set("Authorization", `Bearer ${memberToken}`)
      .send({});
    expect(createRes.status).toBe(403);
  });
});
