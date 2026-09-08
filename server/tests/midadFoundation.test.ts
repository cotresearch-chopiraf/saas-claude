import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { auditEvents, boqItems, boqRevisions, budgetItems, budgetRevisions } from "../src/db/schema.js";

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

function patchContractStatus(projectId: string, contractId: string, status: string, token = ownerToken) {
  return request(app)
    .patch(`/api/projects/${projectId}/contracts/${contractId}`)
    .set("Authorization", `Bearer ${token}`)
    .send({ status });
}

// Walks a freshly-created (always "draft") contract to the given status via
// the only valid path (draft -> active -> completed/terminated) — used by
// tests below that need to exercise a *downstream* rule (BOQ/IPC/Measurement
// gating) against a contract already in a terminal state, without each test
// re-deriving the walk.
async function advanceContractTo(projectId: string, contractId: string, target: "active" | "completed" | "terminated") {
  await patchContractStatus(projectId, contractId, "active");
  if (target !== "active") await patchContractStatus(projectId, contractId, target);
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

  // Concurrency Hardening: the MAX+1 subquery alone is not race-safe — two
  // concurrent INSERTs can each read the same prior MAX before either
  // commits. This is the exact class of bug empirically proven (and fixed)
  // for IPC numbering in Phase 2C; see docs/MIDAD_CONCURRENCY_HARDENING.md.
  it("5x: concurrent BOQ revision creation on the same contract never collides on revision_number", async () => {
    const { projectId, contractId } = await createContractForProject();

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app)
          .post(`/api/projects/${projectId}/boq-revisions`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .send({ contractId }),
      ),
    );
    for (const r of results) expect(r.status).toBe(201);

    const numbers = results.map((r) => r.body.revision_number).sort((a, b) => a - b);
    expect(new Set(numbers).size).toBe(5); // count(numbers) == count(unique(numbers))
    expect(numbers).toEqual([1, 2, 3, 4, 5]); // contiguous from the existing MAX (0) + 1
  });

  // Cross-scope proof: the parent-row lock must serialize the correct
  // scope (per contract) — it must not serialize the whole table. Two
  // DIFFERENT contracts creating revisions concurrently must each get
  // their own independent, correct 1..N sequence.
  it("independent contracts are not serialized against each other, and each keeps its own correct sequence", async () => {
    const projectId = await createProject();
    const contractA = await createContract(projectId);
    const contractB = await createContract(projectId);

    const results = await Promise.all([
      request(app).post(`/api/projects/${projectId}/boq-revisions`).set("Authorization", `Bearer ${ownerToken}`).send({ contractId: contractA.id }),
      request(app).post(`/api/projects/${projectId}/boq-revisions`).set("Authorization", `Bearer ${ownerToken}`).send({ contractId: contractB.id }),
      request(app).post(`/api/projects/${projectId}/boq-revisions`).set("Authorization", `Bearer ${ownerToken}`).send({ contractId: contractA.id }),
      request(app).post(`/api/projects/${projectId}/boq-revisions`).set("Authorization", `Bearer ${ownerToken}`).send({ contractId: contractB.id }),
    ]);
    for (const r of results) expect(r.status).toBe(201);

    const numbersA = results.filter((_, i) => i === 0 || i === 2).map((r) => r.body.revision_number).sort();
    const numbersB = results.filter((_, i) => i === 1 || i === 3).map((r) => r.body.revision_number).sort();
    expect(numbersA).toEqual([1, 2]);
    expect(numbersB).toEqual([1, 2]);
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
    // Hardening 3: the first-ever publish for a contract has nothing to
    // supersede.
    expect(publishRes.body.supersedesRevisionId).toBeNull();

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

    // Hardening 3: the new revision records WHICH specific revision it
    // replaced, not just inferable from status + timing.
    expect(publish2.body.supersedesRevisionId).toBe(rev1.body.id);
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

  it("a member cannot create a revision", async () => {
    const { projectId, contractId } = await createContractForProject();
    const createRes = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions`)
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ contractId });
    expect(createRes.status).toBe(403);
  });

  it("a member cannot add an item to an existing (owner-created) draft revision", async () => {
    const { projectId, contractId } = await createContractForProject();
    const revRes = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId });
    expect(revRes.status).toBe(201);

    const addItemRes = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions/${revRes.body.id}/items`)
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ description: "Member attempt", quantity: 1, rate: 1 });
    expect(addItemRes.status).toBe(403);

    const items = await db.query.boqItems.findMany({ where: eq(boqItems.boqRevisionId, revRes.body.id) });
    expect(items).toHaveLength(0);
  });

  it("a member cannot publish an existing (owner-created) draft revision", async () => {
    const { projectId, contractId } = await createContractForProject();
    const revRes = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId });
    expect(revRes.status).toBe(201);

    const publishRes = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions/${revRes.body.id}/publish`)
      .set("Authorization", `Bearer ${memberToken}`);
    expect(publishRes.status).toBe(403);

    const stillDraft = await db.query.boqRevisions.findFirst({ where: eq(boqRevisions.id, revRes.body.id) });
    expect(stillDraft?.status).toBe("draft");
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

  // Concurrency Hardening: same class of MAX+1 race as BOQ revisions above
  // — see docs/MIDAD_CONCURRENCY_HARDENING.md.
  it("5x: concurrent budget revision creation on the same project never collides on revision_number", async () => {
    const projectId = await createProject();

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        request(app)
          .post(`/api/projects/${projectId}/budget-revisions`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .send({ reason: "concurrent" }),
      ),
    );
    for (const r of results) expect(r.status).toBe(201);

    const numbers = results.map((r) => r.body.revision_number).sort((a, b) => a - b);
    expect(new Set(numbers).size).toBe(5);
    expect(numbers).toEqual([1, 2, 3, 4, 5]);
  });

  // Cross-scope proof: two DIFFERENT projects must not be serialized
  // against each other, and each keeps its own correct sequence.
  it("independent projects are not serialized against each other, and each keeps its own correct sequence", async () => {
    const projectA = await createProject();
    const projectB = await createProject();

    const results = await Promise.all([
      request(app).post(`/api/projects/${projectA}/budget-revisions`).set("Authorization", `Bearer ${ownerToken}`).send({}),
      request(app).post(`/api/projects/${projectB}/budget-revisions`).set("Authorization", `Bearer ${ownerToken}`).send({}),
      request(app).post(`/api/projects/${projectA}/budget-revisions`).set("Authorization", `Bearer ${ownerToken}`).send({}),
      request(app).post(`/api/projects/${projectB}/budget-revisions`).set("Authorization", `Bearer ${ownerToken}`).send({}),
    ]);
    for (const r of results) expect(r.status).toBe(201);

    const numbersA = results.filter((_, i) => i === 0 || i === 2).map((r) => r.body.revision_number).sort();
    const numbersB = results.filter((_, i) => i === 1 || i === 3).map((r) => r.body.revision_number).sort();
    expect(numbersA).toEqual([1, 2]);
    expect(numbersB).toEqual([1, 2]);
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

  it("a member cannot create a budget revision", async () => {
    const projectId = await createProject();
    const createRes = await request(app)
      .post(`/api/projects/${projectId}/budget-revisions`)
      .set("Authorization", `Bearer ${memberToken}`)
      .send({});
    expect(createRes.status).toBe(403);
  });

  it("a member cannot approve an existing (owner-created) draft budget revision", async () => {
    const projectId = await createProject();
    const revRes = await request(app)
      .post(`/api/projects/${projectId}/budget-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({});
    expect(revRes.status).toBe(201);

    const approveRes = await request(app)
      .post(`/api/projects/${projectId}/budget-revisions/${revRes.body.id}/approve`)
      .set("Authorization", `Bearer ${memberToken}`);
    expect(approveRes.status).toBe(403);

    const stillDraft = await db.query.budgetRevisions.findFirst({ where: eq(budgetRevisions.id, revRes.body.id) });
    expect(stillDraft?.status).toBe("draft");
  });
});

