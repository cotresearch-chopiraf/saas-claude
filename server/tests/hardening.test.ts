import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { auditEvents, boqItems, boqRevisions, budgetItems, budgetRevisions } from "../src/db/schema.js";
import { listAuditEvents } from "../src/lib/audit.js";

// Phase 1.1 Hardening regression tests:
//  - Hardening 5: concurrency races closed on BOQ item add/delete vs.
//    publish, and budget-revision item-assignment vs. approve.
//  - Hardening 6: canonical audit_events rows for budget item / expense
//    mutations.
// Every concurrency assertion checks the actual database row state, not
// just HTTP response counts, per the same discipline established in
// tests/concurrency.test.ts and tests/taxEngineP0.test.ts.

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

let ownerToken: string;

beforeAll(async () => {
  await resetDb();
  const res = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Hardening Co", name: "Owner", email: uniqueEmail("hardening"), password: "password123" });
  expect(res.status).toBe(201);
  ownerToken = res.body.token;
});

async function createProject() {
  const res = await request(app)
    .post("/api/projects")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ name: `Hardening Project ${Math.random()}`, budgetTotal: 100000 });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function createContract(projectId: string) {
  const res = await request(app)
    .post(`/api/projects/${projectId}/contracts`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ originalValue: 50000 });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function createDraftBoqRevision(projectId: string, contractId: string) {
  const res = await request(app)
    .post(`/api/projects/${projectId}/boq-revisions`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ contractId });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

const TRIALS = 5;

describe("Hardening 1/5: BOQ item mutations cannot race a concurrent publish", () => {
  it(`${TRIALS}x: concurrent publish + add-item never leaves an inconsistent database state`, async () => {
    for (let trial = 0; trial < TRIALS; trial++) {
      const projectId = await createProject();
      const contractId = await createContract(projectId);
      const revisionId = await createDraftBoqRevision(projectId, contractId);

      const [publishRes, addItemRes] = await Promise.all([
        request(app)
          .post(`/api/projects/${projectId}/boq-revisions/${revisionId}/publish`)
          .set("Authorization", `Bearer ${ownerToken}`),
        request(app)
          .post(`/api/projects/${projectId}/boq-revisions/${revisionId}/items`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .send({ description: "Race item", quantity: 1, rate: 1 }),
      ]);

      // publish is the only mutator of this revision's status in this
      // test, so it must always eventually succeed regardless of ordering
      // against the item insert.
      expect(publishRes.status).toBe(200);
      expect([201, 409]).toContain(addItemRes.status);

      const revisionRow = await db.query.boqRevisions.findFirst({ where: eq(boqRevisions.id, revisionId) });
      expect(revisionRow?.status).toBe("published");

      // The core invariant: the database state must exactly agree with
      // what the add-item response claimed — never "published revision +
      // an item inserted after publication was not reflected in either
      // response or database."
      const itemsInDb = await db.query.boqItems.findMany({ where: eq(boqItems.boqRevisionId, revisionId) });
      if (addItemRes.status === 201) {
        expect(itemsInDb).toHaveLength(1);
      } else {
        expect(itemsInDb).toHaveLength(0);
      }
    }
  });

  it(`${TRIALS}x: concurrent publish + delete-item never leaves an inconsistent database state`, async () => {
    for (let trial = 0; trial < TRIALS; trial++) {
      const projectId = await createProject();
      const contractId = await createContract(projectId);
      const revisionId = await createDraftBoqRevision(projectId, contractId);

      // Add the item BEFORE the race, while the revision is safely still
      // draft — the race is only about the delete attempt.
      const itemRes = await request(app)
        .post(`/api/projects/${projectId}/boq-revisions/${revisionId}/items`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ description: "Pre-existing item", quantity: 2, rate: 5 });
      expect(itemRes.status).toBe(201);

      const [publishRes, deleteRes] = await Promise.all([
        request(app)
          .post(`/api/projects/${projectId}/boq-revisions/${revisionId}/publish`)
          .set("Authorization", `Bearer ${ownerToken}`),
        request(app)
          .delete(`/api/projects/${projectId}/boq-revisions/${revisionId}/items/${itemRes.body.id}`)
          .set("Authorization", `Bearer ${ownerToken}`),
      ]);

      expect(publishRes.status).toBe(200);
      expect([204, 409]).toContain(deleteRes.status);

      const revisionRow = await db.query.boqRevisions.findFirst({ where: eq(boqRevisions.id, revisionId) });
      expect(revisionRow?.status).toBe("published");

      const itemsInDb = await db.query.boqItems.findMany({ where: eq(boqItems.boqRevisionId, revisionId) });
      if (deleteRes.status === 204) {
        expect(itemsInDb).toHaveLength(0);
      } else {
        expect(itemsInDb).toHaveLength(1);
      }
    }
  });
});

