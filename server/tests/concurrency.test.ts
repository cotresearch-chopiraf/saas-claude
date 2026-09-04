import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { resetDb } from "./setup.js";

vi.mock("../src/lib/mailer.js", () => ({ sendMail: vi.fn() }));
import { sendMail } from "../src/lib/mailer.js";

const app = buildApp();

function extractToken(mailBody: string): string {
  const match = mailBody.match(/token=([a-f0-9]{64})/);
  if (!match) throw new Error(`no token found in mail body: ${mailBody}`);
  return match[1];
}

// These tests are deliberately run multiple times each: a race that doesn't
// reproduce on one trial is not proof it can't happen (this is the same
// distinction the original audit drew between a reproduced lost update and
// a "safe in N=1 trial" result) — repeating the trial raises confidence that
// the fix is a real guarantee, not a coincidence of timing.
//
// One owner account is registered ONCE for the whole change-order section
// (register is rate-limited, and a real user only registers once) and
// reused across every trial; each trial creates its own fresh
// project/change-order so trials don't interfere with each other.
let ownerToken: string;

describe("concurrency: change-order approval never loses or double-applies a budget delta", () => {
  beforeAll(async () => {
    await resetDb();
    const res = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "Race Co", name: "Owner", email: "race-owner@test.com", password: "password123" });
    ownerToken = res.body.token;
  });

  const TRIALS = 5;

  it(`${TRIALS}x: N simultaneous approvals of the SAME change order apply the delta exactly once`, async () => {
    for (let trial = 0; trial < TRIALS; trial++) {
      const projectRes = await request(app)
        .post("/api/projects")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ name: `Race Project ${trial}`, budgetTotal: 10000 });
      const coRes = await request(app)
        .post(`/api/projects/${projectRes.body.id}/change-orders`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ title: "Race CO", amountDelta: 1000 });

      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          request(app)
            .patch(`/api/projects/${projectRes.body.id}/change-orders/${coRes.body.id}`)
            .set("Authorization", `Bearer ${ownerToken}`)
            .send({ status: "approved" }),
        ),
      );
      const successes = results.filter((r) => r.status === 200);
      const conflicts = results.filter((r) => r.status === 409);
      expect(successes.length).toBe(1);
      expect(conflicts.length).toBe(7);

      const project = await request(app).get(`/api/projects/${projectRes.body.id}`).set("Authorization", `Bearer ${ownerToken}`);
      expect(Number(project.body.budgetTotal)).toBe(11000);
    }
  });

  it(`${TRIALS}x: two DIFFERENT change orders on the same project, approved concurrently, both apply — no lost update`, async () => {
    for (let trial = 0; trial < TRIALS; trial++) {
      const projectRes = await request(app)
        .post("/api/projects")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ name: `Race Project 2-${trial}`, budgetTotal: 5000 });
      const coX = await request(app)
        .post(`/api/projects/${projectRes.body.id}/change-orders`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ title: "CO X", amountDelta: 200 });
      const coY = await request(app)
        .post(`/api/projects/${projectRes.body.id}/change-orders`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ title: "CO Y", amountDelta: 300 });

      const [rx, ry] = await Promise.all([
        request(app)
          .patch(`/api/projects/${projectRes.body.id}/change-orders/${coX.body.id}`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .send({ status: "approved" }),
        request(app)
          .patch(`/api/projects/${projectRes.body.id}/change-orders/${coY.body.id}`)
          .set("Authorization", `Bearer ${ownerToken}`)
          .send({ status: "approved" }),
      ]);
      expect(rx.status).toBe(200);
      expect(ry.status).toBe(200);

      const project = await request(app).get(`/api/projects/${projectRes.body.id}`).set("Authorization", `Bearer ${ownerToken}`);
      // Before the fix this reproducibly landed on 5200 or 5300 (one delta
      // silently overwritten by the other's read-modify-write).
      expect(Number(project.body.budgetTotal)).toBe(5500);
    }
  });

  it("concurrent approvals on two DIFFERENT projects do not interfere with each other", async () => {
    const p1 = await request(app).post("/api/projects").set("Authorization", `Bearer ${ownerToken}`).send({ name: "MP1", budgetTotal: 1000 });
    const p2 = await request(app).post("/api/projects").set("Authorization", `Bearer ${ownerToken}`).send({ name: "MP2", budgetTotal: 2000 });
    const co1 = await request(app)
      .post(`/api/projects/${p1.body.id}/change-orders`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ title: "C1", amountDelta: 100 });
    const co2 = await request(app)
      .post(`/api/projects/${p2.body.id}/change-orders`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ title: "C2", amountDelta: 200 });

    const [r1, r2] = await Promise.all([
      request(app)
        .patch(`/api/projects/${p1.body.id}/change-orders/${co1.body.id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ status: "approved" }),
      request(app)
        .patch(`/api/projects/${p2.body.id}/change-orders/${co2.body.id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ status: "approved" }),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    const proj1 = await request(app).get(`/api/projects/${p1.body.id}`).set("Authorization", `Bearer ${ownerToken}`);
    const proj2 = await request(app).get(`/api/projects/${p2.body.id}`).set("Authorization", `Bearer ${ownerToken}`);
    expect(Number(proj1.body.budgetTotal)).toBe(1100);
    expect(Number(proj2.body.budgetTotal)).toBe(2200);
  });

  it("approve+reject fired simultaneously: exactly one decision wins, budget reflects only that decision", async () => {
    const projectRes = await request(app)
      .post("/api/projects")
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ name: "Race Project 3", budgetTotal: 1000 });
    const coRes = await request(app)
      .post(`/api/projects/${projectRes.body.id}/change-orders`)
      .set("Authorization", `Bearer ${ownerToken}`)
      .send({ title: "Approve or reject", amountDelta: 400 });

    const [approve, reject] = await Promise.all([
      request(app)
        .patch(`/api/projects/${projectRes.body.id}/change-orders/${coRes.body.id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ status: "approved" }),
      request(app)
        .patch(`/api/projects/${projectRes.body.id}/change-orders/${coRes.body.id}`)
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ status: "rejected" }),
    ]);
    const outcomes = [approve.status, reject.status].sort();
    expect(outcomes).toEqual([200, 409]);

    const project = await request(app).get(`/api/projects/${projectRes.body.id}`).set("Authorization", `Bearer ${ownerToken}`);
    const finalCo = await request(app)
      .get(`/api/projects/${projectRes.body.id}/change-orders`)
      .set("Authorization", `Bearer ${ownerToken}`);
    const decided = finalCo.body.find((c: { id: string }) => c.id === coRes.body.id);

    if (decided.status === "approved") {
      expect(Number(project.body.budgetTotal)).toBe(1400);
    } else {
      expect(Number(project.body.budgetTotal)).toBe(1000);
    }
  });
});

describe("concurrency: password-reset token remains single-use under concurrent requests", () => {
  const email = "pwrace-owner@test.com";

  beforeAll(async () => {
    await request(app)
      .post("/api/auth/register")
      .send({ companyName: "PW Race Co", name: "Owner", email, password: "originalPassword123" });
  });

  it("2x: two simultaneous reset-password calls with the same token — exactly one succeeds", async () => {
    for (let trial = 0; trial < 2; trial++) {
      (sendMail as ReturnType<typeof vi.fn>).mockClear();
      await request(app).post("/api/auth/request-password-reset").send({ email });
      const mailCall = (sendMail as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
      const token = extractToken(mailCall[2] as string);

      const [r1, r2] = await Promise.all([
        request(app).post("/api/auth/reset-password").send({ token, newPassword: `firstPassword${trial}23` }),
        request(app).post("/api/auth/reset-password").send({ token, newPassword: `secondPassword${trial}56` }),
      ]);
      const successes = [r1, r2].filter((r) => r.status === 200);
      const rejections = [r1, r2].filter((r) => r.status === 400);
      expect(successes.length).toBe(1);
      expect(rejections.length).toBe(1);
    }
  });
});

// AC-04 — accept-invite previously did a plain SELECT-then-INSERT: two
// concurrent requests for the same invite token could both pass the
// "not yet accepted" check and both attempt to insert a user with the
// invite's email, crashing the loser on the users.email unique constraint
// (raw 500) instead of a clean conflict. Fixed with the same conditional
// -UPDATE atomic-claim pattern used elsewhere (invoice mark-paid, quote
// accept/reject, ZATCA submission claim).
describe("concurrency: accept-invite never creates more than one user for the same invite", () => {
  let ownerToken: string;

  beforeAll(async () => {
    const res = await request(app)
      .post("/api/auth/register")
      .send({ companyName: "Invite Race Co", name: "Owner", email: "invite-race-owner@test.com", password: "password123" });
    ownerToken = res.body.token;
  });

  it("2x: N simultaneous accept-invite calls with the same token — exactly one creates a user", async () => {
    for (let trial = 0; trial < 2; trial++) {
      const inviteEmail = `invite-race-${trial}@test.com`;
      (sendMail as ReturnType<typeof vi.fn>).mockClear();
      await request(app)
        .post("/api/company/invites")
        .set("Authorization", `Bearer ${ownerToken}`)
        .send({ email: inviteEmail, role: "member" });
      const mailCall = (sendMail as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
      const token = extractToken(mailCall[2] as string);

      const results = await Promise.all(
        Array.from({ length: 4 }, (_, i) =>
          request(app)
            .post("/api/auth/accept-invite")
            .send({ token, name: `Racer ${i}`, password: "racerPassword123" }),
        ),
      );
      const successes = results.filter((r) => r.status === 201);
      const conflicts = results.filter((r) => r.status === 409);
      // Every one of the 4 concurrent requests must resolve to exactly one
      // of these two outcomes — never a 5xx crash, never something else.
      expect(successes.length + conflicts.length).toBe(4);
      expect(successes.length).toBe(1);

      const usersRes = await request(app)
        .post("/api/auth/login")
        .send({ email: inviteEmail, password: "racerPassword123" });
      expect(usersRes.status).toBe(200);
    }
  });
});
