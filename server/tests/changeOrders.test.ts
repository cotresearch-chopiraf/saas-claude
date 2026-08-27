import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";

const app = buildApp();

async function setupProject() {
  const registerRes = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Reno Co", name: "Owner", email: "owner@test.com", password: "password123" });
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