describe("Hardening 1/5: budget-item assignment cannot race a concurrent budget-revision approve", () => {
  it(`${TRIALS}x: concurrent approve + item-assignment never leaves an inconsistent database state`, async () => {
    for (let trial = 0; trial < TRIALS; trial++) {
      const projectId = await createProject();
      const itemRes = await request(app)
        .post(`/api/projects/${projectId}/budget/items`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ category: "Race Materials", plannedAmount: 1000 });
      expect(itemRes.status).toBe(201);

      const revRes = await request(app)
        .post(`/api/projects/${projectId}/budget-revisions`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({});
      expect(revRes.status).toBe(201);
      const revisionId = revRes.body.id as string;

      const [approveRes, assignRes] = await Promise.all([
        request(app)
          .post(`/api/projects/${projectId}/budget-revisions/${revisionId}/approve`)
          .set("Authorization", `Bearer ${ownerToken}`),
        request(app)
          .post(`/api/projects/${projectId}/budget-revisions/${revisionId}/items/${itemRes.body.id}`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .send({}),
      ]);

      expect(approveRes.status).toBe(200);
      expect([200, 409]).toContain(assignRes.status);

      const revisionRow = await db.query.budgetRevisions.findFirst({ where: eq(budgetRevisions.id, revisionId) });
      expect(revisionRow?.status).toBe("approved");

      const itemRow = await db.query.budgetItems.findFirst({ where: eq(budgetItems.id, itemRes.body.id) });
      if (assignRes.status === 200) {
        expect(itemRow?.budgetRevisionId).toBe(revisionId);
      } else {
        // Rejected — the item must NOT have been silently attached to a
        // revision that is (or became) approved.
        expect(itemRow?.budgetRevisionId).not.toBe(revisionId);
      }
    }
  });
});

describe("Hardening 6: budget item mutations produce canonical audit_events rows", () => {
  it("create records a budgetItem.created event with company/project/actor and the after state", async () => {
    const projectId = await createProject();
    const res = await request(app)
      .post(`/api/projects/${projectId}/budget/items`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ category: "Audited Materials", plannedAmount: 2500 });
    expect(res.status).toBe(201);

    const events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, res.body.id) });
    const created = events.find((e) => e.action === "budgetItem.created");
    expect(created).toBeTruthy();
    expect(created!.entityType).toBe("budget_item");
    expect((created!.metadata as { projectId: string }).projectId).toBe(projectId);
    expect(created!.afterValue).toBeTruthy();
    expect((created!.afterValue as { category: string }).category).toBe("Audited Materials");
    expect(created!.beforeValue).toBeNull();
  });

  it("update records a budgetItem.updated event with correct before/after", async () => {
    const projectId = await createProject();
    const createRes = await request(app)
      .post(`/api/projects/${projectId}/budget/items`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ category: "Original", plannedAmount: 1000 });

    const updateRes = await request(app)
      .patch(`/api/projects/${projectId}/budget/items/${createRes.body.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ plannedAmount: 1500 });
    expect(updateRes.status).toBe(200);

    const events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, createRes.body.id) });
    const updated = events.find((e) => e.action === "budgetItem.updated");
    expect(updated).toBeTruthy();
    expect((updated!.beforeValue as { plannedAmount: string }).plannedAmount).toBe("1000.00");
    expect((updated!.afterValue as { plannedAmount: string }).plannedAmount).toBe("1500.00");
  });

  it("delete records a budgetItem.deleted event carrying the row's before state", async () => {
    const projectId = await createProject();
    const createRes = await request(app)
      .post(`/api/projects/${projectId}/budget/items`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ category: "To Delete", plannedAmount: 300 });

    const deleteRes = await request(app)
      .delete(`/api/projects/${projectId}/budget/items/${createRes.body.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(deleteRes.status).toBe(204);

    const events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, createRes.body.id) });
    const deleted = events.find((e) => e.action === "budgetItem.deleted");
    expect(deleted).toBeTruthy();
    expect((deleted!.beforeValue as { category: string }).category).toBe("To Delete");
    expect(deleted!.afterValue).toBeNull();
  });
});

