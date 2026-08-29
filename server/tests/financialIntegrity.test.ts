import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { auditEvents } from "../src/db/schema.js";

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

// One owner account for this whole file (register is rate-limited), reused
// across every test; each test creates its own fresh projects/items.
let ownerToken: string;

beforeAll(async () => {
  await resetDb();
  const res = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Integrity Co", name: "Owner", email: uniqueEmail("integrity"), password: "password123" });
  expect(res.status).toBe(201);
  ownerToken = res.body.token;
});

async function createProject() {
  const res = await request(app)
    .post("/api/projects")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ name: `Integrity Project ${Math.random()}`, budgetTotal: 50000 });
  return res.body.id as string;
}

async function createBudgetItem(projectId: string) {
  const res = await request(app)
    .post(`/api/projects/${projectId}/budget/items`)
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ category: "Materials", plannedAmount: 1000 });
  return res.body.id as string;
}

describe("Financial integrity invariants", () => {
  describe("expense ownership — expense.budgetItemId must belong to the same project", () => {
    it("rejects an expense referencing a budget item from a DIFFERENT project", async () => {
      const projectA = await createProject();
      const projectB = await createProject();
      const budgetItemInB = await createBudgetItem(projectB);

      const res = await request(app)
        .post(`/api/projects/${projectA}/budget/expenses`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ description: "Cross-project leak attempt", amount: 500, expenseDate: "2026-01-01", budgetItemId: budgetItemInB });

      expect(res.status).toBe(404);
    });

    it("accepts an expense referencing a budget item from the SAME project", async () => {
      const projectId = await createProject();
      const budgetItemId = await createBudgetItem(projectId);

      const res = await request(app)
        .post(`/api/projects/${projectId}/budget/expenses`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ description: "Legit expense", amount: 500, expenseDate: "2026-01-01", budgetItemId });

      expect(res.status).toBe(201);
      expect(res.body.budgetItemId).toBe(budgetItemId);
    });

    it("a cross-project budgetItemId never corrupts the target project's spent total", async () => {
      const projectA = await createProject();
      const projectB = await createProject();
      const budgetItemInB = await createBudgetItem(projectB);

      await request(app)
        .post(`/api/projects/${projectA}/budget/expenses`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ description: "Should not land anywhere", amount: 999, expenseDate: "2026-01-01", budgetItemId: budgetItemInB });

      const budgetB = await request(app)
        .get(`/api/projects/${projectB}/budget`)
        .set("Authorization", `Bearer ${ownerToken}`);
      expect(budgetB.body.totals.spent).toBe(0);
    });
  });

  describe("BOQ item relationships must be internally consistent", () => {
    async function setupContractAndRevision() {
      const projectId = await createProject();
      const contractRes = await request(app)
        .post(`/api/projects/${projectId}/contracts`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ originalValue: 10000 });
      const revRes = await request(app)
        .post(`/api/projects/${projectId}/boq-revisions`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ contractId: contractRes.body.id });
      return { projectId, contractId: contractRes.body.id, revisionId: revRes.body.id as string };
    }

    it("rejects a parentItemId that belongs to a different BOQ revision", async () => {
      const { projectId, revisionId } = await setupContractAndRevision();
      const other = await setupContractAndRevision();

      const foreignParent = await request(app)
        .post(`/api/projects/${other.projectId}/boq-revisions/${other.revisionId}/items`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ description: "Parent in other revision", itemType: "section" });
      expect(foreignParent.status).toBe(201);

      const res = await request(app)
        .post(`/api/projects/${projectId}/boq-revisions/${revisionId}/items`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ description: "Child pointing at wrong parent", parentItemId: foreignParent.body.id });

      expect(res.status).toBe(404);
    });

    it("rejects a costCodeId that belongs to a different company", async () => {
      const { projectId, revisionId } = await setupContractAndRevision();

      const otherCompanyRes = await request(app)
        .post("/api/auth/register")
        .send({ companyName: "Rival Co", name: "Owner", email: uniqueEmail("rival"), password: "password123" });
      const foreignCostCode = await request(app)
        .post("/api/cost-codes")
        .set("Authorization", `Bearer ${otherCompanyRes.body.token}`)
        .send({ code: "RIVAL-1", name: "Rival's own code" });

      const res = await request(app)
        .post(`/api/projects/${projectId}/boq-revisions/${revisionId}/items`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ description: "Item with foreign cost code", costCodeId: foreignCostCode.body.id });

      expect(res.status).toBe(404);
    });

    it("accepts a parentItemId/costCodeId that genuinely belong to this revision/company", async () => {
      const { projectId, revisionId } = await setupContractAndRevision();
      const costCodeRes = await request(app)
        .post("/api/cost-codes")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ code: `CC-VALID-${Date.now()}`, name: "Valid code" });
      const section = await request(app)
        .post(`/api/projects/${projectId}/boq-revisions/${revisionId}/items`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ description: "Section", itemType: "section" });

      const res = await request(app)
        .post(`/api/projects/${projectId}/boq-revisions/${revisionId}/items`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ description: "Valid child item", parentItemId: section.body.id, costCodeId: costCodeRes.body.id });

      expect(res.status).toBe(201);
    });
  });

  describe("audit history is append-only", () => {
    it("two sequential updates to the same contract produce two distinct audit rows, never overwriting one another", async () => {
      const projectId = await createProject();
      const contractRes = await request(app)
        .post(`/api/projects/${projectId}/contracts`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ originalValue: 10000 });
      const contractId = contractRes.body.id as string;

      await request(app)
        .patch(`/api/projects/${projectId}/contracts/${contractId}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ revisedValue: 11000 });
      await request(app)
        .patch(`/api/projects/${projectId}/contracts/${contractId}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ revisedValue: 12000 });

      const events = await db.query.auditEvents.findMany({
        where: eq(auditEvents.entityId, contractId),
        orderBy: (e, { asc }) => [asc(e.createdAt)],
      });
      const updateEvents = events.filter((e) => e.action === "contract.updated");
      expect(updateEvents).toHaveLength(2);
      expect((updateEvents[0].afterValue as { revisedValue: string }).revisedValue).toBe("11000.00");
      expect((updateEvents[1].beforeValue as { revisedValue: string }).revisedValue).toBe("11000.00");
      expect((updateEvents[1].afterValue as { revisedValue: string }).revisedValue).toBe("12000.00");
    });
  });

  describe("project and tenant ownership are enforced on every mutation, not just reads", () => {
    it("rejects creating a budget item under a nonexistent/foreign projectId", async () => {
      const res = await request(app)
        .post(`/api/projects/00000000-0000-0000-0000-000000000000/budget/items`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ category: "Ghost", plannedAmount: 100 });
      expect(res.status).toBe(404);
    });

    it("rejects creating an expense under a nonexistent/foreign projectId", async () => {
      const res = await request(app)
        .post(`/api/projects/00000000-0000-0000-0000-000000000000/budget/expenses`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ description: "Ghost expense", amount: 100, expenseDate: "2026-01-01" });
      expect(res.status).toBe(404);
    });
  });
});