describe("MIDAD Phase 3.2 remediation — Contract status lifecycle (CTR-001)", () => {
  it("valid transitions: draft -> active -> completed", async () => {
    const projectId = await createProject();
    const contract = await createContract(projectId);

    const toActive = await patchContractStatus(projectId, contract.id, "active");
    expect(toActive.status).toBe(200);
    expect(toActive.body.status).toBe("active");

    const toCompleted = await patchContractStatus(projectId, contract.id, "completed");
    expect(toCompleted.status).toBe(200);
    expect(toCompleted.body.status).toBe("completed");
  });

  it("valid transition: active -> terminated", async () => {
    const projectId = await createProject();
    const contract = await createContract(projectId);
    await patchContractStatus(projectId, contract.id, "active");

    const toTerminated = await patchContractStatus(projectId, contract.id, "terminated");
    expect(toTerminated.status).toBe(200);
    expect(toTerminated.body.status).toBe("terminated");
  });

  it("re-sending the current status is a no-op, not a rejected transition", async () => {
    const projectId = await createProject();
    const contract = await createContract(projectId);
    const res = await patchContractStatus(projectId, contract.id, "draft");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("draft");
  });

  it("PATCHing non-status fields alongside an unrelated field never triggers the transition check", async () => {
    const projectId = await createProject();
    const contract = await createContract(projectId);
    const res = await request(app)
      .patch(`/api/projects/${projectId}/contracts/${contract.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ clientName: "New Client" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("draft");
  });

  const invalidTransitions: Array<["draft" | "active" | "completed" | "terminated", "active" | "completed" | "terminated"]> = [
    ["terminated", "active"],
    ["completed", "active"],
    ["terminated", "completed"],
    ["completed", "terminated"],
    ["draft", "completed"],
    ["draft", "terminated"],
  ];

  for (const [from, to] of invalidTransitions) {
    it(`invalid transition ${from} -> ${to} is rejected with 409, not a generic 500`, async () => {
      const projectId = await createProject();
      const contract = await createContract(projectId);
      if (from !== "draft") await advanceContractTo(projectId, contract.id, from);

      const res = await patchContractStatus(projectId, contract.id, to);
      expect(res.status).toBe(409);
      expect(res.body.error).toBeTruthy();

      // The rejected transition must not have partially applied.
      const readBack = await request(app)
        .get(`/api/projects/${projectId}/contracts/${contract.id}`)
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(readBack.body.status).toBe(from);
    });
  }

  it("a member cannot change contract status", async () => {
    const projectId = await createProject();
    const contract = await createContract(projectId);
    const res = await patchContractStatus(projectId, contract.id, "active", memberToken);
    expect(res.status).toBe(403);
  });
});

describe("MIDAD Phase 3.2 remediation — contract status downstream execution gating (CTR-001)", () => {
  it("a completed contract cannot receive a new BOQ revision", async () => {
    const projectId = await createProject();
    const contract = await createContract(projectId);
    await advanceContractTo(projectId, contract.id, "completed");

    const res = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId: contract.id });
    expect(res.status).toBe(409);
  });

  it("a terminated contract cannot receive a new BOQ revision", async () => {
    const projectId = await createProject();
    const contract = await createContract(projectId);
    await advanceContractTo(projectId, contract.id, "terminated");

    const res = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId: contract.id });
    expect(res.status).toBe(409);
  });

  it("a draft contract can still receive a new BOQ revision (draft is not blocked — matches every existing fixture)", async () => {
    const projectId = await createProject();
    const contract = await createContract(projectId);
    const res = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId: contract.id });
    expect(res.status).toBe(201);
  });

  it("publishing a BOQ revision is rejected once its contract becomes terminated after the draft was created", async () => {
    const projectId = await createProject();
    const contract = await createContract(projectId);
    const revRes = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId: contract.id });
    expect(revRes.status).toBe(201);

    await advanceContractTo(projectId, contract.id, "terminated");

    const publishRes = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions/${revRes.body.id}/publish`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(publishRes.status).toBe(409);

    const stillDraft = await db.query.boqRevisions.findFirst({ where: eq(boqRevisions.id, revRes.body.id) });
    expect(stillDraft?.status).toBe("draft");
  });

  it("a terminated contract cannot receive a new IPC", async () => {
    const projectId = await createProject();
    const contract = await createContract(projectId);
    await advanceContractTo(projectId, contract.id, "terminated");

    const res = await request(app)
      .post(`/api/projects/${projectId}/ipcs`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        contractId: contract.id,
        boqRevisionId: "00000000-0000-0000-0000-000000000000",
        periodStart: "2025-01-01",
        periodEnd: "2025-01-31",
      });
    expect(res.status).toBe(409);
  });

  it("a completed contract cannot receive a new Measurement", async () => {
    const projectId = await createProject();
    const contract = await createContract(projectId);
    await advanceContractTo(projectId, contract.id, "completed");

    const res = await request(app)
      .post(`/api/projects/${projectId}/measurements`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        contractId: contract.id,
        boqRevisionId: "00000000-0000-0000-0000-000000000000",
        measurementDate: "2025-01-15",
      });
    expect(res.status).toBe(409);
  });

  it("read access to a terminated contract and its BOQ revisions remains open (historical reporting is never blocked)", async () => {
    const projectId = await createProject();
    const contract = await createContract(projectId);
    const revRes = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId: contract.id });

    await advanceContractTo(projectId, contract.id, "terminated");

    const contractRead = await request(app)
      .get(`/api/projects/${projectId}/contracts/${contract.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(contractRead.status).toBe(200);
    expect(contractRead.body.status).toBe("terminated");

    const listRead = await request(app)
      .get(`/api/projects/${projectId}/contracts`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(listRead.status).toBe(200);

    const revisionRead = await request(app)
      .get(`/api/projects/${projectId}/boq-revisions/${revRes.body.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(revisionRead.status).toBe(200);
  });
});

