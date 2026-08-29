import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { budgetItems, contracts } from "../src/db/schema.js";

// Regression tests for the Phase 2 architectural-unblock task: closing the
// unguarded, unaudited projects.budgetTotal write path in
// PATCH /api/projects/:id. See docs/MIDAD_FINANCIAL_MODEL.md for why
// budgetTotal is legacy/non-authoritative and why this route no longer
// accepts it at all, for any role — the "Preferred" full-removal option
// was chosen (not the transitional owner-only fallback), since discovery
// confirmed no client code and no existing test ever relied on this route
// accepting budgetTotal.

vi.mock("../src/lib/mailer.js", () => ({ sendMail: vi.fn() }));
import { sendMail } from "../src/lib/mailer.js";

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

let ownerToken: string;
let memberToken: string;

beforeAll(async () => {
  await resetDb();

  const ownerRes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "SoT Co", name: "Owner", email: uniqueEmail("sot-owner"), password: "password123" });
  expect(ownerRes.status).toBe(201);
  ownerToken = ownerRes.body.token;

  const inviteRes = await request(app)
    .post("/api/company/invites")
    .set("Authorization", `Bearer ${ownerToken}`)
    .send({ email: uniqueEmail("sot-member"), role: "member" });
  expect(inviteRes.status).toBe(201);
  const mailCall = (sendMail as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
  const inviteToken = (mailCall[2] as string).match(/token=([a-f0-9]{64})/)![1];
  const acceptRes = await request(app)
    .post("/api/auth/accept-invite")
    .send({ token: inviteToken, name: "Member", password: "memberpass123" });
  expect(acceptRes.status).toBe(201);
  memberToken = acceptRes.body.token;
});

async function createProject(token: string, budgetTotal = 10000) {
  const res = await request(app)
    .post("/api/projects")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: `SoT Project ${Math.random()}`, budgetTotal });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

describe("Test A: a member cannot mutate projects.budgetTotal through the normal update endpoint", () => {
  it("sending budgetTotal in a PATCH body never changes the stored value", async () => {
    const projectId = await createProject(ownerToken, 10000);

    const res = await request(app)
      .patch(`/api/projects/${projectId}`)
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ budgetTotal: 999999 });
    // The field is silently ignored (not part of the schema) — this is not
    // a 403, because a member IS allowed to update non-financial project
    // fields; only budgetTotal specifically must never move through here.
    expect(res.status).toBe(200);
    expect(Number(res.body.budgetTotal)).toBe(10000);

    const reread = await request(app).get(`/api/projects/${projectId}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(Number(reread.body.budgetTotal)).toBe(10000);
  });
});

describe("Test B: the field is structurally removed, not merely role-gated — not even an owner can set it here", () => {
  it("an owner sending budgetTotal through PATCH /projects/:id also has it ignored", async () => {
    const projectId = await createProject(ownerToken, 5000);

    const res = await request(app)
      .patch(`/api/projects/${projectId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ budgetTotal: 777777, name: "Renamed via owner PATCH" });
    expect(res.status).toBe(200);
    expect(Number(res.body.budgetTotal)).toBe(5000);
    expect(res.body.name).toBe("Renamed via owner PATCH");
  });

  it("the only remaining writer of budgetTotal is change-order approval — still intact and unchanged", async () => {
    const projectId = await createProject(ownerToken, 2000);
    const coRes = await request(app)
      .post(`/api/projects/${projectId}/change-orders`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ title: "Still works", amountDelta: 500 });

    const decideRes = await request(app)
      .patch(`/api/projects/${projectId}/change-orders/${coRes.body.id}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ status: "approved" });
    expect(decideRes.status).toBe(200);

    const project = await request(app).get(`/api/projects/${projectId}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(Number(project.body.budgetTotal)).toBe(2500);
  });
});

describe("Test C: an attempted budgetTotal change never leaks into other financial tables", () => {
  it("budgetItems and contracts are untouched by a PATCH /projects/:id budgetTotal attempt", async () => {
    const projectId = await createProject(ownerToken, 10000);

    const itemRes = await request(app)
      .post(`/api/projects/${projectId}/budget/items`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ category: "Materials", plannedAmount: 3000 });
    const contractRes = await request(app)
      .post(`/api/projects/${projectId}/contracts`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ originalValue: 20000 });

    await request(app)
      .patch(`/api/projects/${projectId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ budgetTotal: 999999 });

    const budgetItemRow = await db.query.budgetItems.findFirst({ where: eq(budgetItems.id, itemRes.body.id) });
    expect(Number(budgetItemRow?.plannedAmount)).toBe(3000);

    const contractRow = await db.query.contracts.findFirst({ where: eq(contracts.id, contractRes.body.id) });
    expect(Number(contractRow?.originalValue)).toBe(20000);
    expect(Number(contractRow?.revisedValue)).toBe(20000);
  });
});

describe("Test D: existing project-update behavior for non-financial fields is intact", () => {
  it("name, clientName, address, startDate, and status still update normally", async () => {
    const projectId = await createProject(ownerToken, 1000);

    const res = await request(app)
      .patch(`/api/projects/${projectId}`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({
        name: "Updated Name",
        clientName: "Updated Client",
        address: "Updated Address",
        startDate: "2026-03-01",
        status: "on_hold",
      });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Updated Name");
    expect(res.body.clientName).toBe("Updated Client");
    expect(res.body.address).toBe("Updated Address");
    expect(res.body.status).toBe("on_hold");
  });

  it("a member can still update non-financial fields (no RBAC regression)", async () => {
    const projectId = await createProject(ownerToken, 1000);

    const res = await request(app)
      .patch(`/api/projects/${projectId}`)
      .set("Authorization", `Bearer ${memberToken}`)
      .send({ name: "Member Renamed" });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Member Renamed");
  });

  it("another company cannot update this project at all (tenant isolation unaffected)", async () => {
    const projectId = await createProject(ownerToken, 1000);
    const otherRes = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "SoT Rival Co", name: "Owner", email: uniqueEmail("sot-rival"), password: "password123" });

    const res = await request(app)
      .patch(`/api/projects/${projectId}`)
      .set("Authorization", `Bearer ${otherRes.body.token}`)
      .send({ name: "Should not work" });
    expect(res.status).toBe(404);
  });
});
