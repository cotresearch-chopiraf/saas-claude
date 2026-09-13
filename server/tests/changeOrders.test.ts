import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

async function setupProject(companyName = "Reno Co") {
  const registerRes = await request(app)
    .post("/api/auth/register")
    .send({ companyName, name: "Owner", email: uniqueEmail("co-owner"), password: "password123" });
  const token = registerRes.body.token as string;

  const projectRes = await request(app)
    .post("/api/projects")
    .set("Authorization", `Bearer ${token}`)
    .send({ name: "Kitchen remodel", budgetTotal: 10000 });

  return { token, projectId: projectRes.body.id as string };
}

describe("change orders adjust the project budget", () => {
  beforeEach(resetDb);

  it("approving a positive change order increases the budget", async () => {
    const { token, projectId } = await setupProject();

    const coRes = await request(app)
      .post(`/api/projects/${projectId}/change-orders`)
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Add skylight", amountDelta: 1500 });

    await request(app)
      .patch(`/api/projects/${projectId}/change-orders/${coRes.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "approved" });

    const project = await request(app).get(`/api/projects/${projectId}`).set("Authorization", `Bearer ${token}`);
    expect(Number(project.body.budgetTotal)).toBe(11500);
  });

  it("a rejected change order does not touch the budget", async () => {
    const { token, projectId } = await setupProject();

    const coRes = await request(app)
      .post(`/api/projects/${projectId}/change-orders`)
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Skip this", amountDelta: 5000 });

    await request(app)
      .patch(`/api/projects/${projectId}/change-orders/${coRes.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "rejected" });

    const project = await request(app).get(`/api/projects/${projectId}`).set("Authorization", `Bearer ${token}`);
    expect(Number(project.body.budgetTotal)).toBe(10000);
  });

  it("cannot approve the same change order twice", async () => {
    const { token, projectId } = await setupProject();

    const coRes = await request(app)
      .post(`/api/projects/${projectId}/change-orders`)
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Once only", amountDelta: 1000 });

    const first = await request(app)
      .patch(`/api/projects/${projectId}/change-orders/${coRes.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "approved" });
    expect(first.status).toBe(200);

    const second = await request(app)
      .patch(`/api/projects/${projectId}/change-orders/${coRes.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "approved" });
    expect(second.status).toBe(409);

    const project = await request(app).get(`/api/projects/${projectId}`).set("Authorization", `Bearer ${token}`);
    expect(Number(project.body.budgetTotal)).toBe(11000);
  });
});

// P0 hardening (MIDAD Final Pre-Launch audit, §4/§19) — the whole router is
// gated by a project-ownership middleware (changeOrders.ts's own
// router.use(): a foreign company's projectId never matches
// eq(projects.companyId, req.companyId!), so every route below it 404s
// uniformly. This file previously never asserted that directly.
describe("change orders: tenant isolation", () => {
  beforeEach(resetDb);

  it("a foreign company cannot list this company's change orders for a known project id", async () => {
    const { projectId } = await setupProject("Company A");
    const { token: tokenB } = await setupProject("Company B");

    const res = await request(app)
      .get(`/api/projects/${projectId}/change-orders`)
      .set("Authorization", `Bearer ${tokenB}`);
    expect(res.status).toBe(404);
  });

  it("a foreign company cannot create a change order on this company's project", async () => {
    const { projectId } = await setupProject("Company A");
    const { token: tokenB } = await setupProject("Company B");

    const res = await request(app)
      .post(`/api/projects/${projectId}/change-orders`)
      .set("Authorization", `Bearer ${tokenB}`)
      .send({ title: "Malicious injection", amountDelta: 999999 });
    expect(res.status).toBe(404);
  });

  it("a foreign company cannot approve this company's change order (and the budget is unaffected)", async () => {
    const { token: tokenA, projectId } = await setupProject("Company A");
    const { token: tokenB } = await setupProject("Company B");

    const coRes = await request(app)
      .post(`/api/projects/${projectId}/change-orders`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ title: "Owned by A", amountDelta: 2000 });

    const res = await request(app)
      .patch(`/api/projects/${projectId}/change-orders/${coRes.body.id}`)
      .set("Authorization", `Bearer ${tokenB}`)
      .send({ status: "approved" });
    expect(res.status).toBe(404);

    const project = await request(app).get(`/api/projects/${projectId}`).set("Authorization", `Bearer ${tokenA}`);
    expect(Number(project.body.budgetTotal)).toBe(10000);
  });

  it("a foreign company cannot delete this company's change order", async () => {
    const { token: tokenA, projectId } = await setupProject("Company A");
    const { token: tokenB } = await setupProject("Company B");

    const coRes = await request(app)
      .post(`/api/projects/${projectId}/change-orders`)
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ title: "Owned by A", amountDelta: 500 });

    const res = await request(app)
      .delete(`/api/projects/${projectId}/change-orders/${coRes.body.id}`)
      .set("Authorization", `Bearer ${tokenB}`);
    expect(res.status).toBe(404);

    const stillThere = await request(app)
      .get(`/api/projects/${projectId}/change-orders`)
      .set("Authorization", `Bearer ${tokenA}`);
    expect(stillThere.body.map((c: { id: string }) => c.id)).toContain(coRes.body.id);
  });
});

