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

describe("quote lifecycle", () => {
  beforeEach(resetDb);

  it("a draft quote is not visible on its public link", async () => {
    const token = await setupCompany();
    const quote = await request(app)
      .post("/api/quotes")
      .set("Authorization", `Bearer ${token}`)
      .send({ clientName: "Client", projectName: "Bath remodel", items: [{ description: "Tile", amount: 100 }] });

    const publicView = await request(app).get(`/api/public/quotes/${quote.body.publicToken}`);
    expect(publicView.status).toBe(404);
  });

  it("sending a quote makes it publicly visible and acceptable, once", async () => {
    const token = await setupCompany();
    const quote = await request(app)
      .post("/api/quotes")
      .set("Authorization", `Bearer ${token}`)
      .send({
        clientName: "Client",
        projectName: "Bath remodel",
        items: [{ description: "Tile", amount: 100 }, { description: "Plumbing", amount: 200 }],
      });

    await request(app).patch(`/api/quotes/${quote.body.id}/send`).set("Authorization", `Bearer ${token}`);

    const publicView = await request(app).get(`/api/public/quotes/${quote.body.publicToken}`);
    expect(publicView.status).toBe(200);
    expect(publicView.body.total).toBe(300);

    const accept = await request(app)
      .post(`/api/public/quotes/${quote.body.publicToken}/accept`)
      .send({ acceptedByName: "Real Client" });
    expect(accept.status).toBe(200);
    expect(accept.body.status).toBe("accepted");

    const secondAccept = await request(app)
      .post(`/api/public/quotes/${quote.body.publicToken}/accept`)
      .send({ acceptedByName: "Real Client" });
    expect(secondAccept.status).toBe(409);
  });
});