describe("Hardening 6: expense mutations produce canonical audit_events rows", () => {
  it("create records an expense.created event", async () => {
    const projectId = await createProject();
    const res = await request(app)
      .post(`/api/projects/${projectId}/budget/expenses`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ description: "Site materials", amount: 400, expenseDate: "2026-01-15" });
    expect(res.status).toBe(201);

    const events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, res.body.id) });
    const created = events.find((e) => e.action === "expense.created");
    expect(created).toBeTruthy();
    expect(created!.entityType).toBe("expense");
    expect((created!.metadata as { projectId: string }).projectId).toBe(projectId);
    expect((created!.afterValue as { description: string }).description).toBe("Site materials");
  });

  it("delete records an expense.deleted event carrying the row's before state", async () => {
    const projectId = await createProject();
    const createRes = await request(app)
      .post(`/api/projects/${projectId}/budget/expenses`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ description: "To delete", amount: 200, expenseDate: "2026-01-16" });

    const deleteRes = await request(app)
      .delete(`/api/projects/${projectId}/budget/expenses/${createRes.body.id}`)
      .set("Authorization", `Bearer ${ownerToken}`);
    expect(deleteRes.status).toBe(204);

    const events = await db.query.auditEvents.findMany({ where: eq(auditEvents.entityId, createRes.body.id) });
    const deleted = events.find((e) => e.action === "expense.deleted");
    expect(deleted).toBeTruthy();
    expect((deleted!.beforeValue as { description: string }).description).toBe("To delete");
  });

  it("tenant isolation: a company's audit events for its budget/expense mutations are not visible to another company", async () => {
    const otherRes = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "Hardening Rival Co", name: "Owner", email: uniqueEmail("hardening-rival"), password: "password123" });
    expect(otherRes.status).toBe(201);
    const otherCompanyId = otherRes.body.company.id as string;
    const otherToken = otherRes.body.token as string;

    const projectId = await createProject();
    const itemRes = await request(app)
      .post(`/api/projects/${projectId}/budget/items`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ category: "Isolated", plannedAmount: 700 });
    expect(itemRes.status).toBe(201);

    // listAuditEvents is always scoped by companyId (the same helper every
    // domain's audit read path uses, e.g. routes/compliance.ts's /history).
    // Querying with the OWNING company's id finds the event...
    const eventRow = await db.query.auditEvents.findFirst({ where: eq(auditEvents.entityId, itemRes.body.id) });
    expect(eventRow).toBeTruthy();
    const ownerCompanyId = eventRow!.companyId;

    const ownerScoped = await listAuditEvents(ownerCompanyId, { entityType: "budget_item" });
    expect(ownerScoped.some((e) => e.entityId === itemRes.body.id)).toBe(true);

    // ...but querying the SAME entityType scoped to a DIFFERENT company
    // never returns it.
    const otherScoped = await listAuditEvents(otherCompanyId, { entityType: "budget_item" });
    expect(otherScoped.some((e) => e.entityId === itemRes.body.id)).toBe(false);

    // The other company also cannot reach the underlying budget item at
    // all (pre-existing tenant scoping, confirmed still intact here).
    const otherProjectBudget = await request(app)
      .get(`/api/projects/${projectId}/budget`)
      .set("Authorization", `Bearer ${otherToken}`);
    expect(otherProjectBudget.status).toBe(404);
  });
});
