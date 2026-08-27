import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";

const app = buildApp();

async function registerCompany(name: string, email: string) {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ companyName: name, name: "Test User", email, password: "password123" });
  return res.body.token as string;
}

describe("multi-tenant isolation", () => {
  beforeEach(resetDb);

  it("a company cannot read another company's project", async () => {
    const tokenA = await registerCompany("Company A", "a@test.com");
    const tokenB = await registerCompany("Company B", "b@test.com");

    const createRes = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ name: "A's secret project" });
    const projectId = createRes.body.id;

    const asOwner = await request(app)
      .get(`/api/projects/${projectId}`)
      .set("Authorization", `Bearer ${tokenA}`);
    expect(asOwner.status).toBe(200);

    const asOutsider = await request(app)
      .get(`/api/projects/${projectId}`)
      .set("Authorization", `Bearer ${tokenB}`);
    expect(asOutsider.status).toBe(404);
  });

  it("a company's project list never includes another company's projects", async () => {
    const tokenA = await registerCompany("Company A", "a2@test.com");
    const tokenB = await registerCompany("Company B", "b2@test.com");

    await request(app).post("/api/projects").set("Authorization", `Bearer ${tokenA}`).send({ name: "A project" });
    await request(app).post("/api/projects").set("Authorization", `Bearer ${tokenB}`).send({ name: "B project" });

    const listA = await request(app).get("/api/projects").set("Authorization", `Bearer ${tokenA}`);
    expect(listA.body).toHaveLength(1);
    expect(listA.body[0].name).toBe("A project");
  });

  it("rejects requests with no token", async () => {
    const res = await request(app).get("/api/projects");
    expect(res.status).toBe(401);
  });
});