// P0 hardening (MIDAD Final Pre-Launch audit, §4/§19) — the "cannot decide
// twice" guard above already prevents a genuine duplicate decision; this
// closes the confusing-409-on-retry gap for a network-retry-after-timeout
// on an ALREADY-decided change order, and proves a reused key never
// collides across two different change orders.
function decideWithKey(
  projectId: string,
  changeOrderId: string,
  status: "approved" | "rejected",
  key: string,
  token: string,
) {
  return request(app)
    .patch(`/api/projects/${projectId}/change-orders/${changeOrderId}`)
    .set("Authorization", `Bearer ${token}`)
    .set("Idempotency-Key", key)
    .send({ status });
}

describe("change orders: idempotency", () => {
  beforeEach(resetDb);

  it("a retry with the same Idempotency-Key replays the original 200, not a 409", async () => {
    const { token, projectId } = await setupProject();
    const coRes = await request(app)
      .post(`/api/projects/${projectId}/change-orders`)
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Add skylight", amountDelta: 1500 });
    const key = `co-approve-${Math.random()}`;

    const first = await decideWithKey(projectId, coRes.body.id, "approved", key, token);
    expect(first.status).toBe(200);
    expect(first.body.status).toBe("approved");

    const retry = await decideWithKey(projectId, coRes.body.id, "approved", key, token);
    expect(retry.status).toBe(200);
    expect(retry.body.id).toBe(first.body.id);

    // Only one budget increment happened, not two.
    const project = await request(app).get(`/api/projects/${projectId}`).set("Authorization", `Bearer ${token}`);
    expect(Number(project.body.budgetTotal)).toBe(11500);
  });

  it("without an Idempotency-Key header, a second decision attempt still gets 409", async () => {
    const { token, projectId } = await setupProject();
    const coRes = await request(app)
      .post(`/api/projects/${projectId}/change-orders`)
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Once only", amountDelta: 1000 });

    const first = await request(app)
      .patch(`/api/projects/${projectId}/change-orders/${coRes.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "approved" });
    expect(first.status).toBe(200);

    const second = await request(app)
      .patch(`/api/projects/${projectId}/change-orders/${coRes.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "approved" });
    expect(second.status).toBe(409);
  });

  it("reusing the same key against a DIFFERENT change order is a safe conflict (different changeOrderId, so a fingerprint mismatch)", async () => {
    const { token, projectId } = await setupProject();
    const coA = await request(app)
      .post(`/api/projects/${projectId}/change-orders`)
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Order A", amountDelta: 100 });
    const coB = await request(app)
      .post(`/api/projects/${projectId}/change-orders`)
      .set("Authorization", `Bearer ${token}`)
      .send({ title: "Order B", amountDelta: 200 });
    const key = `co-shared-key-${Math.random()}`;

    const first = await decideWithKey(projectId, coA.body.id, "approved", key, token);
    expect(first.status).toBe(200);

    const second = await decideWithKey(projectId, coB.body.id, "approved", key, token);
    expect(second.status).toBe(409);

    // Change order B was never actually decided by the mismatched-key retry.
    const list = await request(app).get(`/api/projects/${projectId}/change-orders`).set("Authorization", `Bearer ${token}`);
    const orderB = list.body.find((c: { id: string }) => c.id === coB.body.id);
    expect(orderB.status).toBe("pending");
  });
});
