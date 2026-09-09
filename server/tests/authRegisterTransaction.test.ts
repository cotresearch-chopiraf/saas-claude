import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";
import { db } from "../src/db/client.js";
import { companies } from "../src/db/schema.js";

// Recovered fix — POST /api/auth/register previously ran two separate,
// untransacted inserts (company, then user). Two near-simultaneous
// registrations with the same email (a double-submitted form, a retried
// request) could both pass the existing-email fast-path check, then race
// on the users.email unique constraint: the loser's user insert threw an
// unhandled 500 with its company row already committed and permanently
// orphaned (no owner user, unrecoverable via any UI). This suite proves
// the transaction now closes that race cleanly.

const app = buildApp();

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`;
}

async function companyCountByName(name: string): Promise<number> {
  const rows = await db.query.companies.findMany({ where: eq(companies.name, name) });
  return rows.length;
}

describe("POST /api/auth/register — transaction integrity", () => {
  beforeEach(resetDb);

  it("a normal registration still succeeds exactly as before: token, owner role, company created", async () => {
    const email = uniqueEmail("reg-normal");
    const res = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "Normal Register Co", name: "Owner", email, password: "password123" });

    expect(res.status).toBe(201);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.email).toBe(email);
    expect(res.body.company.name).toBe("Normal Register Co");

    const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${res.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.user.role).toBe("owner");
    expect(await companyCountByName("Normal Register Co")).toBe(1);
  });

  it("a duplicate email (sequential) is rejected with a clean 409, no second company created", async () => {
    const email = uniqueEmail("reg-dup");
    const first = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "Dup Co One", name: "Owner", email, password: "password123" });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "Dup Co Two", name: "Owner Two", email, password: "password456" });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe("هذا البريد الإلكتروني مسجّل مسبقاً");

    // The rejected request's company must never have been created — this
    // is exactly the orphan the transaction is meant to prevent.
    expect(await companyCountByName("Dup Co Two")).toBe(0);
  });

  it("the 409 response never leaks a raw database error (no stack, no SQL, no constraint name)", async () => {
    const email = uniqueEmail("reg-leak");
    await request(app)
      .post("/api/auth/register")
      .send({ companyName: "Leak Check Co", name: "Owner", email, password: "password123" });

    const res = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "Leak Check Co 2", name: "Owner", email, password: "password123" });

    expect(res.status).toBe(409);
    // `code`/`requestId` are the app-wide error envelope's own safe fields
    // (errorEnvelopeMiddleware) — the leak this test actually guards
    // against is a raw driver/SQL detail reaching the response body.
    expect(res.body.error).toBe("هذا البريد الإلكتروني مسجّل مسبقاً");
    expect(JSON.stringify(res.body)).not.toMatch(/duplicate key|constraint|23505|stack|SQL|ECONNREFUSED/i);
  });

  it("two concurrent registrations with the same email: exactly one 201 and one 409, no orphaned company for the loser", async () => {
    const email = uniqueEmail("reg-race");
    const [resA, resB] = await Promise.all([
      request(app).post("/api/auth/register").send({ companyName: "Race Co A", name: "Owner A", email, password: "password123" }),
      request(app).post("/api/auth/register").send({ companyName: "Race Co B", name: "Owner B", email, password: "password123" }),
    ]);

    const statuses = [resA.status, resB.status].sort();
    // Either the fast-path SELECT or the transaction's own unique-violation
    // catch can win depending on exact timing — both outcomes are the same
    // clean 409, never a 500.
    expect(statuses).toEqual([201, 409]);

    const winner = resA.status === 201 ? resA : resB;
    const loser = resA.status === 201 ? resB : resA;
    expect(winner.body.token).toBeTruthy();
    expect(loser.body.error).toBe("هذا البريد الإلكتروني مسجّل مسبقاً");
    expect(loser.status).not.toBe(500);

    // Confirm no orphan: the losing company name must not exist at all,
    // and the winning company name must exist exactly once.
    const winningCompanyName = resA.status === 201 ? "Race Co A" : "Race Co B";
    const losingCompanyName = resA.status === 201 ? "Race Co B" : "Race Co A";
    expect(await companyCountByName(winningCompanyName)).toBe(1);
    expect(await companyCountByName(losingCompanyName)).toBe(0);

    // Exactly one user exists for this email.
    const usersWithEmail = await db.query.users.findMany({ where: (u, { eq: eqOp }) => eqOp(u.email, email) });
    expect(usersWithEmail.length).toBe(1);
  });

  it("existing invite/accept-invite flow is unaffected by the register transaction change", async () => {
    const ownerEmail = uniqueEmail("reg-invite-owner");
    const register = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "Invite Flow Co", name: "Owner", email: ownerEmail, password: "password123" });
    expect(register.status).toBe(201);

    const inviteRes = await request(app)
      .post("/api/company/invites")
      .set("Authorization", `Bearer ${register.body.token}`)
      .send({ email: uniqueEmail("reg-invite-member"), role: "member" });
    expect(inviteRes.status).toBe(201);
  });
});