describe("MIDAD Phase 3.2 remediation — Budget Revision supersession (BUD-001)", () => {
  it("approving a second revision supersedes the first; exactly one is current", async () => {
    const projectId = await createProject();

    const revA = await request(app)
      .post(`/api/projects/${projectId}/budget-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({});
    const revB = await request(app)
      .post(`/api/projects/${projectId}/budget-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({});

    const approveA = await request(app)
      .post(`/api/projects/${projectId}/budget-revisions/${revA.body.id}/approve`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(approveA.status).toBe(200);
    expect(approveA.body.status).toBe("approved");

    const approveB = await request(app)
      .post(`/api/projects/${projectId}/budget-revisions/${revB.body.id}/approve`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(approveB.status).toBe(200);
    expect(approveB.body.status).toBe("approved");

    const list = await request(app)
      .get(`/api/projects/${projectId}/budget-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`);
    const byId = Object.fromEntries(
      (list.body as Array<{ id: string; status: string }>).map((r) => [r.id, r.status]),
    );
    expect(byId[revA.body.id]).toBe("superseded");
    expect(byId[revB.body.id]).toBe("approved");
    expect(Object.values(byId).filter((s) => s === "approved")).toHaveLength(1);
  });

  it("the superseded revision remains individually readable (historical access is never blocked)", async () => {
    const projectId = await createProject();
    const revA = await request(app)
      .post(`/api/projects/${projectId}/budget-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({});
    const revB = await request(app)
      .post(`/api/projects/${projectId}/budget-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({});
    await request(app)
      .post(`/api/projects/${projectId}/budget-revisions/${revA.body.id}/approve`)
      .set("Authorization", `Bearer ${ownerToken}`);
    await request(app)
      .post(`/api/projects/${projectId}/budget-revisions/${revB.body.id}/approve`)
      .set("Authorization", `Bearer ${ownerToken}`);

    const read = await request(app)
      .get(`/api/projects/${projectId}/budget-revisions/${revA.body.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(read.status).toBe(200);
    expect(read.body.status).toBe("superseded");
  });

  it("supersession is audited on the newly-approved revision's own event, referencing the superseded id", async () => {
    const projectId = await createProject();
    const revA = await request(app)
      .post(`/api/projects/${projectId}/budget-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({});
    const revB = await request(app)
      .post(`/api/projects/${projectId}/budget-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({});
    await request(app)
      .post(`/api/projects/${projectId}/budget-revisions/${revA.body.id}/approve`)
      .set("Authorization", `Bearer ${ownerToken}`);
    await request(app)
      .post(`/api/projects/${projectId}/budget-revisions/${revB.body.id}/approve`)
      .set("Authorization", `Bearer ${ownerToken}`);

    const events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, revB.body.id) });
    const approvedEvent = events.find((e) => e.action === "budgetRevision.approved");
    expect(approvedEvent).toBeTruthy();
    expect((approvedEvent!.metadata as { supersededRevisionIds?: string[] } | null)?.supersededRevisionIds).toEqual([
      revA.body.id,
    ]);
  });

  it("5x: concurrent approval of two DIFFERENT draft revisions for the same project never leaves more than one approved", async () => {
    const TRIALS = 5;
    for (let i = 0; i < TRIALS; i++) {
      const projectId = await createProject();
      const revA = await request(app)
        .post(`/api/projects/${projectId}/budget-revisions`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({});
      const revB = await request(app)
        .post(`/api/projects/${projectId}/budget-revisions`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({});

      const approve = (id: string) =>
        request(app)
          .post(`/api/projects/${projectId}/budget-revisions/${id}/approve`)
          .set("Authorization", `Bearer ${ownerToken}`);

      // Both requests target DIFFERENT draft rows, so both are individually
      // valid and both succeed — the "at most one current" invariant is
      // enforced by supersession (which one ends up "approved" afterward),
      // not by rejecting one of the two calls.
      const [r1, r2] = await Promise.all([approve(revA.body.id), approve(revB.body.id)]);
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);

      const list = await request(app)
        .get(`/api/projects/${projectId}/budget-revisions`)
        .set("Authorization", `Bearer ${ownerToken}`);
      const statuses = (list.body as Array<{ status: string }>).map((r) => r.status);
      expect(statuses.filter((s) => s === "approved")).toHaveLength(1);
      expect(statuses.filter((s) => s === "superseded")).toHaveLength(1);
    }
  });

  it("a member cannot trigger approval/supersession", async () => {
    const projectId = await createProject();
    const revA = await request(app)
      .post(`/api/projects/${projectId}/budget-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({});
    const res = await request(app)
      .post(`/api/projects/${projectId}/budget-revisions/${revA.body.id}/approve`)
      .set("Authorization", `Bearer ${memberToken}`);
    expect(res.status).toBe(403);
  });
});

describe("MIDAD Phase 3.2 remediation — database uniqueness backstop (DB-001)", () => {
  it("a duplicate (project_id, revision_number) pair is rejected at the database level even bypassing the application lock", async () => {
    const projectId = await createProject();
    const revA = await request(app)
      .post(`/api/projects/${projectId}/budget-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({});
    expect(revA.status).toBe(201);

    // Bypasses routes/budgetRevisions.ts's own locking discipline entirely
    // (a raw duplicate insert, not the app's INSERT...SELECT MAX+1) — this
    // is exactly the failure mode the unique index is a backstop for: some
    // future or out-of-band code path that forgets the lock.
    await expect(
      db.execute(sql`
        INSERT INTO budget_revisions (company_id, project_id, revision_number, status, created_by)
        SELECT company_id, project_id, revision_number, status, created_by
        FROM budget_revisions WHERE id = ${revA.body.id}
      `),
    ).rejects.toThrow();
  });
});

describe("MIDAD Phase 3.2 hardening — QTY-001: BOQ item quantity normalization", () => {
  async function createContractForProject() {
    const projectId = await createProject();
    const contract = await createContract(projectId);
    return { projectId, contractId: contract.id };
  }

  it("a quantity with more than 3 decimal places is normalized to 3dp before both storage and amount calculation", async () => {
    const { projectId, contractId } = await createContractForProject();
    const revRes = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId });

    const itemRes = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions/${revRes.body.id}/items`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ description: "Excavation", quantity: 1.23456, rate: 10 });
    expect(itemRes.status).toBe(201);
    expect(Number(itemRes.body.quantity)).toBe(1.235);
    expect(Number(itemRes.body.amount)).toBe(12.35); // 1.235 * 10, not 1.23456 * 10
  });

  it("a quantity already within 3dp precision is unchanged", async () => {
    const { projectId, contractId } = await createContractForProject();
    const revRes = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId });

    const itemRes = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions/${revRes.body.id}/items`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ description: "Excavation", quantity: 1.234, rate: 10 });
    expect(itemRes.status).toBe(201);
    expect(Number(itemRes.body.quantity)).toBe(1.234);
  });

  it("a whole-number quantity is unchanged", async () => {
    const { projectId, contractId } = await createContractForProject();
    const revRes = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId });

    const itemRes = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions/${revRes.body.id}/items`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ description: "Excavation", quantity: 5, rate: 10 });
    expect(itemRes.status).toBe(201);
    expect(Number(itemRes.body.quantity)).toBe(5);
  });
});

describe("MIDAD Phase 3.2 hardening — VAL-001: finite numeric validation", () => {
  async function createContractForProject() {
    const projectId = await createProject();
    const contract = await createContract(projectId);
    return { projectId, contractId: contract.id };
  }

  it('the string "Infinity" for a BOQ item quantity is rejected with 400, not a 500', async () => {
    const { projectId, contractId } = await createContractForProject();
    const revRes = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId });

    const res = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions/${revRes.body.id}/items`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ description: "Excavation", quantity: "Infinity", rate: 10 });
    expect(res.status).toBe(400);
  });

  it('the string "-Infinity" for a BOQ item rate is rejected with 400', async () => {
    const { projectId, contractId } = await createContractForProject();
    const revRes = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId });

    const res = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions/${revRes.body.id}/items`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ description: "Excavation", quantity: 10, rate: "-Infinity" });
    expect(res.status).toBe(400);
  });

  it('the string "Infinity" for contract originalValue is rejected with 400 at creation', async () => {
    const projectId = await createProject();
    const res = await request(app)
      .post(`/api/projects/${projectId}/contracts`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ originalValue: "Infinity" });
    expect(res.status).toBe(400);
  });

  it('the string "NaN" for contract revisedValue is rejected with 400 on update', async () => {
    const projectId = await createProject();
    const contract = await createContract(projectId);
    const res = await request(app)
      .patch(`/api/projects/${projectId}/contracts/${contract.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ revisedValue: "NaN" });
    expect(res.status).toBe(400);
  });

  it("normal valid numeric values still work for both BOQ items and contracts", async () => {
    const { projectId, contractId } = await createContractForProject();
    const revRes = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId });

    const itemRes = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions/${revRes.body.id}/items`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ description: "Excavation", quantity: 10, rate: 5 });
    expect(itemRes.status).toBe(201);
  });
});

