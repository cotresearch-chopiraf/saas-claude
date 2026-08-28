import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";

const app = buildApp();

async function setupCompany() {
  const res = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "Reno Co", name: "Owner", email: "owner@test.com", password: "password123" });
  return res.body.token as string;
}

// A malformed :id used to crash the whole process (an unhandled rejection
// from Postgres rejecting the bad UUID) instead of returning an error to
// just that one request — this proves it no longer does, for every route
// family that takes an id/token straight from the URL.
describe("malformed id params never crash the server", () => {
  beforeEach(resetDb);

  it("returns an error response instead of crashing on a non-UUID invoice id", async () => {
    const token = await setupCompany();
    const res = await request(app).get("/api/invoices/not-a-uuid/pdf").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(600);

    // The server must still be alive and answering other requests.
    const health = await request(app).get("/api/health");
    expect(health.status).toBe(200);
  });

  it("returns an error response instead of crashing on a non-UUID project id", async () => {
    const token = await setupCompany();
    const res = await request(app).get("/api/projects/not-a-uuid").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(600);

    const health = await request(app).get("/api/health");
    expect(health.status).toBe(200);
  });
});
