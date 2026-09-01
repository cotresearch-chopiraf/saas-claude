import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";

// MIDAD ZATCA Slice 5 — concurrency safety for the /prepare route's atomic
// ICV claim + PIH advance + submission insert. Real parallel HTTP requests
// against a real Postgres, not simulated — this is exactly the class of
// bug that only shows up under genuine concurrent load.

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

let companyA: string;
let tokenA: string;

beforeAll(async () => {
  await resetDb();
  const res = await request(app)
    .post("/api/auth/register")
    .send({ companyName: "ZATCA Concurrency Co", name: "Owner", email: uniqueEmail("zatca-concurrency"), password: "password123" });
  companyA = res.body.company.id;
  tokenA = res.body.token;
  await request(app)
    .patch("/api/zatca/config")
    .set("Authorization", `Bearer ${tokenA}`)
    .send({ vatNumber: "300000000000003", commercialRegistration: "1010101010" });
});

async function createInvoice(): Promise<string> {
  const res = await request(app)
    .post("/api/invoices")
    .set("Authorization", `Bearer ${tokenA}`)
    .send({ clientName: "Concurrency Test Client", items: [{ description: "Work", amount: 100 }] });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

async function createEgsUnit(): Promise<string> {
  const res = await request(app)
    .post("/api/zatca/egs-units")
    .set("Authorization", `Bearer ${tokenA}`)
    .send({ name: "Concurrency Unit", environment: "simulation" });
  expect(res.status).toBe(201);
  return res.body.id as string;
}

describe("prepare concurrency", () => {
  it("N concurrent prepares for N different invoices on the same EGS unit produce a contiguous, gap-free, duplicate-free ICV sequence and a valid PIH chain", async () => {
    const egsUnitId = await createEgsUnit();
    const invoiceIds = await Promise.all(Array.from({ length: 6 }, () => createInvoice()));

    const results = await Promise.all(
      invoiceIds.map((invoiceId) =>
        request(app)
          .post(`/api/zatca/egs-units/${egsUnitId}/invoices/${invoiceId}/prepare`)
          .set("Authorization", `Bearer ${tokenA}`),
      ),
    );

    for (const r of results) expect(r.status).toBe(201);

    const icvs = results.map((r) => r.body.submission.icv as number).sort((a, b) => a - b);
    expect(new Set(icvs).size).toBe(icvs.length); // no duplicates
    expect(icvs).toEqual(Array.from({ length: icvs.length }, (_, i) => i + 1)); // contiguous, no gaps

    // PIH chain integrity: ordered by ICV, each pih must equal the
    // previous submission's documentHash (or GENESIS for the first).
    const listRes = await request(app).get(`/api/zatca/egs-units/${egsUnitId}/submissions`).set("Authorization", `Bearer ${tokenA}`);
    const ordered = [...listRes.body].sort((a, b) => a.icv - b.icv);
    for (let i = 1; i < ordered.length; i++) {
      expect(ordered[i].pih).toBe(ordered[i - 1].documentHash);
    }
  });

  it("N concurrent prepare calls for the SAME invoice+EGS never create more than one submission row", async () => {
    const egsUnitId = await createEgsUnit();
    const invoiceId = await createInvoice();

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        request(app)
          .post(`/api/zatca/egs-units/${egsUnitId}/invoices/${invoiceId}/prepare`)
          .set("Authorization", `Bearer ${tokenA}`),
      ),
    );

    for (const r of results) expect([200, 201]).toContain(r.status);
    const submissionIds = new Set(results.map((r) => r.body.submission.id));
    expect(submissionIds.size).toBe(1);

    // The winning ICV was claimed exactly once -- no counter waste from
    // the losing concurrent attempts.
    const icvs = new Set(results.map((r) => r.body.submission.icv));
    expect(icvs.size).toBe(1);
  });
});