describe("MIDAD Phase 3.2 hardening — INFO-001: BOQ item audit events", () => {
  async function createContractForProject() {
    const projectId = await createProject();
    const contract = await createContract(projectId);
    return { projectId, contractId: contract.id };
  }

  it("creating a BOQ item creates the expected persistent audit event", async () => {
    const { projectId, contractId } = await createContractForProject();
    const revRes = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId });

    const itemRes = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions/${revRes.body.id}/items`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ description: "Excavation", quantity: 10, rate: 5 });
    expect(itemRes.status).toBe(201);

    const event = await db.query.auditEvents.findFirst({
      where: eq(auditEvents.entityId, itemRes.body.id),
    });
    expect(event).toBeTruthy();
    expect(event!.action).toBe("boqItem.added");
    expect(event!.entityType).toBe("boq_item");
    const metadata = event!.metadata as { boqRevisionId?: string; contractId?: string; projectId?: string };
    expect(metadata.boqRevisionId).toBe(revRes.body.id);
    expect(metadata.contractId).toBe(contractId);
    expect(metadata.projectId).toBe(projectId);
  });

  it("deleting a BOQ item creates the expected persistent audit event", async () => {
    const { projectId, contractId } = await createContractForProject();
    const revRes = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId });
    const itemRes = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions/${revRes.body.id}/items`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ description: "Excavation", quantity: 10, rate: 5 });

    const deleteRes = await request(app)
      .delete(`/api/projects/${projectId}/boq-revisions/${revRes.body.id}/items/${itemRes.body.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(deleteRes.status).toBe(204);

    const events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, itemRes.body.id) });
    const removedEvent = events.find((e) => e.action === "boqItem.removed");
    expect(removedEvent).toBeTruthy();
    expect(removedEvent!.entityType).toBe("boq_item");
    const before = removedEvent!.beforeValue as { id: string; description: string };
    expect(before.id).toBe(itemRes.body.id);
    expect(before.description).toBe("Excavation");
  });

  it("a failed add (published revision) does not leave a boqItem.added audit event", async () => {
    const { projectId, contractId } = await createContractForProject();
    const revRes = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId });
    await request(app)
      .post(`/api/projects/${projectId}/boq-revisions/${revRes.body.id}/publish`)
      .set("Authorization", `Bearer ${ownerToken}`);

    const before = await db.query.auditEvents.findMany({ where: eq(auditEvents.action, "boqItem.added") });

    const failedAdd = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions/${revRes.body.id}/items`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ description: "Too late", quantity: 1, rate: 1 });
    expect(failedAdd.status).toBe(409);

    const after = await db.query.auditEvents.findMany({ where: eq(auditEvents.action, "boqItem.added") });
    expect(after.length).toBe(before.length);
  });

  it("a failed delete (published revision) does not leave a boqItem.removed audit event", async () => {
    const { projectId, contractId } = await createContractForProject();
    const revRes = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId });
    const itemRes = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions/${revRes.body.id}/items`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ description: "Excavation", quantity: 10, rate: 5 });
    await request(app)
      .post(`/api/projects/${projectId}/boq-revisions/${revRes.body.id}/publish`)
      .set("Authorization", `Bearer ${ownerToken}`);

    const failedDelete = await request(app)
      .delete(`/api/projects/${projectId}/boq-revisions/${revRes.body.id}/items/${itemRes.body.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(failedDelete.status).toBe(409);

    const events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, itemRes.body.id) });
    expect(events.some((e) => e.action === "boqItem.removed")).toBe(false);
  });

  it("BOQ item audit events remain inaccessible across tenants", async () => {
    const { projectId, contractId } = await createContractForProject();
    const revRes = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ contractId });
    const itemRes = await request(app)
      .post(`/api/projects/${projectId}/boq-revisions/${revRes.body.id}/items`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ description: "Excavation", quantity: 10, rate: 5 });

    const ownScoped = await request(app)
      .get("/api/audit-events")
      .query({ entityType: "boq_item", limit: 100 })
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(ownScoped.body.events.some((e: { entityId: string }) => e.entityId === itemRes.body.id)).toBe(true);

    const otherScoped = await request(app)
      .get("/api/audit-events")
      .query({ entityType: "boq_item", limit: 100 })
      .set("Authorization", `Bearer ${companyBToken}`);
    expect(otherScoped.body.events.some((e: { entityId: string }) => e.entityId === itemRes.body.id)).toBe(false);
  });
});
