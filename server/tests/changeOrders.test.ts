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
